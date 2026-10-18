#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: restore-drill.sh [--backup-dir PATH] [--passphrase-file PATH]

Decrypts the newest blitz-keepalive-backup-*.tar.gz.enc archive into a
temporary directory, validates the restored data files, and removes the
temporary directory. It never writes into the live data directory.
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_dir="${PWD}/backups"
passphrase_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      backup_dir="$2"
      shift 2
      ;;
    --passphrase-file)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      passphrase_file="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -d "$backup_dir" ]] || { printf 'Backup directory does not exist: %s\n' "$backup_dir" >&2; exit 1; }
[[ -n "$passphrase_file" && -f "$passphrase_file" ]] || {
  printf 'A readable --passphrase-file is required.\n' >&2
  exit 1
}

command -v node >/dev/null 2>&1 || { printf 'Node.js is required.\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'tar is required.\n' >&2; exit 1; }

crypto_script="$script_dir/../backup-crypto.mjs"
[[ -f "$crypto_script" ]] || {
  printf 'Backup encryption helper does not exist: %s\n' "$crypto_script" >&2
  exit 1
}

latest="$(find "$backup_dir" -maxdepth 1 -type f -name 'blitz-keepalive-backup-*.tar.gz.enc' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "$latest" ]] || { printf 'No encrypted backup found in %s\n' "$backup_dir" >&2; exit 1; }

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/blitz-keepalive-restore-drill.XXXXXX")"
cleanup() {
  rm -rf -- "$tmpdir"
}
trap cleanup EXIT INT TERM
umask 077

archive="$tmpdir/backup.tar.gz"
node "$crypto_script" decrypt "$latest" \
  --output "$archive" \
  --passphrase-file "$passphrase_file"

while IFS= read -r entry; do
  case "$entry" in
    /*|..|../*|*/..|*/../*)
      printf 'Unsafe archive entry rejected: %s\n' "$entry" >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "$archive")

tar -xzf "$archive" -C "$tmpdir" --no-same-owner --no-same-permissions

for file in managed-targets.json admin-auth.json; do
  [[ -f "$tmpdir/$file" ]] || { printf 'Required restored file is missing: %s\n' "$file" >&2; exit 1; }
  node --input-type=module -e 'import { readFileSync } from "node:fs"; JSON.parse(readFileSync(process.argv[1], "utf8"));' "$tmpdir/$file"
done

[[ -f "$tmpdir/target-secrets.key" ]] || { printf 'Required restored file is missing: target-secrets.key\n' >&2; exit 1; }
node --input-type=module -e 'import { readFileSync } from "node:fs"; const record = JSON.parse(readFileSync(process.argv[1], "utf8")); if (record.version !== 1 || record.algorithm !== "aes-256-gcm" || typeof record.key !== "string" || Buffer.from(record.key, "base64").length !== 32) process.exit(1);' "$tmpdir/target-secrets.key" || {
  printf 'target-secrets.key is not a valid version 1 AES-256-GCM key record.\n' >&2
  exit 1
}

printf 'Restore drill passed: %s\n' "$latest"
printf 'Validated JSON: managed-targets.json, admin-auth.json, target-secrets.key\n'
printf 'Validated key material: target-secrets.key (AES-256-GCM, 32 bytes)\n'
