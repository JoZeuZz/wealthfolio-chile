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

ok "Addon instalado ($(du -h --apparent-size "$target/dist/addon.js" | cut -f1))"

# The container runs as uid 1000 and rewrites manifest.json on enable/disable.
# Files copied here belong to whoever ran this script, so without this the host
# answers the very first toggle with `Failed to write manifest: Permission
# denied (os error 13)` and the addon can never be turned off again.
running=false
if have docker && docker compose version >/dev/null 2>&1 && [[ -f "$INFRA_DIR/.env" ]]; then
  compose ps --services --filter status=running 2>/dev/null | grep -q wealthfolio && running=true
fi

if ! chown -R "$WF_CONTAINER_UID:$WF_CONTAINER_GID" "$target" 2>/dev/null; then
  # Unprivileged deployer: borrow the daemon's root inside the container.
  if [[ "$running" == true ]]; then
    docker exec -u 0:0 wealthfolio \
      chown -R "$WF_CONTAINER_UID:$WF_CONTAINER_GID" "/data/addons/$addon_id" 2>/dev/null \
      || warn "No se pudo cambiar el propietario de $target a $WF_CONTAINER_UID:$WF_CONTAINER_GID."
  else
    warn "No se pudo cambiar el propietario de $target a $WF_CONTAINER_UID:$WF_CONTAINER_GID."
  fi
fi

if [[ "$running" == true ]]; then
  info "Reiniciando Wealthfolio para recargar el addon…"
  compose restart wealthfolio

  # Post-condition, not decoration: an addon the host cannot write is an addon
  # the user cannot disable, and the failure only shows up in the UI much later.
  if ! docker exec wealthfolio test -w "/data/addons/$addon_id/manifest.json"; then
    die "El host no puede escribir /data/addons/$addon_id/manifest.json. Activar o desactivar el addon fallará con 'Permission denied'. Corrige el propietario a $WF_CONTAINER_UID:$WF_CONTAINER_GID."
  fi

  ok "Listo. Abre la app y busca 'Chile' en la barra lateral."
else
  warn "Wealthfolio no está corriendo. Levántalo con: ./scripts/stack.sh start"
fi
