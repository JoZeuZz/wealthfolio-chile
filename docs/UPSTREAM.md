# Upstream — Wealthfolio

Qué versión de Wealthfolio usamos, qué nos ofrece su SDK de addons y cómo
actualizamos.

Investigado el **2026-08-05** contra el código real del repositorio, no contra
documentación de terceros.

---

## Versión de referencia

| Dato | Valor |
| --- | --- |
| Repositorio | `wealthfolio/wealthfolio` |
| Release estable | **v3.6.2** (2026-07-13) |
| Licencia del core | **AGPL-3.0** |
| Licencia de `@wealthfolio/addon-sdk` | **MIT** |
| Licencia de `@wealthfolio/ui` | **MIT** |
| SDK usado | `@wealthfolio/addon-sdk@3.6.2` |
| Node de upstream | 24 (`.node-version`) |
| Gestor de paquetes | `pnpm@10.33.4` |
| Imagen Docker | `wealthfolio/wealthfolio:v3.6.2` (multi-arch amd64/arm64) |
| Checkout local | `.upstream/wealthfolio` (ignorado por Git) |

Wealthfolio es Tauri + React + Rust. El backend vive en `crates/`, el frontend
en `apps/frontend`, el servidor web en `apps/server` y los paquetes públicos en
`packages/` (`addon-sdk`, `ui`, `addon-dev-tools`).

---

## Cómo funciona un addon (v3.6)

Un addon es un módulo ES que exporta una función `enable(ctx)`. Lo relevante
para nuestro diseño:

### Aislamiento

El host monta cada addon en un **iframe con `sandbox="allow-scripts"`**
(`apps/frontend/src/addons/iframe/addon-iframe-manager.ts:432`). Sin
`allow-same-origin`, el origen es opaco. Consecuencias directas:

- `localStorage` y `sessionStorage` **lanzan excepción**. La única persistencia
  es `ctx.api.storage` (SQLite en el host, ~250 KB por valor, replicado entre
  dispositivos emparejados).
- No hay `react-router` dentro del sandbox: la ruta llega como prop `location`.
- El host es dueño del root de React. Un `createRoot` propio deja el árbol
  huérfano.

### Activación diferida

Las rutas y el ítem de la barra lateral se declaran en `manifest.json`
(`contributes.routes` + `contributes.links`). El host los lee y dibuja la
navegación **sin ejecutar código del addon**; `enable()` corre la primera vez
que se visita una ruta. El `id` que se pasa a `ctx.router.add()` debe coincidir
exactamente con el declarado, o la página queda en blanco.

### APIs disponibles

`ctx.api` expone: `accounts`, `portfolio`, `activities`, `market`, `assets`,
`quotes`, `performance`, `exchangeRates`, `contributionLimits`, `goals`,
`settings`, `files`, `snapshots`, `secrets`, `storage`, `logger`, `events`,
`navigation`, `query`, `network`, `toast`.

`query`, `storage`, `toast` y `logger` son capacidades base: no se declaran como
permisos.

### Lo que sí podemos hacer

- **Crear actividades**: `activities.saveMany({ creates })` y
  `activities.import()`. Usamos `saveMany` porque `ActivityCreate` acepta un
  campo `metadata` con JSON arbitrario que `ActivityDetails` devuelve al
  buscar — ese ida y vuelta es la base de nuestra idempotencia.
- **Leer movimientos** con `activities.search()` paginado y filtrado.
- **Persistir estado propio** en `ctx.api.storage`.
- **Guardar secretos** cifrados en `ctx.api.secrets` (para Fintoc, más adelante).
- **Red saliente** vía `ctx.api.network.request`, restringida a hosts declarados
  en el manifiesto.

### Lo que NO podemos hacer (limitaciones reales encontradas)

| Limitación | Evidencia | Cómo la sorteamos |
| --- | --- | --- |
| **No hay API para leer un archivo del disco.** `files.openCsvDialog()` devuelve una *ruta* en escritorio y `null` en web (`apps/frontend/src/adapters/web/files.ts:7`). No existe `readFile`. | Verificado en ambos adaptadores | El wizard lee el archivo con `<input type="file">` + `File.arrayBuffer()` dentro del iframe. Los bytes nunca salen del sandbox y el addon **no necesita el permiso `files`**. |
| **El subsistema `spending` del core no está expuesto al SDK.** Existe en `crates/storage-sqlite/src/spending/` (reglas de categorización, presupuestos, splits, merchants) pero no hay `ctx.api.spending`. | `packages/addon-sdk/src/host-api.ts` no lo menciona | Motor de reglas y categorías propios en el addon, persistidos en `ctx.api.storage`. Ver [ADR 0003](adr/0003-categorizacion-propia.md). |
| **`ActivityImport` no acepta `metadata`.** Sí lo acepta `ActivityCreate`. | `packages/addon-sdk/src/data-types.ts:362` vs `:295` | Importamos con `saveMany({ creates })`, no con `import()`. |
| **`storage` limita cada valor a ~250 KB.** | Documentado en `host-api.ts:561` | El historial de importaciones se guarda particionado (`ShardedList`). |
| **Sin jobs en segundo plano.** Un addon solo corre cuando su ruta está abierta. | Activación diferida | La importación es explícita y con vista previa. Un servicio externo queda para el futuro (F19). |

Ninguna de estas limitaciones justifica hoy un fork del core. Ver
[docs/DECISIONS.md](DECISIONS.md).

---

## Modelo de actividades de Wealthfolio

Conjunto cerrado de 14 tipos. Los que usamos y por qué:

| Nuestro `TransactionKind` | Tipo Wealthfolio | Razón |
| --- | --- | --- |
| `income` | `DEPOSIT` | Flujo externo entrante; suma a net contribution |
| `expense`, `credit_card_purchase` | `WITHDRAWAL` | Flujo externo saliente |
| `internal_transfer` | `TRANSFER_IN` / `TRANSFER_OUT` | **Netean a cero a nivel de portafolio** — evita el doble conteo |
| `credit_card_payment` | `TRANSFER_IN` / `TRANSFER_OUT` | Mueve deuda, no es gasto nuevo |
| `refund` | `CREDIT` (subtipo `REFUND`) | No altera net contribution |
| `fee` | `FEE` | Solo caja |
| `tax` | `TAX` | Solo caja |
| `interest` (ganado) | `INTEREST` | Ingreso |
| `interest` (cobrado) | `FEE` (subtipo `INTEREST_CHARGE`) | Costo de financiamiento |
| `unknown` | `UNKNOWN` | Wealthfolio lo marca `needs_review` y lo excluye de todo cálculo — exactamente lo que queremos para una fila que no supimos leer |

Referencia: `.upstream/wealthfolio/docs/activities/activity-types.md`.

---

## Auditoría de contrato — v3.6.2 (2026-08-06)

Verificado leyendo `node_modules/@wealthfolio/addon-sdk@3.6.2` y
`.upstream/wealthfolio` en el commit `633d3a1`, no ejemplos ni documentación de
terceros. Todavía **sin ejecutar** contra una instancia real: lo de abajo es
lectura de contrato, no observación de runtime.

### `activities.saveMany` — confirmado

```ts
saveMany(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult>

interface ActivityBulkMutationRequest {
  creates?: ActivityCreate[];
  updates?: ActivityUpdate[];
  deleteIds?: string[];
}
```

`packages/addon-sdk/src/host-api.ts` y `dist/src/host-api.d.ts:116`. La forma
`{ creates }` que usamos es la correcta.

Detalle del puente (`apps/frontend/src/addons/type-bridge.ts:428`): si se le pasa
un **array** en vez de un objeto, lo interpreta como `{ updates: input }`. Pasar
`ActivityCreate[]` directamente crearía cero actividades sin error visible.
Nuestro `import-runner` siempre pasa el objeto, y hay un test que lo fija.

**El lote es atómico.** `bulk_mutate_activities`
(`crates/core/src/activities/activities_service.rs:4240`) valida la petición
completa primero y, si algo falla, retorna temprano con
`ActivityBulkMutationResult { errors, ..Default::default() }` — `created` vacío,
nada persistido. Pasada esa validación la escritura es una sola transacción
(`crates/storage-sqlite/src/activities/repository.rs:1265`), así que un fallo de
base de datos vuelve como promesa rechazada, no como entrada en `errors`.

Consecuencias, ambas fijadas por test:

- **Cada entrada de `result.errors` representa siempre filas no creadas.** No
  existe en v3.6.2 un camino donde el host reporte un error y aun así haya
  creado la fila.
- **Una fila mala cuesta su lote entero.** Es lo que acota el `BATCH_SIZE = 100`
  de `import-runner`.

> **Corrección de esta auditoría.** Hasta 0.1.1 este documento afirmaba que
> `errors` era *por fila* y que un lote podía devolver `created` parcial junto a
> `errors`. Es falso: o se crea todo el lote, o no se crea nada de él. El
> resultado de la importación igual distingue `created` de `failed` en vez de
> asumir que no lanzar significa éxito, y `status` sigue exigiendo
> `errors.length === 0` para `completed` — la mitad conservadora del test, por si
> un host futuro sí reportara un error habiendo creado todo.

### `activities.search` — el tipo del SDK está incompleto

```ts
// packages/addon-sdk/src/host-api.ts:43
interface ActivitySearchFilters {
  accountIds?: string | string[];
  activityTypes?: string | string[];
  symbol?: string;
}
```

Pero el puente pasa el objeto de filtros **verbatim** a
`apps/frontend/src/adapters/shared/activities.ts:67`, que lee además:

```
needsReview, dateFrom, dateTo, instrumentTypes, activityIds
```

`dateFrom`/`dateTo` son `YYYY-MM-DD` **inclusive**, y ambos backends los
resuelven a un rango UTC según la zona horaria del usuario
(`apps/tauri/src/commands/activity.rs:21`, `apps/server/src/api/activities.rs:62`).

> **Error encontrado y corregido.** El addon enviaba `startDate`/`endDate`. Esos
> nombres no existen en ninguna capa: se ignoraban en silencio y toda consulta
> escaneaba la cuenta completa. Ver `services/activity-index.ts`.

Como el tipo publicado no los declara, el addon los construye en un único punto
(`activityDateFilters`) con un cast explícito. Si upstream amplía el tipo, ese
cast es lo único que hay que borrar.

### Round-trip de metadata — confirmado por contrato

`ActivityCreate.metadata` acepta `string | Record<string, unknown>` y
`ActivityDetails.metadata` lo devuelve como `Record<string, unknown>`
(`dist/src/data-types.d.ts:186`, `:271`). En el core Rust es
`Option<Value>`, un blob JSON
(`crates/core/src/activities/activities_model.rs:149`). `ActivityImport` **no**
tiene el campo — otra razón para usar `saveMany`.

Pendiente de verificar en runtime: que el blob sobreviva íntegro (claves
anidadas, arrays, acentos) a un ciclo escritura → reinicio → lectura.

### Semántica de actividades — la dirección va en el tipo

`ActivityDetails.amount` es un `string | null` **sin signo**; la dirección la
expresa `activityType`. La tabla de `docs/activities/activity-types.md` da el
efecto en caja:

| Signo | Tipos |
| --- | --- |
| `+` | `DEPOSIT`, `TRANSFER_IN`, `INTEREST`, `DIVIDEND`, `CREDIT`, `SELL` |
| `−` | `WITHDRAWAL`, `TRANSFER_OUT`, `FEE`, `TAX`, `BUY` |
| sin dirección | `SPLIT`, `ADJUSTMENT`, `UNKNOWN` |

> **Error encontrado y corregido.** Al reconstruir un movimiento el signo no se
> recuperaba, así que un gasto guardado como `WITHDRAWAL +85400` volvía como
> `+85400` y no coincidía con el `-85400` del modelo. La huella exacta seguía
> funcionando, de ahí que pasara inadvertido; los duplicados *probables* no se
> detectaban nunca. La regla vive ahora sólo en
> `core/mapping/activities.ts` (`activityFlowSign`, `activityDetailsToSignedMoney`).

> **Segundo error, encontrado en la auditoría posterior a 0.1.1.** La fila «sin
> dirección» de la tabla no era recuperable. Escribimos siempre la magnitud, así
> que un `unknown / out / -4500` llegaba al host como `UNKNOWN +4500` y volvía
> como `in / +4500`. El mapping no era reversible para `SPLIT`, `ADJUSTMENT`,
> `UNKNOWN` ni para ningún tipo que upstream agregue después. Desde `v: 2` la
> metadata guarda `dir` y la lectura la consulta **sólo** para esos tipos: para
> los once tipos con dirección documentada el `activityType` sigue siendo la
> autoridad, y metadata inconsistente no puede alterarla. Ver
> `resolveActivityDirection` y docs/IMPORT_PIPELINE.md.

`CREDIT` altera net contribution **según el subtipo**: `BONUS` suma, `REFUND` y
`REBATE` no. Usamos `CREDIT`/`REFUND`, que es el comportamiento buscado — según
la documentación. Confirmarlo en runtime sigue pendiente.

### `storage` — confirmado

Clave ≤ 128 caracteres de `[A-Za-z0-9_.:-]`; valor limitado a ~250 KB y `set`
rechaza uno mayor (`dist/src/host-api.d.ts:433`). Es por dispositivo replicado,
no por addon. `ShardedList` respeta el límite con un margen de 200 KB.

### Permisos declarados vs. usados

Categorías reales del SDK: `accounts`, `activities`, `portfolio`, `market-data`,
`assets`, `quotes`, `performance`, `exchange-rates`, `contribution-limits`,
`financial-planning`, `settings`, `files`, `snapshots`, `secrets`, `network`,
`events`, más las base `ui`, `query`, `toast`, `logger`, `storage`.

| API que llamamos | Categoría | Declarada |
| --- | --- | --- |
| `accounts.getAll` | `accounts` | ✅ |
| `activities.search`, `activities.saveMany` | `activities` | ✅ |
| `settings.get` | `settings` | ✅ |
| `storage`, `logger`, `toast`, `query` | base | no requiere declaración |
| `navigation.navigate` | — | no existe como categoría en v3.6.2 |

No se declara ni se usa `files`, `network` ni `secrets`.

### Tipos de cuenta

`CASH` y `CREDIT_CARD` existen como tipos de cuenta del host. Cómo trata
Wealthfolio una cuenta `CREDIT_CARD` (signo del saldo, qué cuenta como pasivo)
**no se ha verificado empíricamente**: es una de las cosas que requiere una
instancia corriendo, y hasta entonces nuestro mapeo de compras y pagos de tarjeta
es una hipótesis razonada, no un hecho.

---

## MCP

Wealthfolio **ya trae un servidor MCP** (`apps/server/src/mcp/`), activable con
`WF_MCP_ENABLED=true`. No vamos a construir otro.

Lo que expone son las actividades del core. Nuestros datos propios (planes de
cuotas, historial de importaciones) viven en `ctx.api.storage` y no son
accesibles vía MCP. Antes de construir cualquier servidor propio hay que
documentar esa limitación concreta con un caso de uso real. Ver F20 en el
[roadmap](ROADMAP.md).

---

## Actualizar upstream

```bash
./scripts/update-upstream.sh            # a la versión fijada
./scripts/update-upstream.sh v3.7.0     # a una versión concreta
./scripts/update-upstream.sh --latest   # a la última release
```

El script compara el `sdkVersion` de nuestro manifiesto con el del checkout y
avisa si difieren.

**Actualizar el checkout no actualiza el addon.** Para subir de versión:

1. Leer las guías de migración en `.upstream/wealthfolio/docs/addons/`
   (upstream mantiene una por salto: v2→v3, v3.5→v3.6).
2. `git -C .upstream/wealthfolio log --oneline -- packages/addon-sdk`
3. Actualizar `sdkVersion` y `minWealthfolioVersion` en `addon/manifest.json`.
4. Actualizar `peerDependencies`/`hostDependencies` a la misma versión.
5. Actualizar `WF_VERSION` en `infra/.env.example` y la tabla de este documento.
6. `./scripts/test.sh`
7. Probar la carga real del addon en una instancia con la nueva versión.

`.upstream/` está en `.gitignore`: no vendorizamos código de upstream. Si
alguna vez copiamos algo, hay que conservar headers y avisos de licencia y
registrarlo en [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
