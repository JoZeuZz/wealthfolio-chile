#!/usr/bin/env bash
# Back up the Wealthfolio data volume.
#
#   ./scripts/backup.sh [destino]
#
# Produces a timestamped tar.gz of /data (SQLite database + addons). The
# container is stopped for the duration: copying a live SQLite file can capture
# a half-written transaction, and a backup you cannot restore is not a backup.
#
# Restore with scripts/restore.sh.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dest_dir="${1:-$REPO_ROOT/backups}"
mkdir -p "$dest_dir"

stamp="$(date +%Y%m%d-%H%M%S)"
archive="$dest_dir/wealthfolio-$stamp.tar.gz"

volume="$(compose config --format json 2>/dev/null \
  | { command -v jq >/dev/null && jq -r '.volumes | keys[0]' || echo ''; } )"
volume="${volume:-wealthfolio-data}"
project="$(basename "$INFRA_DIR")"

was_running=false
if compose ps --services --filter status=running 2>/dev/null | grep -q wealthfolio; then
  was_running=true
  info "Deteniendo el contenedor para un respaldo consistente…"
  compose stop wealthfolio
fi

info "Creando $archive…"
docker run --rm \
  -v "${project}_${volume}:/data:ro" \
  -v "$dest_dir:/backup" \
  alpine:3.21 \
  tar czf "/backup/$(basename "$archive")" -C /data . \
  || die "Falló el respaldo. El contenedor sigue detenido; levántalo con ./scripts/stack.sh start"

if [[ "$was_running" == true ]]; then
  info "Levantando el contenedor de nuevo…"
  compose start wealthfolio
fi

size="$(du -h "$archive" | cut -f1)"
ok "Respaldo listo: $archive ($size)"

# Retention: keep the 14 most recent. Financial history is small; losing every
# old copy to disk pressure is the bigger risk.
count="$(find "$dest_dir" -maxdepth 1 -name 'wealthfolio-*.tar.gz' | wc -l)"
if (( count > 14 )); then
  info "Eliminando respaldos antiguos (se conservan los 14 más recientes)…"
  find "$dest_dir" -maxdepth 1 -name 'wealthfolio-*.tar.gz' -print0 \
    | xargs -0 ls -1t \
    | tail -n +15 \
    | while read -r old; do rm -f "$old"; done
fi
