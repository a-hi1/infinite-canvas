#!/usr/bin/env bash
# Backup cloud API data directory (JSON db + uploads).
# Usage:
#   ./scripts/backup-api-data.sh
#   DATA_DIR=./data/api BACKUP_DIR=./backups/api ./scripts/backup-api-data.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data/api}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/api}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/api-data-$STAMP.tar.gz"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "data dir not found: $DATA_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
tar -czf "$TARGET" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
echo "backup written: $TARGET"

# keep latest 14 backups by default
KEEP="${KEEP_BACKUPS:-14}"
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/api-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if ((${#OLD[@]} > 0)); then
  printf '%s\0' "${OLD[@]}" | xargs -0 rm -f
  echo "pruned old backups, keep=$KEEP"
fi
