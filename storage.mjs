/**
 * Small filesystem helpers shared by the state stores.
 */
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Writes JSON atomically: temp file -> fsync -> rename, mode 0600.
 * A partially written file must never replace a valid one.
 */
export async function writeJsonFileAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tempFile, 'w', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempFile, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}
