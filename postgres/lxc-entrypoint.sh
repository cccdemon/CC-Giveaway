#!/bin/sh
set -e

# ── LXC AppArmor Fix ──────────────────────────────────────
# AppArmor in unprivilegierten LXC-Containern blockiert AF_UNIX Sockets
# wenn sie in /var/run/postgresql angelegt werden sollen.
#
# Der originale postgres-Entrypoint startet intern einen Temp-Server
# über pg_ctl – dieser Prozess erbt keine CMD-Argumente und versucht
# Sockets im Standard-Verzeichnis anzulegen.
#
# Lösung: unix_socket_directories auf /tmp setzen.
# /tmp existiert immer und ist beschreibbar – AppArmor erlaubt das.
# Die API verbindet sich per TCP (host=postgres), nutzt nie den Socket.

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
CONF="${PGDATA}/postgresql.conf"
SAMPLE="/usr/local/share/postgresql/postgresql.conf.sample"

patch_file() {
    local FILE="$1"
    [ -f "$FILE" ] || return

    echo "[lxc-fix] Patche $FILE"

    # unix_socket_directories → /tmp  (existiert, AppArmor erlaubt es)
    if grep -q "unix_socket_directories" "$FILE"; then
        sed -i "s|.*unix_socket_directories.*|unix_socket_directories = '/tmp'|g" "$FILE"
    else
        echo "unix_socket_directories = '/tmp'" >> "$FILE"
    fi

    # listen_addresses sicherstellen
    if grep -q "^listen_addresses" "$FILE"; then
        sed -i "s|^listen_addresses.*|listen_addresses = '*'|" "$FILE"
    else
        echo "listen_addresses = '*'" >> "$FILE"
    fi
}

# Sample patchen (für frischen initdb)
patch_file "$SAMPLE"

# Bestehende postgresql.conf patchen (falls Volume schon existiert)
patch_file "$CONF"

echo "[lxc-fix] PostgreSQL startet mit unix_socket_directories='/tmp'"
    echo "[lxc-fix] exec /usr/local/bin/docker-entrypoint.sh $*"
    exec /usr/local/bin/docker-entrypoint.sh "$@"
