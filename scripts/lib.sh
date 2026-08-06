#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts; not meant to be run directly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
ADDON_DIR="$REPO_ROOT/addon"
UPSTREAM_DIR="$REPO_ROOT/.upstream/wealthfolio"

# Wealthfolio release this project develops against. Kept in sync with
# docs/UPSTREAM.md and infra/.env.example.
UPSTREAM_VERSION="v3.6.2"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

info()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s ok %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s warn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

require() {
  have "$1" || die "Falta '$1'. $2"
}

# Docker Compose v2 only; the v1 `docker-compose` binary is unsupported.
compose() {
  have docker || die "Docker no está instalado. Ver docs/ARCHITECTURE.md § Despliegue."
  docker compose version >/dev/null 2>&1 || die "Se requiere Docker Compose v2 ('docker compose')."
  [[ -f "$INFRA_DIR/.env" ]] || die "Falta infra/.env. Cópialo desde infra/.env.example."
  docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/compose.yml" "$@"
}

compose_dev() {
  have docker || die "Docker no está instalado."
  [[ -f "$INFRA_DIR/.env" ]] || die "Falta infra/.env. Cópialo desde infra/.env.example."
  docker compose --env-file "$INFRA_DIR/.env" \
    -f "$INFRA_DIR/compose.yml" -f "$INFRA_DIR/compose.dev.yml" "$@"
}

# pnpm is required by the addon toolchain. Corepack ships with Node 16.9+, so
# activating it beats asking the user to install a second package manager.
ensure_pnpm() {
  if have pnpm; then return 0; fi
  if have corepack; then
    info "Activando pnpm vía corepack…"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.33.4 --activate >/dev/null 2>&1 || true
  fi
  have pnpm || die "Falta pnpm. Instálalo con: corepack enable && corepack prepare pnpm@10.33.4 --activate"
}
