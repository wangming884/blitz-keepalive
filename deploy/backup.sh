#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: backup.sh [--data-dir PATH] [--output-dir PATH]

Creates a timestamped tar.gz archive containing:
  managed-targets.json
  target-secrets.key
  admin-auth.json

The archive contains secrets. Store it encrypted and access-controlled.
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${PWD}/data"
output_dir="${PWD}/backups"

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

required_files=(managed-targets.json target-secrets.key admin-auth.json)
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

printf 'Backup created: %s\n' "$archive_path"
printf 'Included files: %s\n' "${#included_files[@]}"
printf 'Store this archive as a secret. Restore it together with the matching application version.\n'
