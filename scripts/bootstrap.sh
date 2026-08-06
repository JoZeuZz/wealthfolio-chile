#!/usr/bin/env bash
# Prepare a fresh clone for development.
#
#   ./scripts/bootstrap.sh
#
# Checks the toolchain, installs addon dependencies, fetches the upstream
# checkout used for reference, and creates infra/.env from the template.
# Safe to re-run.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

info "Wealthfolio Chile — bootstrap"
echo

# ── Toolchain ─────────────────────────────────────────────────────────
require git "Instálalo con: sudo apt install git"
require node "Se requiere Node 20.19+ (24 recomendado, igual que upstream)."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  die "Node $(node -v) es demasiado antiguo. Se requiere 20.19+ (24 recomendado)."
elif (( node_major < 24 )); then
  warn "Node $(node -v): funciona, pero upstream fija Node 24 (.node-version)."
fi

ensure_pnpm
ok "node $(node -v) · pnpm $(pnpm --version)"

if have docker && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  warn "Docker no está disponible: podrás desarrollar y correr tests, pero no levantar Wealthfolio self-hosted."
fi

echo

# ── Addon dependencies ────────────────────────────────────────────────
info "Instalando dependencias del addon…"
(cd "$ADDON_DIR" && pnpm install --prefer-offline)
ok "Dependencias instaladas"

# ── Upstream reference checkout ───────────────────────────────────────
if [[ -d "$UPSTREAM_DIR/.git" ]]; then
  ok "Checkout de upstream ya presente ($UPSTREAM_DIR)"
else
  info "Clonando Wealthfolio $UPSTREAM_VERSION como referencia…"
  mkdir -p "$(dirname "$UPSTREAM_DIR")"
  git clone --depth 1 --branch "$UPSTREAM_VERSION" \
    https://github.com/wealthfolio/wealthfolio.git "$UPSTREAM_DIR" \
    || warn "No se pudo clonar upstream (¿sin red?). Ejecuta scripts/update-upstream.sh más tarde."
fi

# ── Local configuration ───────────────────────────────────────────────
if [[ -f "$INFRA_DIR/.env" ]]; then
  ok "infra/.env ya existe (no se toca)"
else
  cp "$INFRA_DIR/.env.example" "$INFRA_DIR/.env"
  if have openssl; then
    secret="$(openssl rand -base64 32)"
    # Portable in-place edit: BSD and GNU sed disagree about -i.
    tmp="$(mktemp)"
    sed "s|^WF_SECRET_KEY=.*|WF_SECRET_KEY=${secret}|" "$INFRA_DIR/.env" > "$tmp"
    mv "$tmp" "$INFRA_DIR/.env"
    ok "infra/.env creado con WF_SECRET_KEY generado"
  else
    warn "infra/.env creado, pero falta openssl: define WF_SECRET_KEY a mano."
  fi
  warn "Falta definir WF_AUTH_PASSWORD_HASH en infra/.env antes de exponer el servicio."
fi

mkdir -p "$REPO_ROOT/samples/private"
mkdir -p "$INFRA_DIR/addons"

echo
ok "Listo."
echo
echo "  ./scripts/test.sh          verificar el motor (typecheck + lint + tests + build)"
echo "  ./scripts/dev.sh           levantar el entorno de desarrollo del addon"
echo "  ./scripts/deploy-addon.sh  construir e instalar el addon en la instancia local"
echo
