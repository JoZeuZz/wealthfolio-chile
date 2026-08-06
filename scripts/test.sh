#!/usr/bin/env bash
# Full quality gate: typecheck, lint, tests, build.
#
#   ./scripts/test.sh
#
# This is what CI runs. A phase is never considered finished until it passes.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ensure_pnpm
cd "$ADDON_DIR"

info "typecheck"
pnpm typecheck

info "lint"
pnpm lint

info "tests"
pnpm test

info "build"
pnpm build

echo
ok "Todo verde."
