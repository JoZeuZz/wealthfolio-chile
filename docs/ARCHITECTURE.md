# Arquitectura

## Idea central

Wealthfolio Chile es un **addon** de Wealthfolio, no un fork. Todo lo específico
de Chile vive en este repositorio y se comunica con el host solo por APIs
soportadas.

```
┌─────────────────────────────────────────────────────────────┐
│                    Wealthfolio (host)                       │
│   cuentas · actividades · patrimonio · inversiones          │
└───────────────────────────┬─────────────────────────────────┘
                            │  Addon SDK 3.8.0 (mínimo host 3.7.0)
                            │  (iframe sandbox, allow-scripts)
┌───────────────────────────▼─────────────────────────────────┐
│                    Wealthfolio Chile                        │
│                                                             │
│   ui/         páginas React (panel · wizard · historial)    │
│   services/   lo único que habla con ctx.api                │
│   core/       motor determinista — TS puro, sin SDK ni DOM   │
└─────────────────────────────────────────────────────────────┘
```

La regla que ordena todo: **`core/` no importa nada del SDK ni toca el DOM.**
Solo `core/mapping/activities.ts` importa tipos del SDK, y únicamente como
`import type` (desaparece en compilación). Por eso el motor se testea en Node,
sin navegador ni mocks, y puede reutilizarse tal cual desde un servicio externo
el día que haga falta.

---

## El pipeline de importación

```
archivo (bytes)
    │
    ▼  core/parsing/workbook.ts
detectar formato por magic bytes → decodificar (UTF-8 / Windows-1252)
    │
    ▼  core/parsing/tabular.ts
Sheet: grilla rectangular de strings
    │
    ▼  core/parsing/columns.ts
encontrar cabecera → mapear columnas a roles semánticos
    │
    ▼  core/providers/*.ts
elegir parser (detección con evidencia estructural + léxica)
    │
    ▼  core/parsing/rows.ts
NormalizedTransaction[]  ← el modelo canónico
    │
    ▼  core/dedupe/fingerprint.ts
huella determinista por movimiento
    │
    ▼  core/rules/engine.ts
normalizar comercio → aplicar reglas → categoría, tipo, tags
    │
    ▼  core/dedupe/classify.ts
exacto / probable / nuevo
    │
    ▼  core/installments/plans.ts
reconstruir compras en cuotas
    │
    ▼  VISTA PREVIA  ← el usuario decide, nada se ha escrito aún
    │
    ▼  core/mapping/activities.ts
ActivityCreate[] con nuestra metadata
    │
    ▼  services/import-runner.ts
ctx.api.activities.saveMany({ creates })
```

Detalle completo en [IMPORT_PIPELINE.md](IMPORT_PIPELINE.md).

---

## Módulos

### `core/` — motor determinista

| Módulo | Responsabilidad |
| --- | --- |
| `money.ts` | Aritmética exacta. Enteros de unidades menores + escala; nunca floats |
| `dates.ts` | Fechas civiles sobre strings `YYYY-MM-DD`; nunca `Date` con zona horaria |
| `text.ts` | Normalización de descripciones — la forma que comparan todos los matchers |
| `hash.ts` | SHA-256 propio, síncrono, idéntico en navegador y Node |
| `privacy.ts` | Enmascarado, redacción y saneado de nombres de archivo; envoltorio del logger |
| `accounts/` | Compara la cartola con la cuenta de destino antes de escribir |
| `classify/` | Qué significa un movimiento de tarjeta. Vocabulario chileno en un solo lugar |
| `model/` | El modelo canónico: `TransactionKind`, `NormalizedTransaction`, `ParsedStatement`, `InstallmentPlan` |
| `parsing/` | Lectores de archivo, detección de cabecera, mapeo de filas, orden de campos de fecha |
| `providers/` | Un perfil declarativo por banco + el motor genérico que los ejecuta |
| `dedupe/` | Huellas e idempotencia |
| `reconcile/` | Transferencias internas y pagos de tarjeta |
| `merchants/` | Extracción de comercio desde el ruido del adquirente |
| `categories/` | Árbol de categorías por defecto |
| `rules/` | Motor de reglas condición→acción + reglas predefinidas |
| `installments/` | Detección de cuotas y reconstrucción de planes |
| `metrics/` | Agregados mensuales por moneda: caja y gasto por separado, categorías, comercios, recurrentes |
| `insights/` | Frases deterministas a partir de esos agregados |
| `mapping/` | Traducción al modelo de actividades de Wealthfolio |
| `pipeline.ts` | Orquestador puro de todo lo anterior |

### `services/` — frontera con el host

| Módulo | Responsabilidad |
| --- | --- |
| `storage.ts` | Persistencia tipada sobre `ctx.api.storage`, con listas particionadas |
| `activity-index.ts` | Reconstruye el índice de duplicados desde las actividades del host |
| `imported-transactions.ts` | Relee como transacciones canónicas lo que el addon escribió |
| `import-preparation.ts` | Une host y pipeline puro; decide si importar es seguro |
| `import-history.ts` | Registro de importaciones |
| `import-runner.ts` | **Lo único que escribe** en el ledger del usuario |
| `reconciliation.ts` | Fachada de orquestación para la conciliación multi-cuenta |
| `settings.ts` | Preferencias y conjunto efectivo de reglas |

### `ui/` — React

Páginas: panel (`/addons/wealthfolio-chile`), wizard (`…/importar`), historial
(`…/importaciones`) y conciliación (`…/conciliacion`). Componentes de
`@wealthfolio/ui`, provistos por el host.

La página de conciliación es de **sólo lectura** por una razón de contrato, no
de alcance: aplicar un par exige enlazar dos actividades, y el Addon SDK 3.8.0
no lo expone. Ver [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md).

---

## Conciliación multi-cuenta: dónde entra el host

Los matchers de `core/reconcile/` son puros y están testeados, pero necesitan
movimientos de **varias cuentas a la vez**. `prepareImport()` ve un archivo y una
cuenta, así que meterle `ctx.api` no sólo rompería su pureza: seguiría sin tener
los datos. La fachada existe precisamente para que esa tentación no aparezca.

```
actividades del host                    ctx.api.activities.search
        │
        ▼   services/imported-transactions.ts
ScopedTransaction[]                     { accountId, transaction }
        │
        ▼   services/reconciliation.ts   ← la única capa impura
matchTransfers() / matchCardPayments()  puros, sin host ni storage
        │
        ▼
ReconciliationResult                    candidatos, nunca decisiones
```

Tres reglas que este diagrama fija:

1. **`core/` no importa `AddonContext`.** La única excepción es
   `core/mapping/activities.ts`, y sólo con `import type`, que desaparece al
   compilar.
2. **`prepareImport()` sigue siendo puro.** Recibe un índice de duplicados; no
   sabe cómo obtenerlo.
3. **La fachada no decide nada.** Aplicar un emparejamiento reclasifica ambas
   patas, y eso es una acción del usuario. `reconcileWindow()` sólo calcula
   candidatos, y marca `truncated` cuando la lectura quedó corta — una vista
   parcial puede emparejar las dos patas equivocadas.

**Lo que falta** es la pantalla de revisión y persistir las decisiones en
`StorageKeys.transferDecisions`. Hasta entonces la conciliación multi-cuenta está
*implementada* pero no *integrada*: al importar sólo se clasifica lo que la glosa
identifica por sí sola.

---

## Decisiones que sostienen el diseño

### 1. El dinero nunca es un float

`Money = { minor, scale, currency }`. `$1.234,56` es
`{ minor: 123456, scale: 2 }`. La escala se guarda **por valor**, no por moneda,
porque los bancos chilenos exportan la misma cuenta CLP como `1.234` en un
reporte y `1.234,00` en otro. Sumar valores de distinta escala los alinea al
mayor; reducir escala perdiendo precisión lanza excepción en vez de redondear en
silencio.

### 2. Las fechas son días del calendario, no instantes

Todo opera sobre `YYYY-MM-DD` y aritmética entera (algoritmo `days_from_civil`).
Una compra del 03/02/2026 es ese día en Chile, corra la app donde corra. Con
`new Date()` una máquina en UTC+13 movería movimientos al mes anterior.

### 3. Un adaptador de banco es datos, no código

Añadir un banco es escribir un `StatementProfile`: sinónimos de columnas,
convención de signo, formato numérico, producto. El algoritmo es uno solo y está
testeado. Por eso los tres bancos chilenos están implementados **antes** de
tener una cartola real: calibrarlos es editar strings.

### 4. Vista previa antes de escribir

`prepareImport()` es puro y no escribe nada. `runImport()` es la única función
que muta, y solo con las filas que el usuario dejó marcadas.

### 5. La identidad vive en Wealthfolio, no en un registro paralelo

La huella de cada movimiento se escribe en `metadata` de la actividad y se lee
de vuelta al buscar. Un ledger paralelo en `storage` se desincronizaría en
cuanto el usuario borrara una actividad a mano, y el addon se negaría a
reimportar un movimiento que ya no existe.

### 6. Caja y gasto son dos preguntas

Una compra de $100.000 con una devolución de $20.000 tiene dos lecturas
correctas y distintas: en caja entraron 20.000 y salieron 100.000; en gasto el
bruto fue 100.000, la devolución 20.000 y el neto 80.000. Reportar una cifra
llamada «ingresos» y otra llamada «egresos» metía la devolución en los ingresos
y hacía que la tasa de ahorro saliera −400 %. `MonthlySummary` lleva las dos
vistas con nombres que no se pueden confundir. Ver
[ADR 0006](adr/0006-caja-y-gasto.md).

El consumo es un subconjunto directo: compras y servicios. Intereses,
comisiones e impuestos pueden seguir formando parte del gasto, pero no del
consumo. El principal de un avance en efectivo no pertenece a ninguno de los
dos: crea deuda y entrega liquidez, y se muestra como financiamiento separado
sin inventar una cuenta destino ni otra Activity.

### 7. Nada infla ingresos ni gastos

`internal_transfer` y `credit_card_payment` están excluidos por construcción de
todo agregado de ingreso y gasto — en `core/metrics`, en los totales de la vista
previa, y en el mapeo a Wealthfolio (van como `TRANSFER_*`, que netea a cero a
nivel de portafolio).

### 8. Determinista primero, IA después

Reglas y parsers antes que modelos. Las frases del panel son aritmética con
plantilla fija. Un número plausible pero incorrecto es peor que ninguna frase.

---

## Despliegue

```
Proxmox
└── LXC / VM con Docker
    └── docker compose (infra/compose.yml)
        └── wealthfolio/wealthfolio:3.8.0  # host persistente de pruebas; minWealthfolioVersion sigue 3.7.0
            ├── volumen wealthfolio-data → /data (SQLite)
            └── bind mount              → /data/addons
                └── wealthfolio-chile/
                    ├── manifest.json
                    └── dist/addon.js
```

- Versión de imagen **fijada**, nunca `latest`.
- Escucha en loopback por defecto; TLS mediante proxy inverso.
- Contenedor `read_only`, `no-new-privileges`, usuario no root (UID 1000).
- Healthcheck contra `/api/v1/healthz`.
- Respaldo y restauración documentados y con script.

---

## Qué haría falta para justificar un fork

Nada de lo encontrado hasta ahora lo justifica. Los criterios están en
[DECISIONS.md](DECISIONS.md) y cualquier cambio al core exige antes un ADR en
`docs/adr/`.
