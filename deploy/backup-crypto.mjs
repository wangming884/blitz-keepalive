#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('BKP1', 'ascii');
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_PREFIX_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MIN_PASSPHRASE_LENGTH = 12;
const scrypt = promisify(scryptCallback);

function usage() {
  return [
    'Usage:',
    '  node deploy/backup-crypto.mjs encrypt <input> [--output <file>] [--allow-plaintext]',
    '  node deploy/backup-crypto.mjs decrypt <input> [--output <file>]',
    '',
    'Passphrase:',
    '  BACKUP_PASSPHRASE       Passphrase value from the environment.',
    '  BACKUP_PASSPHRASE_FILE  File containing the passphrase (recommended).',
    '  --passphrase-file FILE  Overrides BACKUP_PASSPHRASE_FILE for this command.',
    '',
    'Encryption removes the plaintext input by default. Use --allow-plaintext only',
    'when another trusted encryption layer will immediately protect the archive.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !['encrypt', 'decrypt'].includes(command)) {
    throw new Error(usage());
  }

  const options = {
    command,
    inputPath: null,
    outputPath: null,
    passphraseFile: null,
    allowPlaintext: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--output' || argument === '--passphrase-file') {
      const value = rest[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      if (argument === '--output') options.outputPath = value;
      else options.passphraseFile = value;
      index += 1;
      continue;
    }
    if (argument === '--allow-plaintext') {
      if (command !== 'encrypt') throw new Error('--allow-plaintext is only valid for encrypt.');
      options.allowPlaintext = true;
      continue;
    }
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown argument: ${argument}`);
    if (options.inputPath) throw new Error(`Unexpected argument: ${argument}`);
    options.inputPath = argument;
  }

  return options;
}

async function resolvePassphrase({ passphraseFile } = {}) {
  // Backup settings are optional for the application and validated only when this command runs.
  const envValue = process.env.BACKUP_PASSPHRASE ?? '';
  const envFile = process.env.BACKUP_PASSPHRASE_FILE ?? '';
  if (passphraseFile && envValue) {
    throw new Error('Use either BACKUP_PASSPHRASE or a passphrase file, not both.');
  }

  let value = envValue;
  const file = passphraseFile || envFile;
  if (file) {
    value = await readFile(path.resolve(file), 'utf8');
    value = value.replace(/\r?\n$/, '');
  }
  if (!value) throw new Error('Set BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE.');
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  return value;
}

async function assertInputFile(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Backup input is not a regular file: ${file}`);
  if (info.size > MAX_BACKUP_BYTES) {
    throw new Error(`Backup input exceeds the ${MAX_BACKUP_BYTES} byte limit: ${file}`);
  }
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(file, body) {
  const resolved = path.resolve(file);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  if (await pathExists(resolved)) throw new Error(`Output already exists: ${resolved}`);

  const temporary = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, resolved);
    await chmod(resolved, 0o600).catch(() => {});
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function deriveKey(passphrase, salt) {
  return Buffer.from(
    await scrypt(passphrase, salt, KEY_BYTES, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }),
  );
}

export function inspectBackupHeader(body) {
  if (!Buffer.isBuffer(body) || body.length < HEADER_PREFIX_BYTES + TAG_BYTES) {
    throw new Error('Encrypted backup is truncated.');
  }
  if (!body.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted backup has an invalid magic header.');
  }
  const version = body[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Encrypted backup version ${version} is not supported (expected ${FORMAT_VERSION}).`,
    );
  }
  return { version };
}

export async function encryptFile({
  inputPath,
  outputPath = `${inputPath}.enc`,
  passphrase,
  removePlaintext = true,
}) {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedInput === resolvedOutput) throw new Error('Input and output paths must differ.');
  await assertInputFile(resolvedInput);
  const plaintext = await readFile(resolvedInput);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const headerPrefix = Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION]),
    salt,
    iv,
  ]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(headerPrefix);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticatedHeader = Buffer.concat([headerPrefix, cipher.getAuthTag()]);
  await writeAtomic(resolvedOutput, Buffer.concat([authenticatedHeader, ciphertext]));
  if (removePlaintext) await unlink(resolvedInput);
  return { outputPath: resolvedOutput, removedPlaintext: removePlaintext };
}

export async function decryptFile({ inputPath, outputPath, passphrase }) {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(
    outputPath || (resolvedInput.endsWith('.enc') ? resolvedInput.slice(0, -4) : `${resolvedInput}.dec`),
  );
  if (resolvedInput === resolvedOutput) throw new Error('Input and output paths must differ.');
  await assertInputFile(resolvedInput);
  const body = await readFile(resolvedInput);
  inspectBackupHeader(body);

  const saltStart = MAGIC.length + 1;
  const ivStart = saltStart + SALT_BYTES;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const headerPrefix = body.subarray(0, HEADER_PREFIX_BYTES);
  const salt = body.subarray(saltStart, ivStart);
  const iv = body.subarray(ivStart, tagStart);
  const authTag = body.subarray(tagStart, ciphertextStart);
  const ciphertext = body.subarray(ciphertextStart);
  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(headerPrefix);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Backup authentication failed: wrong passphrase or modified file.');
  }
  await writeAtomic(resolvedOutput, plaintext);
  return { outputPath: resolvedOutput };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.inputPath) throw new Error('An input file is required.');
  const passphrase = await resolvePassphrase(options);

  if (options.command === 'encrypt') {
    const result = await encryptFile({
      inputPath: options.inputPath,
      outputPath: options.outputPath || `${options.inputPath}.enc`,
      passphrase,
      removePlaintext: !options.allowPlaintext,
    });
    console.log(`Encrypted backup: ${result.outputPath}`);
    if (result.removedPlaintext) console.log('Plaintext archive removed.');
    else console.log('Plaintext archive retained because --allow-plaintext was supplied.');
    return;
  }

  const result = await decryptFile({
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    passphrase,
  });
  console.log(`Decrypted backup: ${result.outputPath}`);
}

const directEntry =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (directEntry) {
  main().catch((error) => {
    console.error(`backup-crypto: ${error.message}`);
    process.exitCode = 1;
  });
}
