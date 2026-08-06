#!/usr/bin/env bash
# Lifecycle of the self-hosted Wealthfolio instance.
#
#   ./scripts/stack.sh start|stop|restart|logs|status|update|pull|dev
#
# Thin, readable wrapper over `docker compose` so the day-to-day commands are
# one word and the flags live in one place.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cmd="${1:-status}"
shift || true

case "$cmd" in
  start)
    info "Levantando Wealthfolio…"
    compose up -d
    ok "Arriba. Revisa el estado con: ./scripts/stack.sh status"
    ;;

  dev)
    info "Levantando Wealthfolio con el overlay de desarrollo…"
    compose_dev up -d
    warn "El overlay de desarrollo desactiva la autenticación. No lo uses con datos reales."
    ;;

  stop)
    info "Deteniendo Wealthfolio…"
    compose down
    ok "Detenido. El volumen de datos se conserva."
    ;;

  restart)
    compose restart
    ok "Reiniciado."
    ;;

  logs)
    compose logs -f --tail="${1:-100}" wealthfolio
    ;;

  status)
    compose ps
    ;;

  pull)
    compose pull
    ;;

  update)
    # Upgrading rewrites the database schema, so a backup is not optional.
    info "Respaldando antes de actualizar…"
    "$REPO_ROOT/scripts/backup.sh"
    info "Descargando la imagen fijada en infra/.env…"
    compose pull
    info "Recreando el contenedor…"
    compose up -d
    ok "Actualizado. Verifica con: ./scripts/stack.sh logs"
    ;;

  *)
    die "Uso: ./scripts/stack.sh {start|dev|stop|restart|logs|status|pull|update}"
    ;;
esac
