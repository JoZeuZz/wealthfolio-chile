# Estado actual

Qué funciona **hoy**, verificado, y qué no.

Actualizado: 2026-08-05 · Wealthfolio v3.6.2 · addon v0.1.0

---

## Verificación

```
typecheck   ✅  tsc --noEmit, strict + noUncheckedIndexedAccess
lint        ✅  eslint, 0 errores, 0 warnings, sin `any`
tests       ✅  185 pasando (9 archivos)
build       ✅  dist/addon.js — 735 KB (192 KB gzip), un solo archivo
```

`./scripts/test.sh` corre las cuatro.

---

## Funciona

### Motor (`core/`)

| Área | Estado |
| --- | --- |
| Aritmética exacta de dinero | ✅ 26 tests |
| Fechas civiles sin zona horaria | ✅ 21 tests |
| Lectura CSV / TXT / XLSX / XLS | ✅ 21 tests |
| Detección de delimitador y codificación | ✅ incl. Windows-1252 |
| Detección de cabecera y mapeo de columnas | ✅ |
| Selección de parser por evidencia estructural | ✅ 23 tests, con regresión |
| Modelo canónico | ✅ |
| Huellas e idempotencia | ✅ 24 tests |
| Conciliación de transferencias internas | ✅ 11 tests |
| Conciliación de pagos de tarjeta | ✅ |
| Normalización de comercios | ✅ |
| Motor de reglas + 24 reglas predefinidas | ✅ 24 tests |
| Detección de cuotas y planes | ✅ 20 tests |
| Métricas mensuales, categorías, comercios, recurrentes | ✅ |
| Insights deterministas | ✅ |
| Redacción y enmascarado | ✅ 15 tests |

### Flujo de importación

Funciona de punta a punta contra fixtures sintéticos:

1. Archivo por drag & drop o selector, dentro del sandbox.
2. Detección de banco con puntaje y razones visibles.
3. Selección manual de banco si hace falta.
4. Vista previa con totales, advertencias y por-fila.
5. Marcado/desmarcado por fila, con totales recalculados.
6. Escritura por `activities.saveMany({ creates })`.
7. Registro en el historial de importaciones.

**Reimportar el mismo archivo produce cero movimientos nuevos.** Verificado por
test, incluyendo archivos con períodos solapados.

### Interfaz

- Panel Chile: flujo del mes, gastos por categoría, comercios principales,
  cuotas comprometidas, movimientos que no son gasto, observaciones, recurrentes.
- Wizard de importación en 4 pasos.
- Historial de importaciones con hash, parser y versión.

### Infraestructura

- `infra/compose.yml` con versión fijada, healthcheck, `read_only`,
  `no-new-privileges`, límites de memoria, logs rotados.
- Overlay de desarrollo.
- Scripts: `bootstrap`, `test`, `dev`, `stack`, `backup`, `restore`,
  `deploy-addon`, `update-upstream`.
- CI: typecheck, lint, test, build, verificación de privacidad, auditoría de
  dependencias.

---

## No funciona / no está hecho

| Qué | Por qué |
| --- | --- |
| **Perfiles bancarios validados** | No hay cartolas reales. Los tres bancos tienen adaptador completo pero marcado `pending-real-sample`. Ver [BANK_FORMATS.md](BANK_FORMATS.md) |
| **UI de conciliación** | El motor está listo y testeado, pero no hay pantalla para confirmar o rechazar sugerencias de transferencia |
| **UI de reglas** | Las reglas predefinidas se aplican; no hay editor. Se pueden escribir en `storage` a mano |
| **Editor de categorías** | Mismo caso |
| **Aplicar conciliación al importar** | `matchTransfers` no está enganchado a `prepareImport` — hace falta comparar contra movimientos de *otras* cuentas |
| **Servicio importador** | Decisión D11: no aporta hasta que los perfiles estén validados |
| **IA / MCP propio** | Decisión D10 y D12 |
| **Fintoc** | Sin credenciales; solo existe la abstracción conceptual |
| **Levantar Docker aquí** | Docker no está instalado en esta máquina. La infraestructura está escrita y revisada, pero no ejecutada |

---

## Verificado vs. no verificado

Honestidad sobre qué se probó realmente:

| Afirmación | Cómo se verificó |
| --- | --- |
| El motor funciona | 185 tests contra fixtures sintéticos |
| El addon compila a un bundle cargable | `pnpm build`, un solo `dist/addon.js` |
| El manifiesto es válido | Generado por el CLI oficial, ajustado según `manifest.ts` del SDK |
| El addon carga en Wealthfolio | **No verificado** — requiere una instancia corriendo |
| Los parsers leen cartolas reales | **No verificado** — no hay archivos reales |
| El compose levanta | **No verificado** — Docker no instalado |

Las tres últimas son las que faltan para cerrar el MVP.

---

## MVP: 12 de 15

| # | Criterio | Estado |
| --- | --- | --- |
| 1 | Wealthfolio se levanta localmente | ⚠️ escrito, no ejecutado (falta Docker) |
| 2 | El addon se carga | ⚠️ compila; carga no verificada |
| 3 | Se puede seleccionar un archivo | ✅ |
| 4 | Se detecta o elige el banco | ✅ |
| 5 | Se transforma al modelo canónico | ✅ |
| 6 | Existe vista previa | ✅ |
| 7 | Se calculan ingresos y egresos | ✅ |
| 8 | Se detectan duplicados | ✅ |
| 9 | El usuario confirma | ✅ |
| 10 | Llega por APIs soportadas | ✅ `saveMany` |
| 11 | Reimportar no duplica | ✅ con test |
| 12 | Hay historial | ✅ |
| 13 | Hay tests | ✅ 185 |
| 14 | Hay documentación | ✅ |
| 15 | No se filtran datos en logs | ✅ con test |

---

## Siguiente paso recomendado

1. Instalar Docker y levantar `./scripts/stack.sh start`.
2. `./scripts/deploy-addon.sh` y confirmar que "Chile" aparece en la barra
   lateral.
3. Importar `samples/synthetic/banco-chile-cuenta-corriente.csv` de punta a
   punta, contra una instancia real.
4. Recién entonces, calibrar con una cartola real siguiendo
   [BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*.
