#!/usr/bin/env bash
# Build the addon and install it into the local Wealthfolio instance.
#
#   ./scripts/deploy-addon.sh
#
# Wealthfolio loads sideloaded addons from WF_ADDONS_DIR. This builds the
# bundle, lays out the directory the host expects (manifest.json + dist/), and
# restarts the container so it is picked up.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ensure_pnpm

addon_id="$(node -p "require('$ADDON_DIR/manifest.json').id")"
addon_version="$(node -p "require('$ADDON_DIR/manifest.json').version")"

info "Construyendo $addon_id v$addon_version…"
(cd "$ADDON_DIR" && pnpm build)

# Resolve the addons directory from .env, defaulting to infra/addons.
addons_dir="$INFRA_DIR/addons"
if [[ -f "$INFRA_DIR/.env" ]]; then
  configured="$(grep -E '^WF_ADDONS_DIR=' "$INFRA_DIR/.env" | cut -d= -f2- || true)"
  if [[ -n "$configured" ]]; then
    case "$configured" in
      /*) addons_dir="$configured" ;;
      *)  addons_dir="$INFRA_DIR/${configured#./}" ;;
    esac
  fi
fi

target="$addons_dir/$addon_id"
info "Instalando en $target…"
mkdir -p "$target/dist"
cp "$ADDON_DIR/manifest.json" "$target/manifest.json"
cp "$ADDON_DIR/dist/addon.js" "$target/dist/addon.js"
[[ -f "$ADDON_DIR/README.md" ]] && cp "$ADDON_DIR/README.md" "$target/README.md"

ok "Addon instalado ($(du -h "$target/dist/addon.js" | cut -f1))"

if have docker && docker compose version >/dev/null 2>&1 && [[ -f "$INFRA_DIR/.env" ]]; then
  if compose ps --services --filter status=running 2>/dev/null | grep -q wealthfolio; then
    info "Reiniciando Wealthfolio para recargar el addon…"
    compose restart wealthfolio
    ok "Listo. Abre la app y busca 'Chile' en la barra lateral."
  else
    warn "Wealthfolio no está corriendo. Levántalo con: ./scripts/stack.sh start"
  fi
else
  warn "Docker no disponible: el addon quedó construido en $target, instálalo manualmente."
fi
