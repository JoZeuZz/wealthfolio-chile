#!/usr/bin/env bash
# Development loop for the addon.
#
#   ./scripts/dev.sh          rebuild on change + serve for hot reload
#   ./scripts/dev.sh watch    rebuild on change only
#
# The dev server is the mechanism Wealthfolio itself provides
# (@wealthfolio/addon-dev-tools): it exposes /manifest.json and /addon.js on
# localhost:3001-3003, and a Wealthfolio started with
# VITE_ENABLE_ADDON_DEV_MODE=true discovers it automatically.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ensure_pnpm
cd "$ADDON_DIR"

mode="${1:-serve}"

case "$mode" in
  watch)
    info "Reconstruyendo el addon en cada cambio (Ctrl-C para salir)…"
    exec pnpm dev
    ;;
  serve)
    info "Compilando una vez antes de servir…"
    pnpm build
    info "Servidor de desarrollo en http://localhost:3001"
    echo
    echo "  Para que Wealthfolio lo descubra, levántalo con:"
    echo "    VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev     (escritorio)"
    echo "    ./scripts/deploy-addon.sh                          (instancia Docker)"
    echo
    exec pnpm dev:server
    ;;
  *)
    die "Uso: ./scripts/dev.sh [serve|watch]"
    ;;
esac
