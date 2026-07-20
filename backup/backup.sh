#!/bin/sh
# ════════════════════════════════════════════════════════
# CHAOS CREW v5 – Backup Script
# Sichert PostgreSQL (pg_dump) + Redis (RDB copy)
# Läuft täglich per Cron oder manuell
# ════════════════════════════════════════════════════════

set -e

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PG_HOST="${PG_HOST:-postgres}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-chaoscrew}"
PG_USER="${PG_USER:-chaoscrew}"
PGPASSWORD="${PG_PASSWORD:-changeme}"
REDIS_HOST="${REDIS_HOST:-redis}"
REDIS_PORT="${REDIS_PORT:-6379}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TS=$(date +%Y%m%d_%H%M%S)

export PGPASSWORD

mkdir -p "${BACKUP_DIR}/postgres" "${BACKUP_DIR}/redis"

echo "[Backup] Starting at $(date)"

# ── PostgreSQL Backup ─────────────────────────────────────
PG_FILE="${BACKUP_DIR}/postgres/chaoscrew_${TS}.sql.gz"
echo "[Backup] PostgreSQL → ${PG_FILE}"

pg_dump \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -d "${PG_DB}" \
  --format=plain \
  --no-password \
  | gzip > "${PG_FILE}"

echo "[Backup] PostgreSQL done: $(du -sh ${PG_FILE} | cut -f1)"

# ── Redis Backup ──────────────────────────────────────────
echo "[Backup] Redis BGSAVE..."
redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" BGSAVE

# Warten bis BGSAVE fertig
for i in $(seq 1 30); do
  STATUS=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" LASTSAVE)
  sleep 1
  NEW_STATUS=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" LASTSAVE)
  if [ "$NEW_STATUS" != "$STATUS" ]; then break; fi
done

# RDB-Datei kopieren
REDIS_FILE="${BACKUP_DIR}/redis/dump_${TS}.rdb"
# Versuche via redis-cli DEBUG RELOAD oder kopiere /data/dump.rdb
if [ -f "/redis-data/dump.rdb" ]; then
  cp "/redis-data/dump.rdb" "${REDIS_FILE}"
  echo "[Backup] Redis RDB → ${REDIS_FILE}: $(du -sh ${REDIS_FILE} | cut -f1)"
else
  echo "[Backup] Redis RDB nicht gefunden, überspringe"
fi

# ── Cleanup alte Backups ──────────────────────────────────
echo "[Backup] Cleaning backups older than ${KEEP_DAYS} days..."
find "${BACKUP_DIR}/postgres" -name "*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
find "${BACKUP_DIR}/redis"    -name "*.rdb"    -mtime "+${KEEP_DAYS}" -delete

# ── Manifest ─────────────────────────────────────────────
MANIFEST="${BACKUP_DIR}/manifest.json"
PG_SIZE=$(du -sh "${PG_FILE}" 2>/dev/null | cut -f1 || echo "0")
cat > "${MANIFEST}" <<EOF
{
  "last_backup": "${TS}",
  "pg_file": "${PG_FILE}",
  "pg_size": "${PG_SIZE}",
  "keep_days": ${KEEP_DAYS},
  "status": "ok"
}
EOF

echo "[Backup] Done at $(date)"
echo "[Backup] Manifest: ${MANIFEST}"
