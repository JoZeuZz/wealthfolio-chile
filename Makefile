# Wealthfolio Chile
#
# Atajos sobre scripts/. `make help` lista todo.

.DEFAULT_GOAL := help
.PHONY: help bootstrap test dev build deploy start stop restart logs status update backup upstream clean

help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Prepara un clon nuevo para desarrollo
	@./scripts/bootstrap.sh

test: ## typecheck + lint + tests + build
	@./scripts/test.sh

dev: ## Servidor de desarrollo del addon
	@./scripts/dev.sh

build: ## Construye el bundle del addon
	@cd addon && pnpm build

deploy: ## Construye e instala el addon en la instancia local
	@./scripts/deploy-addon.sh

start: ## Levanta Wealthfolio
	@./scripts/stack.sh start

stop: ## Detiene Wealthfolio
	@./scripts/stack.sh stop

restart: ## Reinicia Wealthfolio
	@./scripts/stack.sh restart

logs: ## Sigue los logs
	@./scripts/stack.sh logs

status: ## Estado del contenedor
	@./scripts/stack.sh status

update: ## Respalda y actualiza Wealthfolio
	@./scripts/stack.sh update

backup: ## Respalda el volumen de datos
	@./scripts/backup.sh

upstream: ## Refresca el checkout de referencia de Wealthfolio
	@./scripts/update-upstream.sh

clean: ## Borra artefactos de build
	@cd addon && pnpm clean
	@echo "Listo."
