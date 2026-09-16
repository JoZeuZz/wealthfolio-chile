# Estado actual

Qué funciona **hoy**, verificado, y qué no.

Actualizado: 2026-09-16 · Wealthfolio v3.7.0 (mínimo) / v3.8.0 (también validado) · addon 0.2.0-rc.6

---

## Cómo leer los estados

Cuatro niveles distintos, que esta documentación no mezcla:

| Nivel | Qué significa |
| --- | --- |
| **implementado** | El código existe y sus tests unitarios pasan |
| **integrado** | Está enganchado al flujo real del addon, no sólo disponible |
| **validado en host** | Se ejecutó contra un Wealthfolio v3.7.0 corriendo |
| **validado con banco real** | Se ejecutó contra una cartola real de ese banco |

**El proyecto está en *validado en host* contra 3.7.0 y 3.8.0.** Falta el
último nivel: ninguna cartola real ha tocado este código, y por eso la versión
es un release candidate y no un `0.2.0`.

---

## Verificación automática

```
typecheck   ✅  tsc --noEmit, strict + noUncheckedIndexedAccess
lint        ✅  eslint, 0 errores, 0 warnings, sin `any`
tests       ✅  1627 pasando (88 archivos)
build       ✅  dist/addon.js — un solo archivo, 935.15 KB (247.03 KB gzip)
coverage    ✅  96.27 % de líneas y 91.53 % de ramas en todo `src/`; 94.13 % / 90.11 % en `src/core/`
```

`pnpm verify` corre typecheck, lint, tests y build.

---

## Compatibilidad

| Dato | Valor |
| --- | --- |
| Host validado | Wealthfolio **3.7.0** y **3.8.0** |
| `@wealthfolio/addon-sdk` (build) | 3.8.0 |
| `@wealthfolio/ui` (build) | 3.8.0 |
| `@wealthfolio/addon-dev-tools` (build) | 3.8.0 |
| `minWealthfolioVersion` | **3.7.0** (sin cambio — es el mínimo real, no el SDK de build) |
| Build target | chrome107, edge107, firefox104, safari16 |

El addon no usa ninguna API exclusiva de 3.8 (`SpendingAPI`,
`ExchangeRatesAPI.getRatesForDates`), así que se construye con el SDK 3.8 pero
sigue funcionando en un host 3.7. `minWealthfolioVersion` declara el mínimo
*real* verificado, no el SDK usado para compilar — declarar soporte de una
versión que nadie corrió es la clase de afirmación que este proyecto no hace.
Ver [UPSTREAM.md](UPSTREAM.md).

---

## Validación contra host real (2026-09-03, Wealthfolio 3.7.0)

Diez escenarios, todos con datos sintéticos, ejecutados por la UI dentro del
iframe del host y verificados además por la API HTTP.

| # | Escenario | Resultado |
| --- | --- | --- |
| 1 | Importar una cartola válida | 5 movimientos creados, tipos y metadata v3 correctos |
| 2 | Reimportar el mismo archivo | 5/5 duplicados exactos, confirmar deshabilitado en 0 |
| 3 | Editar una actividad en Wealthfolio y reimportar | sólo esa fila baja a «posible duplicado», con el motivo visible; las otras 4 siguen siendo duplicados exactos |
| 4 | Cartola con una fila ilegible | importación bloqueada, **cero escrituras** (33 actividades antes y después) |
| 5 | Cartola CLP en una cuenta USD | bloqueada, con la razón concreta (moneda) y la que no se pudo comprobar (número de cuenta) |
| 6 | Devolución en tarjeta | `CREDIT/REFUND`, **no** pago de tarjeta |
| 7 | Pago recibido en tarjeta | `TRANSFER_IN`, clasificado como pago de tarjeta |
| 8 | Fechas ambiguas | orden resuelto para el archivo entero; ninguna advertencia por fila |
| 9 | Dos monedas en el mismo mes | métricas separadas por moneda, nunca sumadas |
| 10 | Conciliación | 2 pares confirmados, 2 sugeridos, 0 ambiguos, 3 pagos de tarjeta con su evidencia |

El escenario 6 **falló la primera vez** y ese fallo es el hallazgo más
importante de la sesión: Wealthfolio rechaza `UNKNOWN` en una cuenta de tarjeta
de crédito, y como `saveMany` valida el lote completo antes de escribir, una
sola fila sin clasificar costó los cinco movimientos. Ningún test unitario podía
verlo, porque el doble de test no modelaba la regla. Corregido y reverificado;
ver [UPSTREAM.md](UPSTREAM.md) § *Tipos de actividad permitidos por tipo de
cuenta*.

Los datos sintéticos de esta validación se eliminaron del host al terminar.

### Validación contra host real (2026-09-09, Wealthfolio 3.8.0)

Contenedor efímero y aislado (volumen propio, sin auth, nunca compartido con
la instancia de validación 3.7.0), destruido por completo al terminar. Objetivo:
confirmar que la migración de tooling a SDK 3.8 no rompe nada, no repetir los
diez escenarios de 3.7.0.

| Escenario | Resultado |
| --- | --- |
| Addon carga, manifest y permisos aceptados | ✅ |
| Crear cuentas (`CASH`, `CREDIT_CARD`) | ✅ |
| Detección de proveedor + import (Banco de Chile cuenta y tarjeta) | ✅ — 100 % de coincidencia, 12 + 7 movimientos creados |
| Reimportar el mismo archivo (dedupe) | ✅ — 12/12 duplicados exactos, confirmar deshabilitado en 0 |
| Devolución en tarjeta | ✅ — `CREDIT`, resta del gasto neto, no aparece como ingreso |
| Comisión, interés por mora (`FEE`/`INTEREST_CHARGE`) | ✅ |
| Pago de tarjeta | ✅ — clasificado como `Pago tarjeta`, no como gasto |
| Cuota con monto ambiguo | ✅ — marcada `Revisar` sin fabricar el total de la compra, cuenta correctamente en "Comprometido en cuotas" |
| `Fee`/`Tax` en la vista nativa de Activities | ✅ — `CLP 0` en todas las filas del addon, confirma que las "final cash semantics" de 3.8 no aplican (nunca poblamos esos campos) |
| Needs Review (host) | ✅ — 0/0, ninguna fila es `unknown`/sustituida en este dataset |
| Conciliación (sólo lectura) | ✅ — pantalla no escribe nada, mensaje explícito |
| Historial de importaciones (`ctx.api.storage`) | ✅ |

No se ejercitó en este smoke un avance en efectivo ni multi-moneda cruzada
(quedan cubiertos por los 1285 tests unitarios/integración, no repetidos aquí a
propósito). Datos sintéticos y contenedor eliminados por completo al terminar;
la instancia de validación 3.7.0 nunca se tocó.

### Validación autenticada contra host real (2026-09-09, Wealthfolio 3.7.0)

El fix de `INTEREST` en cuenta `CREDIT_CARD` (tres rondas TDD, ver
[UPSTREAM.md](UPSTREAM.md) § *Semántica financiera del host*) se había
verificado con tests unitarios y contra el smoke 3.8 efímero **sin
autenticación**, pero nunca a través del login real. Cerrado contra la
instancia persistente (`infra/compose.yml`, `WF_AUTH_REQUIRED=true`), con el
addon redeployado desde el working tree actual (el `dist/addon.js` instalado
estaba desactualizado — compilado el día anterior, sin el fix).

Importada `banco-chile-tarjeta.csv` a `CMR Test` por el wizard real: 7/7
movimientos creados, 0 fallidos. `INTERESES POR MORA` entra como `Interés`,
monto negativo, categoría *Deudas y créditos*. Panel Chile de febrero 2026:
gasto neto `$323.710`, exactamente `262.070` (cuenta corriente) `+ 73.940`
(los 7 movimientos de tarjeta, interés incluido) `− 12.300` (devolución) — el
interés cuenta como gasto, no como ingreso, contra el host real autenticado.
Detalle completo en [HOST_VALIDATION.md](HOST_VALIDATION.md) § *Sesión 5*.

Limpieza incompleta: 6 de las 7 actividades sintéticas creadas para esta
prueba siguen en `CMR Test` en la instancia persistente (bloqueo del
clasificador de acciones del harness sobre borrados repetidos). Sin impacto
financiero real — son datos sintéticos — pero pendiente de borrado manual.

### Calibración BancoEstado XLSX sintético contra host real (2026-09-10, Wealthfolio 3.7.0)

Parser `banco-estado.cuenta` v0.2.0 verificado contra la instancia persistente
3.7.0 con un fixture sintético de forma idéntica a la primera cartola XLSX real
observada (CuentaRUT, calibración 2026-09). Los datos son sintéticos; el perfil
sigue `pending-real-sample`.

| Qué | Observado |
| --- | --- |
| Detección de banco | BancoEstado — 100 % |
| Período `01/09/2025 → 24/09/2025` | declarado via `Fecha Inicio`/`Fecha Termino`; detectado |
| 6 filas `dd/mmm` sin año | fechas civiles correctas, año inferido del período |
| Cargos con coma miles (`12,450`) | leídos como `12.450 CLP`, no como `12,45` |
| Saldo con punto miles (mismo XLSX) | recorrido sin desajuste, balance `150.000 → 155.450` |
| Import + cleanup | 6 creados / 0 fallidos; eliminados; búsqueda post-cleanup: 0 |
| CSV con coma ambigua | `statement-invalid`; wizard bloqueó; cero escrituras |

El comportamiento fecha-en-tabla del host (UTC midnight vs. zona horaria del
navegador) investigado y confirmado como propiedad del host, no del parser.
Ver [HOST_VALIDATION.md](HOST_VALIDATION.md) § *Sesión 6*.

---

## Madurez por institución

| Institución / perfil | Parser | Fixture sintético | Test que lo parsea | Validado en host | Cartola real |
| --- | --- | --- | --- | --- | --- |
| Genérico — cuenta | ✅ | n/a | ✅ | ✅ (indirecto) | n/a |
| Genérico — tarjeta | ✅ | n/a | ✅ | ⬜ | n/a |
| Banco de Chile — cuenta corriente | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Banco de Chile — tarjeta | ✅ | ✅ | ✅ | ⬜ | ⬜ |
| BancoEstado — CuentaRUT | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Falabella / CMR — tarjeta | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Falabella — cuenta corriente | ✅ | ✅ | ✅ | ⬜ | ⬜ |

`samples/private/` está vacío (gitignorado, nunca versionado). **Ninguna
institución tiene validación de `kind` con cartola real**, y los cinco
perfiles bancarios siguen `pending-real-sample` en ese eje: el wizard lo
advierte y el historial lo registra. Ver [BANK_FORMATS.md](BANK_FORMATS.md).

### Calibración estructural contra cartolas reales (2026-09)

Distinto del eje anterior: el calibrador (`pnpm calibrate`) corrió contra
cartolas reales privadas fuera de Git, sin escribir nada al host y sin
exponer glosas. Confirma estructura/formato/signo/detección, no `kind`.

| Banco / producto | Calibración estructural real | Notas |
| --- | --- | --- |
| BancoEstado CuentaRUT | ✅ XLSX real | fechas sin año, coma/punto de miles |
| Banco de Chile cuenta corriente | ✅ XLS real | período vía SALDO INICIAL/FINAL, canal/sucursal |
| Banco de Chile tarjeta — Nacional | ✅ XLS real | formato numérico por celda, write boundary y dedupe endurecidos |
| Banco de Chile tarjeta — Internacional | 🚫 **no soportado** | detección fail-closed; tablas internacionales bloqueadas explícitamente, no importadas |
| Falabella/CMR — Movimientos Facturados | ✅ XLSX real | `PAGO TARJETA` separado de gasto; cuotas vía `VALOR CUOTA`; `CUOTAS PENDIENTES` como remaining count |
| Falabella/CMR — PDF | ⚠️ sólo evidencia del calibrador, **no importable** esta tranche | `pdf-lib`/`pdfjs-dist` son devDependency, nunca entran a `dist/addon.js` |
| Falabella — cuenta corriente | ⬜ sin muestra real | sigue `pending-real-sample` |

Ninguna cartola real fue importada al host: la calibración corre fuera del
addon, y la validación contra el host (arriba en este documento) sigue
usando fixtures sintéticos con forma idéntica a lo observado.

---

## Qué decide el import antes de escribir

Tres gates independientes, y los tres se acumulan en vez de reportarse de a uno:

1. **La cartola se leyó entera.** Una fila que debía ser un movimiento y no se
   pudo leer bloquea la importación. Importar el subconjunto legible deja un
   hueco que después parece completo. `rowStats` cuenta filas de datos,
   mapeadas, omitidas y fallidas por separado, y el resumen las reporta tal
   cual.
2. **Se pudo comprobar si hay duplicados.** Si la lectura de los movimientos ya
   registrados falla o queda truncada, importar queda deshabilitado: «no se pudo
   comprobar» y «no hay duplicados» son respuestas distintas.
3. **La cartola corresponde a la cuenta.** Moneda distinta, número de cuenta
   distinto o una cuenta de instrumentos bloquean. Una cuenta sin número
   registrado no bloquea: se informa que no se pudo verificar.

Una celda de monto que no se puede leer es un **error de fila**, no una celda
vacía. `parseAmount` se niega a representar un monto que no cabe exactamente en
vez de redondearlo, y esa negativa se leía como «aquí no hay nada»: la fila se
contaba como omitida a propósito y el movimiento desaparecía sin que la
validación se enterara.

El recorrido de saldos es evidencia, no dogma. Un desajuste aislado es error
sólo en un perfil que declara su columna de saldo `authoritative` —hoy ninguno
de los bancarios, porque nadie ha visto una exportación real—. Un desajuste
**sistemático** (≥50 % de los pasos, con un mínimo de 4) es error en cualquier
perfil: a esa proporción no es una rareza del banco, es que el archivo se está
leyendo mal.

---

## Wealthfolio es la fuente de verdad

El addon escribe metadata en cada actividad que crea. Desde el esquema 3 esa
metadata incluye `proj`, un hash de la actividad tal como se escribió, así que
una relectura puede distinguir «esto sigue siendo lo que creamos» de «el usuario
lo cambió y nuestra huella describe algo que ya no está».

- Un duplicado exacto contra una actividad editada baja a **probable**, con el
  motivo escrito en la fila. Saltarla en silencio perdería el movimiento
  original; importarla pondría una copia al lado de la editada.
- Al releer, el **tipo de actividad del host manda**. La clasificación cacheada
  sobrevive sólo mientras siga correspondiendo al tipo que el host realmente
  tiene, lo que conserva las distinciones que nuestro modelo hace y el tipo del
  host no puede expresar, y descarta sólo el desacuerdo real.
- Las filas escritas por 0.1.x no traen `proj`; para ellas la pregunta cae en
  `isUserModified`, que es el propio registro del host.

---

## Semántica del panel

Flujo de caja y gasto son preguntas distintas y se reportan por separado:

```
compra 100.000, devolución 20.000

caja    → entró 20.000, salió 100.000, neto −80.000
gasto   → bruto 100.000, devoluciones 20.000, neto 80.000
```

`income` significa dinero externo que entra; una devolución **no** es ingreso.
La tasa de ahorro es `(income − netSpending) / income`. Las categorías reportan
bruto, devoluciones y neto, y una devolución sin categoría no se atribuye a
ninguna.

Con más de una moneda en el mes el panel muestra un bloque por moneda y dice por
qué no las suma: `ExchangeRatesAPI` no publica tipos históricos, y convertir un
movimiento de hace ocho meses al tipo de hoy sería un número inventado más
difícil de detectar que el error que reemplaza.

---

## Conciliación

El motor empareja transferencias entre cuentas propias y pagos de tarjeta. Un
par se acepta sólo cuando la elección es **mutua** y las rondas se repiten hasta
que una no resuelve nada nuevo, porque las preferencias cambian a medida que se
consumen tramos. Lo que queda es un nudo genuino y se reporta una vez, con todos
sus tramos y sin proponer ninguno.

Hay una pantalla de revisión (`/addons/wealthfolio-chile/conciliacion`) que
distingue confirmados, sugeridos y sin decidir, con la evidencia de cada uno.
**Es de sólo lectura**: Wealthfolio no expone todavía a los addons una forma de
enlazar los dos tramos, y construir un ledger de pares propio es justo lo que
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) descarta.

---

## No funciona / no está hecho

| Qué | Por qué |
| --- | --- |
| **Perfiles bancarios validados** | No hay cartolas reales. Los cinco perfiles bancarios siguen `pending-real-sample` |
| **Aplicar una conciliación** | El SDK sigue sin exponer `link`/`transfer-pair`, tampoco en 3.8. Ver ADR 0005 |
| **Conversión de moneda** | 3.8 publicó `ExchangeRatesAPI.getRatesForDates` (histórico real); evaluado y diferido a propósito — ver [UPSTREAM.md](UPSTREAM.md) § *veredicto de APIs nuevas* |
| **Servicio importador, IA/MCP propio, Fintoc** | Decisiones D10-D12; ver [DECISIONS.md](DECISIONS.md) |
| **Licencia** | Decisión pendiente del propietario. Todo declara `UNLICENSED` |

---

## Siguiente paso recomendado

Calibrar los perfiles con cartolas reales privadas, siguiendo
[BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*. Es lo único que
separa este release candidate de un `0.2.0`.

Para CMR sigue abierta la pregunta que decide todo el cálculo de deuda
comprometida: si una columna `Monto` sin etiquetar es el valor de la cuota o el
total de la compra. Mientras no haya evidencia, la fila se marca
`ambiguous-installment-amount` y el plan no deriva el total de la compra.
