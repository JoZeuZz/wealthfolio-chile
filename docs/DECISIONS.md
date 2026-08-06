# Decisiones

Resumen de las decisiones que dieron forma al proyecto. Las que necesitan
justificación larga tienen su propio ADR en [`adr/`](adr/).

---

## D1 — Addon, no fork

**Decisión.** Construir sobre el Addon SDK 3.6.2. No tocar el core.

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

**Decisión.** No se ha elegido licencia para este repositorio.

**Por qué.** Es una decisión consciente que corresponde al autor, no un
descuido. Nota relevante: el core de Wealthfolio es AGPL-3.0, pero los paquetes
que consumimos (`@wealthfolio/addon-sdk`, `@wealthfolio/ui`) son MIT, y no
copiamos código de upstream. Ver
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
