# Decisiones

Resumen de las decisiones que dieron forma al proyecto. Las que necesitan
justificación larga tienen su propio ADR en [`adr/`](adr/).

---

## D1 — Addon, no fork

**Decisión.** Construir sobre el Addon SDK (3.6.2 al decidirlo, 3.7.0 hoy). No tocar el core.

**Por qué.** Todo lo que necesita el MVP es alcanzable: crear actividades
(`activities.saveMany`), leerlas (`activities.search`), persistir estado propio
(`ctx.api.storage`) y contribuir páginas y navegación. Un fork nos costaría
mantener sincronía con un proyecto que publica releases cada pocas semanas, a
cambio de nada que hoy nos falte.

**Cuándo revisarlo.** Ver [ADR 0001](adr/0001-addon-sobre-fork.md) para los
criterios concretos que justificarían un fork, y el proceso obligatorio antes de
tocar upstream.

---

## D2 — El dinero es entero, nunca float

**Decisión.** `Money = { minor, scale, currency }` con enteros de unidades
menores y escala por valor.

**Por qué.** `0.1 + 0.2 !== 0.3`. En una herramienta de finanzas eso no es una
curiosidad, es un saldo mal calculado. La escala se guarda por valor porque los
bancos chilenos exportan la misma cuenta CLP como `1.234` en un reporte y
`1.234,00` en otro; fijar la escala por moneda inventaría o descartaría
precisión al ida y vuelta.

**Costo.** Sumar valores de distinta escala requiere alinearlos. Es explícito y
está testeado.

---

## D3 — Las fechas son civiles, no instantes

**Decisión.** Todo sobre strings `YYYY-MM-DD` y aritmética entera. Nunca `Date`
para lógica de negocio.

**Por qué.** Una compra del 03/02/2026 es ese día en Chile, corra la app donde
corra. `new Date('2026-02-01')` en UTC+13 reporta el 31 de enero, y con eso el
movimiento cae en el mes anterior y todos los agregados mensuales quedan mal.

---

## D4 — Un banco es un perfil declarativo

**Decisión.** `StatementProfile` con sinónimos de columnas, convención de signo,
formato numérico y producto. Un solo algoritmo los ejecuta a todos.

**Por qué.** Permite implementar los tres bancos prioritarios **antes** de tener
una cartola real, y que calibrarlos después sea editar strings en vez de
escribir un parser. También hace que un arreglo en el manejo de fechas o de
signos llegue a todos los bancos a la vez.

---

## D5 — Vista previa obligatoria

**Decisión.** `prepareImport()` es puro y no escribe nada. `runImport()` es la
única función que muta, y solo con las filas marcadas por el usuario.

**Por qué.** Los perfiles bancarios están sin validar. Escribir sin revisión
convertiría un error de mapeo en cientos de movimientos incorrectos en el ledger
del usuario.

---

## D6 — La identidad vive en Wealthfolio

**Decisión.** La huella de cada movimiento se escribe en `metadata` de la
actividad. El índice de duplicados se reconstruye leyendo esas actividades.

**Por qué.** Un registro paralelo en `ctx.api.storage` se desincronizaría en
cuanto el usuario borrara una actividad a mano: el addon se negaría a reimportar
un movimiento que ya no existe. La única fuente de verdad tiene que ser la misma
que el usuario ve.

**Habilitado por.** `ActivityCreate.metadata` acepta JSON arbitrario y
`ActivityDetails.metadata` lo devuelve al buscar. Por eso importamos con
`saveMany`, no con `activities.import()` — `ActivityImport` no tiene campo
`metadata`.

---

## D7 — Categorización propia, no la del core

**Decisión.** Motor de reglas y árbol de categorías propios, en el addon.

**Por qué.** El core **sí** tiene un subsistema `spending` con reglas de
categorización, presupuestos y merchants (`crates/storage-sqlite/src/spending/`),
pero **no está expuesto al SDK de addons**. No hay `ctx.api.spending`.

Ver [ADR 0003](adr/0003-categorizacion-propia.md), que también registra qué
API upstream pediríamos para poder eliminar esta duplicación.

---

## D8 — El archivo entra por el DOM

**Decisión.** `<input type="file">` + `File.arrayBuffer()` dentro del iframe.

**Por qué.** No existe API para leer un archivo: `files.openCsvDialog()`
devuelve una ruta en escritorio y `null` en web, y no hay `readFile`.

**Efecto lateral bueno.** Los bytes nunca salen del sandbox y el addon no
declara el permiso `files`.

---

## D9 — SheetJS desde su CDN, no desde npm

**Decisión.** `xlsx` desde `https://cdn.sheetjs.com/xlsx-0.20.3/`.

**Por qué.** El paquete `xlsx` de npm está congelado en 0.18.5 con advisories
abiertos. SheetJS distribuye las versiones actuales por su propio CDN. Además
0.20.3 lee `.xls` BIFF heredado, que es lo que hace posible aceptar ese formato
de forma responsable.

Ver [ADR 0004](adr/0004-libreria-planillas.md) para las alternativas evaluadas
y el costo (CI necesita alcanzar ese host).

---

## D10 — Determinista primero, IA después

**Decisión.** Reglas y parsers antes que modelos. Las frases del panel son
aritmética con plantilla fija.

**Por qué.** Un número plausible pero incorrecto es peor que ninguna frase. La
IA entra cuando las métricas base sean confiables, y aun entonces no decide
saldos ni aritmética.

---

## D11 — Sin servicio externo todavía

**Decisión.** `services/importer/` no se implementa aún.

**Por qué.** Un servicio externo no puede insertar actividades: no hay API de
escritura fuera del addon, y escribir SQLite directamente está descartado. Lo
único que aportaría hoy es una cola de archivos pre-procesados, y eso no
justifica un contenedor más antes de que los perfiles bancarios estén validados.

Cuando se haga, procesará y encolará; el addon confirmará vía las APIs oficiales.

---

## D12 — Sin servidor MCP propio

**Decisión.** No construir uno.

**Por qué.** Wealthfolio ya trae MCP (`apps/server/src/mcp/`), activable con
`WF_MCP_ENABLED=true`. Duplicarlo sería trabajo sin beneficio.

**Limitación conocida.** Ese MCP expone las actividades del core; nuestros datos
propios (planes de cuotas, historial) viven en `ctx.api.storage` y no son
accesibles. Antes de construir nada hay que documentar un caso de uso real que
esa limitación bloquee.

---

## D13 — Sin licencia propia todavía

**Decisión.** No se ha elegido licencia para este repositorio. Mientras eso siga
así, el marcador en todas partes es `UNLICENSED`.

**Por qué.** Es una decisión consciente que corresponde al autor, no un
descuido. Nota relevante: el core de Wealthfolio es AGPL-3.0, pero los paquetes
que consumimos (`@wealthfolio/addon-sdk`, `@wealthfolio/ui`) son MIT, y no
copiamos código de upstream. Ver
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**Corrección (2026-08-06).** `addon/package.json` y `addon/manifest.json`
declaraban `MIT`, lo que contradecía esta decisión y el README. No existe en el
repositorio ninguna decisión explícita de licenciar bajo MIT: D13 dice lo
contrario. Se cambiaron ambos a `UNLICENSED` en vez de crear un `LICENSE`,
porque elegir una licencia no es una corrección de consistencia — es una
decisión del propietario del proyecto.

**Pendiente para el propietario.** Elegir entre:

| Opción | Consecuencia |
| --- | --- |
| MIT / Apache-2.0 | Cualquiera puede usar y redistribuir el addon |
| AGPL-3.0 | Alineado con el core de Wealthfolio; obliga a compartir modificaciones |
| Propietario / privado | Se queda como está: `UNLICENSED`, sin publicación |

Hasta que se decida, el repositorio no debe publicarse: sin licencia, nadie
—incluido el autor a futuro— tiene permisos claros sobre el código.

---

## D14 — `unknown` sigue viniendo marcado en la vista previa — pendiente

**Estado.** Sin decidir. Requiere una decisión explícita del propietario.

**Cómo está hoy.** Una fila que el clasificador no supo leer
(`TransactionKind.unknown`) llega a la vista previa **marcada para importar**,
igual que cualquier otra. El usuario la ve, la cuenta «Requieren revisión» la
suma, y si no la desmarca se escribe como `UNKNOWN` en Wealthfolio.

**Por qué se mantuvo así en la estabilización de 0.1.1.** El defecto que se
corrigió fue que el mapping de `UNKNOWN` no era reversible —ver
[IMPORT_PIPELINE.md](IMPORT_PIPELINE.md) § *`dir`*—, no la política de selección.
Cambiar en silencio qué filas vienen marcadas altera lo que un usuario importa
sin que él lo pida, y eso no es una corrección: es una decisión de producto.

**Propuesta a evaluar.** Que `unknown` venga **desmarcado por defecto**, con la
misma mecánica que ya tienen los duplicados probables: visible, contado, y
re-marcable con un clic.

| | A favor | En contra |
| --- | --- | --- |
| Desmarcado por defecto | El usuario sólo escribe lo que entendió; `UNKNOWN` en Wealthfolio queda fuera de todo cálculo, así que omitirlo no distorsiona nada | Un banco mal calibrado puede producir muchas filas `unknown`: el usuario importaría una fracción de su cartola sin notarlo |
| Marcado (hoy) | La cartola entra completa; nada se pierde en silencio | Se escriben filas que nadie clasificó, y el costo de sacarlas después es manual |

**Qué falta para decidir.** Saber qué proporción de filas queda `unknown` con
cartolas reales. Con perfiles bancarios todavía `pending-real-sample` ese número
no existe, y sin él la comparación de arriba es especulación. Revisar después de
[HOST_VALIDATION.md](HOST_VALIDATION.md) y de la calibración con cartolas reales.

---

## D15 — Flujo de caja y gasto se reportan por separado

**Decisión.** `MonthlySummary` lleva dos vistas con nombres que no se pueden
confundir: `cashInflows`/`cashOutflows`/`netCashFlow` y
`grossSpending`/`refunds`/`netSpending`. `expenses` y `net` se eliminaron.

**Por qué.** Con una compra de $100.000 y una devolución de $20.000, la tasa de
ahorro salía **−400 %**: la devolución entraba en `income` porque `isIncome()`
responde «¿esto sube la caja?», y sube. Ver
[ADR 0006](adr/0006-caja-y-gasto.md).

---

## D16 — El orden de los campos de una fecha lo decide el archivo, no el perfil

**Decisión.** Cuando una fila prueba el orden —un campo mayor que 12— ese orden
gana al que declara el perfil, y sólo votan las filas que se convertirán en
movimientos. Cuando nada lo prueba, se usa el del perfil y se advierte **una
vez**, no por fila.

**Por qué.** La advertencia por fila disparaba en cerca de la mitad de una
cartola real, y una marca que aparece en la mitad de las filas deja de leerse.
Y al revés: un banco que exporte `MM/DD` contra un perfil `DMY` producía fechas
corridas en silencio, con huella distinta y gasto en el mes equivocado.

---

## D17 — La conciliación se revisa, no se aplica

**Decisión.** La pantalla de conciliación muestra pares confirmados, sugeridos y
nudos sin decidir, con su evidencia, y **no escribe nada**.

**Por qué.** Aplicar un par exige reescribir dos actividades y registrar la
contraparte en su metadata, y el Addon SDK 3.7.0 no expone `activities/link` ni
`transfer-pair` — verificado contra el paquete publicado y contra el puente del
sandbox, no de memoria. Construir un ledger de pares propio para tapar ese hueco
es exactamente lo que descarta
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md), porque habría que
migrarlo el día que upstream exponga el real.

**Qué falta para cambiarla.** Que el SDK exponga el enlace. La frontera está en
`services/reconciliation.ts`.

---

## D18 — Sustituir el tipo de actividad antes que perder la importación

**Decisión.** En una cuenta `CREDIT_CARD`, un tipo que Wealthfolio no acepta se
sustituye por el permitido más cercano, y la metadata registra `subst` para que
una relectura no lo confunda con una reclasificación del usuario.

**Por qué.** Wealthfolio rechaza `UNKNOWN` en una cuenta de tarjeta y `saveMany`
rechaza el lote entero con él: un abono sin clasificar costaba los cinco
movimientos del estado de cuenta. Ver
[HOST_VALIDATION.md](HOST_VALIDATION.md) § *Sesión 2*.

**Por qué no es mentir.** `CREDIT` sin subtipo es el vocabulario del propio host
para «entró dinero, sin especificar», que es exactamente lo que se sabe de ese
abono. Lo que la sustitución no puede hacer es borrar lo que sí se sabía, y por
eso `metadata.kind` conserva la clasificación real.

**Alternativa descartada.** No escribir esas filas. Habría dejado el movimiento
fuera de la contabilidad, que es el problema que este proyecto lleva toda la
corrida evitando.
