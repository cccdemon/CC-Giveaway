#!/bin/sh
# ════════════════════════════════════════════════════════
# CHAOS CREW v5 – Restore Script
# Stellt PostgreSQL aus pg_dump wieder her
# WARNUNG: Überschreibt bestehende Daten!
# ════════════════════════════════════════════════════════

set -e

PG_HOST="${PG_HOST:-postgres}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-chaoscrew}"
PG_USER="${PG_USER:-chaoscrew}"
PGPASSWORD="${PG_PASSWORD:-changeme}"
export PGPASSWORD

BACKUP_FILE="$1"

if [ -z "${BACKUP_FILE}" ]; then
  echo "Usage: restore.sh <backup_file.sql.gz>"
  echo ""
  echo "Verfügbare Backups:"
  ls -lh /backups/postgres/*.sql.gz 2>/dev/null || echo "  (keine Backups gefunden)"
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Datei nicht gefunden: ${BACKUP_FILE}"
  exit 1
fi

echo "════════════════════════════════════════"
echo "CHAOS CREW v5 – Restore"
echo "Datei: ${BACKUP_FILE}"
echo "Ziel:  ${PG_HOST}:${PG_PORT}/${PG_DB}"
echo "════════════════════════════════════════"
echo ""
echo "WARNUNG: Bestehende Daten werden ÜBERSCHRIEBEN!"
printf "Fortfahren? (yes/no): "
read CONFIRM

if [ "${CONFIRM}" != "yes" ]; then
  echo "Abgebrochen."
  exit 0
fi

echo ""
echo "[Restore] Starte um $(date)"

# Bestehende Daten leeren (Tabellen nicht droppen, Schema behalten)
echo "[Restore] Leere bestehende Tabellen..."
psql \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -d "${PG_DB}" \
  --no-password \
  -c "
    TRUNCATE TABLE watchtime_events CASCADE;
    TRUNCATE TABLE session_participants CASCADE;
    TRUNCATE TABLE sessions CASCADE;
    TRUNCATE TABLE spacefight_results CASCADE;
    TRUNCATE TABLE spacefight_stats CASCADE;
    TRUNCATE TABLE users CASCADE;
  "

echo "[Restore] Lade Backup ein..."
gunzip -c "${BACKUP_FILE}" | psql \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -d "${PG_DB}" \
  --no-password

echo "[Restore] Fertig um $(date)"
echo ""
echo "Überprüfung:"
psql \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -d "${PG_DB}" \
  --no-password \
  -c "
    SELECT 'users' AS table, COUNT(*) FROM users
    UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
    UNION ALL SELECT 'session_participants', COUNT(*) FROM session_participants
    UNION ALL SELECT 'watchtime_events', COUNT(*) FROM watchtime_events
    UNION ALL SELECT 'spacefight_results', COUNT(*) FROM spacefight_results;
  "
