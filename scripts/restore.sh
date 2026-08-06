#!/usr/bin/env bash
# Restore a Wealthfolio backup.
#
#   ./scripts/restore.sh backups/wealthfolio-20260205-101500.tar.gz
#
# DESTRUCTIVE: replaces the entire contents of the data volume. Requires typing
# the confirmation phrase — a mistyped filename here costs your whole financial
# history.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

archive="${1:-}"
[[ -n "$archive" ]] || die "Uso: ./scripts/restore.sh <archivo.tar.gz>"
[[ -f "$archive" ]] || die "No existe el archivo: $archive"

archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
project="$(basename "$INFRA_DIR")"
volume="wealthfolio-data"

echo
warn "Esto BORRARÁ todos los datos actuales de Wealthfolio y los reemplazará por:"
echo "    $archive"
echo
printf 'Escribe RESTAURAR para continuar: '
read -r answer
[[ "$answer" == "RESTAURAR" ]] || die "Cancelado."

info "Deteniendo el contenedor…"
compose stop wealthfolio || true

info "Restaurando el volumen…"
docker run --rm \
  -v "${project}_${volume}:/data" \
  -v "$(dirname "$archive"):/backup:ro" \
  alpine:3.21 \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf '/backup/$(basename "$archive")' -C /data" \
  || die "Falló la restauración. El contenedor sigue detenido."

info "Levantando el contenedor…"
compose start wealthfolio

ok "Restaurado. Verifica con: ./scripts/stack.sh logs"
