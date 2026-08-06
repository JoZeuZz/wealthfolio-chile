#!/usr/bin/env bash
# Refresh the read-only Wealthfolio checkout used as reference.
#
#   ./scripts/update-upstream.sh            fetch the pinned version
#   ./scripts/update-upstream.sh v3.7.0     move to another release
#   ./scripts/update-upstream.sh --latest   fetch the newest release tag
#
# `.upstream/` is git-ignored: upstream is never vendored into this repository,
# only consulted. Changing the version here does NOT change what the addon is
# built against — that lives in addon/manifest.json and docs/UPSTREAM.md, and
# should be updated deliberately after reviewing the SDK changelog.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target="${1:-$UPSTREAM_VERSION}"

if [[ "$target" == "--latest" ]]; then
  require curl "Instálalo con: sudo apt install curl"
  info "Consultando la última release…"
  target="$(curl -fsSL https://api.github.com/repos/wealthfolio/wealthfolio/releases/latest \
    | grep -m1 '"tag_name"' | cut -d'"' -f4)"
  [[ -n "$target" ]] || die "No se pudo determinar la última versión."
  info "Última release: $target"
fi

mkdir -p "$(dirname "$UPSTREAM_DIR")"

if [[ -d "$UPSTREAM_DIR/.git" ]]; then
  info "Actualizando el checkout existente a $target…"
  git -C "$UPSTREAM_DIR" fetch --depth 1 origin "refs/tags/$target:refs/tags/$target" \
    || die "No se pudo traer el tag $target."
  git -C "$UPSTREAM_DIR" checkout --quiet --force "tags/$target"
else
  info "Clonando Wealthfolio $target…"
  git clone --depth 1 --branch "$target" \
    https://github.com/wealthfolio/wealthfolio.git "$UPSTREAM_DIR"
fi

current="$(git -C "$UPSTREAM_DIR" describe --tags --always 2>/dev/null || echo desconocida)"
ok "Upstream en $current ($UPSTREAM_DIR)"

echo
info "Comparación con la versión contra la que se desarrolla el addon:"
sdk_declared="$(node -p "require('$ADDON_DIR/manifest.json').sdkVersion" 2>/dev/null || echo '?')"
sdk_upstream="$(node -p "require('$UPSTREAM_DIR/packages/addon-sdk/package.json').version" 2>/dev/null || echo '?')"
printf '  addon/manifest.json sdkVersion : %s\n' "$sdk_declared"
printf '  upstream addon-sdk             : %s\n' "$sdk_upstream"

if [[ "$sdk_declared" != "$sdk_upstream" ]]; then
  echo
  warn "Las versiones difieren. Antes de subir el addon:"
  echo "   1. Lee $UPSTREAM_DIR/docs/addons/ (guías de migración)"
  echo "   2. Revisa los cambios del SDK:"
  echo "      git -C $UPSTREAM_DIR log --oneline -- packages/addon-sdk"
  echo "   3. Actualiza sdkVersion/minWealthfolioVersion en addon/manifest.json"
  echo "   4. Actualiza WF_VERSION en infra/.env.example y docs/UPSTREAM.md"
  echo "   5. ./scripts/test.sh"
fi
