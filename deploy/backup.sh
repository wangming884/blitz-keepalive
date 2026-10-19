#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: backup.sh [--data-dir PATH] [--output-dir PATH] [--passphrase-file PATH] [--allow-plaintext]

Creates a timestamped tar.gz archive containing:
  managed-targets.json
  target-secrets.key
  admin-auth.json
  runtime-state.json (when present)
  stats.json (when present)

The archive is AES-256-GCM encrypted by default. The plaintext tar.gz is
removed after successful encryption unless --allow-plaintext is supplied.
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${PWD}/data"
output_dir="${PWD}/backups"
passphrase_file=""
allow_plaintext=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      data_dir="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --passphrase-file)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      passphrase_file="$2"
      shift 2
      ;;
    --allow-plaintext)
      allow_plaintext=1
      shift
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

if [[ ! -d "$data_dir" ]]; then
  printf 'Data directory does not exist: %s\n' "$data_dir" >&2
  exit 1
fi

umask 077
mkdir -p -- "$output_dir"
chmod 700 "$output_dir"

required_files=(managed-targets.json target-secrets.key admin-auth.json runtime-state.json stats.json)
included_files=()
for name in "${required_files[@]}"; do
  if [[ -f "$data_dir/$name" ]]; then
    included_files+=("$name")
  else
    printf 'Warning: optional backup file is missing: %s\n' "$data_dir/$name" >&2
  fi
done

if [[ ${#included_files[@]} -eq 0 ]]; then
  printf 'No backup files were found in %s\n' "$data_dir" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%d-%H%M%S)"
archive_path="$output_dir/blitz-keepalive-backup-$timestamp.tar.gz"
tar -czf "$archive_path" -C "$data_dir" -- "${included_files[@]}"
chmod 600 "$archive_path"

crypto_script="$script_dir/backup-crypto.mjs"
[[ -f "$crypto_script" ]] || { printf 'Backup encryption helper does not exist: %s\n' "$crypto_script" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'Node.js is required to encrypt the backup archive.\n' >&2; exit 1; }

crypto_args=(encrypt "$archive_path")
if [[ -n "$passphrase_file" ]]; then
  [[ -f "$passphrase_file" ]] || { printf 'Passphrase file does not exist: %s\n' "$passphrase_file" >&2; exit 1; }
  crypto_args+=(--passphrase-file "$passphrase_file")
fi
if [[ $allow_plaintext -eq 1 ]]; then
  crypto_args+=(--allow-plaintext)
fi

if ! node "$crypto_script" "${crypto_args[@]}"; then
  printf 'Backup encryption failed. The plaintext archive was kept at %s\n' "$archive_path" >&2
  exit 1
fi

encrypted_path="$archive_path.enc"
[[ -f "$encrypted_path" ]] || { printf 'Backup encryption did not produce %s\n' "$encrypted_path" >&2; exit 1; }
chmod 600 "$encrypted_path"
[[ $allow_plaintext -eq 1 ]] && chmod 600 "$archive_path"

printf 'Encrypted backup created: %s\n' "$encrypted_path"
printf 'Included files: %s\n' "${#included_files[@]}"
printf 'Store this archive and the passphrase separately as secrets.\n'
printf 'Decrypt with: node deploy/backup-crypto.mjs decrypt %q\n' "$encrypted_path"
