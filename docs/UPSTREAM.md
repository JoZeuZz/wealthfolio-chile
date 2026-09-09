# Upstream — Wealthfolio

Qué versión de Wealthfolio usamos, qué nos ofrece su SDK de addons y cómo
actualizamos.

Investigado el **2026-08-05** contra el código real del repositorio, no contra
documentación de terceros. Referencia actual **v3.7.0**, verificada el
2026-09-03 contra checkout y host real. El 2026-09-07 apareció v3.8.0; el delta
3.7.0→3.8.0 se investigó y se migró el tooling el 2026-09-09 (ver más abajo).

---

## Versión de referencia

| Dato | Valor |
| --- | --- |
| Repositorio | `wealthfolio/wealthfolio` |
| Release estable más reciente | **v3.8.0** (2026-09-07) |
| Release de referencia validada | **v3.7.0** (2026-08-19) — sigue siendo el mínimo host soportado |
| Licencia del core | **AGPL-3.0** |
| Licencia de `@wealthfolio/addon-sdk` | **MIT** |
| Licencia de `@wealthfolio/ui` | **MIT** |
| SDK usado para build | `@wealthfolio/addon-sdk@3.8.0` (tipos; `minWealthfolioVersion` se mantiene en `3.7.0`) |
| Node de upstream | 24 (`.node-version`) |
| Gestor de paquetes | `pnpm@10.33.4` |
| Imagen Docker de referencia | `wealthfolio/wealthfolio:3.7.0` (multi-arch amd64/arm64) — **sin la `v`**: upstream etiqueta en git con `v3.7.0` y publica en Docker Hub como `3.7.0` |
| Checkout local | `.upstream/wealthfolio` (ignorado por Git) |

### v3.8.0 — migración de tooling controlada (2026-09-09)

GitHub publicó `v3.8.0` el 2026-09-07 y npm reportó `@wealthfolio/addon-sdk@3.8.0`,
`@wealthfolio/ui@3.8.0` y `@wealthfolio/addon-dev-tools@3.8.0` el mismo día.

Tras leer el diff real `v3.7.0..v3.8.0` de `packages/addon-sdk`, `packages/ui`,
`packages/addon-dev-tools` y de `crates/core/src/activities` +
`crates/core/src/portfolio` (ver tabla de delta abajo), se determinó que
ninguna API 3.8-only es necesaria hoy para el comportamiento actual del addon.
Se migró entonces sólo el **tooling de build**:

| Qué | Antes | Ahora |
| --- | --- | --- |
| `@wealthfolio/addon-sdk` (dev+peer) | `^3.7.0` | `^3.8.0` |
| `@wealthfolio/ui` (dev+peer) | `^3.7.0` | `^3.8.0` |
| `@wealthfolio/addon-dev-tools` (dev) | `^3.7.0` | `^3.8.0` |
| `manifest.json: sdkVersion` | `3.7.0` | `3.8.0` |
| `manifest.json: minWealthfolioVersion` | `3.7.0` | **`3.7.0` (sin cambio)** |
| `manifest.json: hostDependencies` (addon-sdk/ui) | `^3.7.0` | `^3.8.0` (test `manifest-contract.test.ts` exige que sea igual a `peerDependencies`) |

Esto es deliberado: `sdkVersion` es lo que se usó para *construir* el addon
(sólo produce un warning si difiere, `validateAddonCompatibility` en
`apps/frontend/src/addons/addons-core.ts`); `minWealthfolioVersion` es el único
gate duro (`enforce_min_wealthfolio_version`,
`crates/core/src/addons/service.rs`) y expresa el mínimo *real* que el addon
necesita — que sigue siendo 3.7.0 porque no se usa ninguna superficie 3.8-only.
El propio test de contrato (`addon/tests/manifest-contract.test.ts`) ya
verificaba `minWealthfolioVersion <= sdkVersion`, así que esta combinación
—build con SDK 3.8, mínimo de host 3.7— es exactamente el patrón que el
proyecto anticipaba.

Consecuencia práctica de que `ActivityCreate.status`/`.needsReview` pasaran de
undeclared (3.7) a tipados oficialmente en 3.8: el tipo local
`ReviewableActivityCreate` (`addon/src/core/mapping/activities.ts`) dejó de
declarar `needsReview` (ahora lo hereda del SDK) y sigue restringiendo `status`
a `'DRAFT'` únicamente — el SDK 3.8 lo tipa como `POSTED | PENDING | DRAFT |
VOID`, y aceptar la unión completa habría permitido escribir `'POSTED'`/`'VOID'`
sin error de tipo, perdiendo la barrera de compilación sobre una decisión
financiera real (si la fila cuenta en balance/valuación/performance). Revisado
por `wf-code-reviewer` y corregido antes de cerrar esta fase.

**Validado contra un contenedor Wealthfolio 3.8.0 real** (efímero, sin auth,
datos 100% sintéticos, destruido al terminar — ver
[HOST_VALIDATION.md](HOST_VALIDATION.md)): el addon carga, el manifest se
acepta, `accounts.getAll`, `activities.search`, `activities.saveMany` y
`ctx.api.storage` funcionan igual que en 3.7.0. Import sintético de Banco de
Chile (cuenta + tarjeta), dedupe en reimportación, refund, comisión, interés
por mora, pago de tarjeta y cuotas se comportaron exactamente igual que bajo
3.7.0 — cifras del dashboard verificadas a mano.

Fuentes: https://github.com/wealthfolio/wealthfolio/releases/tag/v3.8.0,
`pnpm view @wealthfolio/addon-sdk versions` / `@wealthfolio/ui` /
`@wealthfolio/addon-dev-tools`, y diff real de `.upstream/wealthfolio` entre
los tags `v3.7.0` y `v3.8.0`.

---

## Qué cambió de v3.7.0 a v3.8.0

Leído en el diff real (`git -C .upstream/wealthfolio diff v3.7.0 v3.8.0`) de
`packages/addon-sdk`, `packages/ui`, `packages/addon-dev-tools`,
`crates/core/src/activities` y `crates/core/src/portfolio`. Sólo lo relevante
para un addon; se omiten cambios internos del host sin superficie pública.

### SDK del addon (`packages/addon-sdk`)

| Cambio | Nos afecta |
| --- | --- |
| `ActivityCreate`/`ActivityUpdate` tipan oficialmente `status?: ActivityStatus` y `needsReview?: boolean` | Sí — dejamos de necesitar el cast local para esos dos campos (`idempotencyKey` sigue undeclared) |
| Nueva `ExchangeRatesAPI.getRatesForDates(pairs)`: tasas históricas reales por `(fromCurrency, toCurrency, date)`, nunca rechaza (cada resultado trae `rate: number \| null` + `error: string \| null`) | Ver veredicto FX abajo — **DEFER** |
| Nueva `SpendingAPI` (`isEnabled`, `getCategories`, `getRules`, `saveRule`, `deleteRule`, `rerunRules`) tras permiso `spending` | Ver veredicto Spending abajo — **DEFER** |
| Nueva API de traducciones (`registerTranslations`, `useAddonTranslation`) | **NOT RELEVANT** — el addon ya está en español fijo, sin necesidad de i18n multi-idioma |
| `ActivityImport.isExternal?: boolean` (frontera de flujo externo) | No usamos `activities.import()`, usamos `saveMany`; sin impacto |
| Límite de `storage` por valor: de ~1 MiB a ~250 KB (`MAX_ADDON_STORAGE_SYNC_PAYLOAD_LEN`) | Sin impacto: nuestro propio límite (`MAX_VALUE_BYTES`, `addon/src/services/storage.ts:12`) ya es 200 000 bytes, por debajo de ambos umbrales |
| `ActivitySearchFilters` publicado sigue sin `dateFrom`/`dateTo` | Sin cambio — seguimos necesitando el cast en `activityDateFilters` |
| `ActivitiesAPI` sigue sin `link`/`unlink`/`transfer-pair` | Sin cambio — [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) sigue vigente |

### `@wealthfolio/ui` y `@wealthfolio/addon-dev-tools`

Sin cambios breaking. `@wealthfolio/ui` suma `TickerAvatar` con props de
mercado (`exchangeMic`, `instrumentType`) y helpers de logos por ticker,
`onEscapeKeyDown` en `DialogContent`, un segundo parámetro opcional en
`MoneyInput.onValueChange` — el addon no importa componentes de
`@wealthfolio/ui` hoy, así que ninguno aplica. Peer dependency de React sin
cambio (`^19.2.4`). `addon-dev-tools` sólo actualizó plantillas de versión, sin
cambios de CLI/validación. Build target del host (`chrome107, edge107,
firefox104, safari16`) sin cambio.

### Semántica financiera del host (`crates/core`)

**"Authoritative final cash semantics"** (commit `f69936821` y
`crates/core/src/activities/activity_cash_migration.rs`, nuevo en 3.8): cuando
una actividad tiene `fee`/`tax`, el host ahora trata el `amount` guardado como
el **neto final** y deriva el bruto sumando `fee+tax` de vuelta
(`resolve_cash_inputs()`, `crates/core/src/portfolio/economic_events.rs`) — en
3.7 era al revés (`cash effect = amount - fee - tax`, ver
`holdings_calculator/handlers/cash_flows.rs`).

**No afecta a Wealthfolio Chile**: `toActivityCreate`
(`addon/src/core/mapping/activities.ts`) nunca escribe `fee` ni `tax` en el
`ActivityCreate` — cada comisión, impuesto o interés bancario es su **propia
actividad** (`FEE`/`TAX`), nunca un campo adicional sobre una compra o retiro.
Con `fee`/`tax` ausentes, la fórmula de 3.8 se reduce a `gross = final_amount`,
idéntica a 3.7. Confirmado en código (revisión financiera independiente,
2026-09-09) y en runtime contra un host 3.8.0 real: las columnas `Fee`/`Tax` de
`Activities` muestran `CLP 0` en todas las filas creadas por el addon.

Tipos permitidos por cuenta `CREDIT_CARD`
(`account_activity_validation_message`) y comportamiento de subtipos `CREDIT`
(`REFUND`/`REBATE`/`BONUS`) respecto a `contributions`: **sin cambios**,
verificado línea a línea contra ambos tags.

**Hipótesis descartada por la revisión financiera independiente**: se investigó
si la migración one-time de datos legacy (`activity_cash_migration.rs`,
`is_legacy_draft`) promueve `status: DRAFT` a `POSTED` al actualizar un host a
3.8 — lo que habría hecho que filas `unknown` del addon, excluidas a propósito
de todo cálculo, empezaran a contar. **No lo hace**: el propio módulo lo
documenta ("the migration never changes lifecycle `status`",
`activity_cash_migration.rs:9-11`), `ActivityFinalCashMigrationUpdate` no tiene
campo `status` (`activities_model.rs`), y el `UPDATE` real
(`storage-sqlite/src/activities/repository.rs`) sólo toca `amount`,
`needs_review`, `metadata`. `is_legacy_draft` alimenta únicamente
`needs_review`. Las filas `unknown` del addon ya llevan `needsReview: true`
además de `status: DRAFT`, así que ni siquiera entran a la rama que la
migración backfillea. No hay nada que corregir aquí.

**Hallazgo real, corregido en esta fase**: `INTEREST` en una cuenta
`CREDIT_CARD` cambia de signo entre 3.7 y 3.8 en la contabilidad *interna* del
host (`ActivityEconomicsResolver::resolve_cash_with_account_context`, nuevo en
`crates/core/src/portfolio/economic_events.rs`, trata un `INTEREST` en tarjeta
como cargo; 3.7 no distingue por tipo de cuenta). Investigando esto se encontró
que la lectura propia del addon (`activityFlowSign`/`activityDetailsToSignedMoney`
en `core/mapping/activities.ts`) tenía el mismo problema **de forma
independiente de la versión del host**: un `INTEREST` crudo en una tarjeta
siempre se leía como ingreso, nunca como costo financiero, aunque
`kindFromActivityType` ya considera `accountType` para el caso análogo de
`CREDIT`. Corregido con TDD en tres rondas, cada una verificada por
`wf-financial-reviewer` de forma independiente antes de la siguiente:

1. **Lectura.** `activityFlowSign`/`activityDirection`/`resolveActivityDirection`/
   `activityDetailsToSignedMoney` aceptan `accountType` opcional; `INTEREST` en
   `CREDIT_CARD` se lee como costo financiero (`direction: out`) por defecto,
   tanto bajo 3.7 como bajo 3.8 — el default no depende de la versión del host.
2. **Escritura.** La primera ronda dejaba un hueco: `naturalActivityType`
   puede producir `kind: interest, direction: in` (una regla de usuario sin
   filtro de dirección) también en una cuenta `CREDIT_CARD`, y el nuevo default
   de lectura invertía esa fila — un interés que el propio addon escribió como
   ingreso volvía como gasto. `substituteForCreditCard` ahora enruta esa
   combinación a `CREDIT` (sustituido, `needsReview: true`), igual que ya hace
   con un crédito de tipo desconocido, así que la escritura nunca vuelve a
   producir un `INTEREST` crudo entrante en tarjeta. `services/activity-index.ts`
   (el índice de duplicados) tampoco propagaba `accountType`; ahora lo resuelve
   una vez por cuenta vía `ctx.api.accounts.getAll()`.
3. **Integridad histórica.** El default de lectura de la ronda 1 es correcto
   para una fila *ajena* (editada a mano, importada por otra vía), pero
   reinterpretaba de forma retroactiva una fila que el propio addon **ya**
   había escrito como ingreso antes de que la sustitución de la ronda 2
   existiera (0.2.0-rc.4 y anteriores) — esas filas llevan `metadata.dir: 'in'`
   grabado, y el nuevo default las invertía sin mirarlo.
   `resolveActivityDirection` ahora consulta `metadata.dir` primero para este
   caso, igual que ya hace para `UNKNOWN`/`ADJUSTMENT`/`SPLIT`, y sólo cae al
   default de cargo cuando no hay metadata propia o la caché quedó obsoleta
   (`metadataCacheIsCurrent`, la misma señal que ya usa `reconcileKind` para
   `kind`) — una persona que retipea la fila en Wealthfolio sigue teniendo
   la última palabra.

Tests en `tests/activity-mapping.test.ts` (`activity flow sign`) y
`tests/activity-index.test.ts`.

Validado además contra la instancia **3.7.0 autenticada** (login real, no el
smoke 3.8 sin auth): import de `banco-chile-tarjeta.csv` a una cuenta
`CREDIT_CARD`, 7/7 creados incluido el `INTEREST` de mora, leído como gasto en
el panel. Detalle en [HOST_VALIDATION.md](HOST_VALIDATION.md) § *Sesión 5*.

**Límite conocido, no cerrado en esta fase**: para una fila legacy real (poco
probable hoy — exige una regla de usuario ya configurada con `set_kind` sin
filtro de dirección, y este proyecto no tiene todavía ninguna cartola real
importada por ningún usuario), el paso 3 hace que el addon y un host **3.8**
disientan sobre el signo: 3.8 la lee como cargo en su propia contabilidad
(`resolve_cash_with_account_context`) mientras el addon, con `metadata.dir`
válido, la sigue leyendo como ingreso. Bajo 3.7 no hay disenso (el host no
distingue por tipo de cuenta). Ninguna regla de lectura puede satisfacer ambos
hosts a la vez para esa fila — lo que la resolvería es una migración de datos
que reescriba esas filas a `CREDIT` (lo que la escritura ya hace hoy para
casos nuevos), no otra regla de lectura. Pendiente para el bloque de migración
a 3.8, junto con un gate que detecte `activityType: INTEREST` +
`metadata.dir: 'in'` en cuentas `CREDIT_CARD` antes de subir
`minWealthfolioVersion`.

Migraciones SQL reales entre 3.7.0 y 3.8.0: sólo dos, ninguna toca
`activities`/`accounts`/balances — `2026-08-09-000001_rule_amount_condition`
(agrega condiciones de monto a `spending_categorization_rules`) y
`2026-09-02-000001_asset_logos` (logos de assets). Sin relación con este addon.

### Veredicto de APIs nuevas de 3.8

| API | Veredicto | Razón |
| --- | --- | --- |
| `ExchangeRatesAPI.getRatesForDates` | **DEFER** | Es real y resuelve exactamente lo que bloqueaba la conversión histórica (tasa por fecha exacta, nunca rechaza, `rate: null` explícito cuando no hay dato). Pero adoptarla implica diseñar conversión multi-moneda en el panel — pantallas, invariantes de redondeo, decisión de qué hacer con `error`/`rate: null` — que es un cambio de producto, no un ajuste de tooling. Además exigiría subir `minWealthfolioVersion` a 3.8.0. Se documenta el hallazgo; el diseño queda para una fase propia, no se implementa aquí para no ampliar el alcance de una migración de baseline. |
| `SpendingAPI` (`getCategories`/`getRules`/`saveRule`/`deleteRule`/`rerunRules`) | **DEFER** | Es una primitiva *genérica* de categorización — nuestro motor (`core/rules`, `core/categories`, `services/rules`) codifica **glosas bancarias chilenas concretas** (Transbank, CMR, Redcompra, avances en efectivo) que `SpendingAPI` no conoce ni podría sin que se las enseñemos igual. No hay ganancia arquitectónica migrando reglas que ya funcionan y están probadas (96 % líneas en `core/rules`) a una API genérica que exigiría el mismo trabajo de mapeo. Reevaluar sólo si upstream publica taxonomías o reglas específicas de LatAm/Chile. |
| Traducciones (`registerTranslations`/`useAddonTranslation`) | **NOT RELEVANT** | El addon es monolingüe en español por diseño (cartolas, glosas y usuario objetivo son chilenos). No hay necesidad de i18n multi-idioma hoy. |
| Transfer pairing (`link`/`unlink`/`transfer-pair`) | **NOT RELEVANT (sigue sin existir)** | Ni el paquete publicado ni el puente del sandbox lo exponen en 3.8. [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) sigue vigente sin cambios; no hay nada que adoptar. |
| `status`/`needsReview` tipados en `ActivityCreate` | **ADOPT NOW** | Ya se hizo: simplifica `ReviewableActivityCreate` sin cambiar comportamiento, cero riesgo, sin subir `minWealthfolioVersion`. |

Wealthfolio es Tauri + React + Rust. El backend vive en `crates/`, el frontend
en `apps/frontend`, el servidor web en `apps/server` y los paquetes públicos en
`packages/` (`addon-sdk`, `ui`, `addon-dev-tools`).

---

## Qué cambió de v3.6.2 a v3.7.0

Leído en el diff real de `packages/addon-sdk` entre los dos tags:

| Cambio | Nos afecta |
| --- | --- |
| Nuevo `AddonContext.assets` (`list/has/getBlob/getUrl`) para archivos empaquetados bajo `assets/**` | No lo usamos |
| `enable()` y el `disable` devuelto pueden ser `async` | No lo necesitamos |
| `QueryAPI.getClient()` pasa a estar **scoped al sandbox**: su caché ya no se comparte con la app principal, aunque `invalidate`/`refetch` sí se replican | Sólo llamamos `invalidateQueries` |
| `AccountValuation.calculationMethod` suma `UNPRICED_HOLDINGS_TRANSITION` | No lo leemos |
| `HOST_DEPENDENCIES` sube a `^3.7.0` | Sí: `manifest.json` y `package.json` |
| Build target fijado a `chrome107, edge107, firefox104, safari16` | Sí: `vite.config.ts` lo declara explícitamente |

Lo que **no** cambió, y sigue condicionando el diseño:

- `ActivitySearchFilters` sigue sin declarar `dateFrom`/`dateTo`.
- El desfase de zona horaria de los filtros de fecha sigue igual
  (`local_date_range_utc_bounds`). Reverificado en runtime el 2026-09-03: una
  actividad del 2026-09-01 sólo aparece pidiendo la ventana `2026-08-31`.
- `NewActivity.metadata` sigue siendo `Option<String>` y `ActivityDetails.metadata`
  `Option<Value>`. Reverificado: mandar un objeto devuelve
  `422 invalid type: map, expected a string`.
- `ActivitiesAPI` sigue sin `link`, `unlink` ni `transfer-pair`, ni en el paquete
  publicado ni en el puente del sandbox. [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md)
  sigue vigente sin cambios.
- `ExchangeRatesAPI` sigue siendo `getAll`/`update`/`add`: tipos vigentes, **no
  históricos**. No hay forma pública de convertir un movimiento a la fecha en que
  ocurrió.
- No hay `ctx.api.spending`. [ADR 0003](adr/0003-categorizacion-propia.md) sigue
  vigente.

`minWealthfolioVersion` es el **único gate duro** del host
(`enforce_min_wealthfolio_version`, `crates/core/src/addons/service.rs`).
`sdkVersion` y `hostDependencies` sólo producen warnings
(`validateAddonCompatibility`, `apps/frontend/src/addons/addons-core.ts`).

---

## Tipos de actividad permitidos por tipo de cuenta

Encontrado contra un host real el 2026-09-03, no leyendo el SDK: importar un
estado de cuenta de tarjeta con un abono sin glosa reconocible devolvió

```
Activity error: Invalid data: UNKNOWN activities are not supported for
credit card accounts
```

y como `saveMany` valida el lote completo antes de escribir, esa única fila costó
los cinco movimientos: no se guardó ninguno.

La regla vive en `account_activity_validation_message`
(`crates/core/src/activities/activities_service.rs`). En una cuenta
`CREDIT_CARD` sólo se aceptan:

```
WITHDRAWAL   TRANSFER_IN   CREDIT   FEE   INTEREST
```

Cualquier otro tipo —incluidos `UNKNOWN`, `DEPOSIT`, `TRANSFER_OUT` y `TAX`— se
rechaza. `core/mapping/activities.ts` recibe ahora el tipo de la cuenta destino y
sustituye por el tipo permitido más cercano, dejando constancia en
`metadata.subst` para que una relectura no confunda la sustitución con una
reclasificación del usuario. Hay un test que recorre todos los `TransactionKind`
en ambas direcciones y falla si alguno produce un tipo que el host rechazaría.

---

## Cómo funciona un addon (v3.6 y v3.7)

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
| `unknown` | `UNKNOWN` | `event_kind` lo clasifica `EconomicEventKind::Other`, así que queda fuera de todo cálculo — exactamente lo que queremos para una fila que no supimos leer. La marca `needs_review` **no** la pone el host en un create normal (sólo en modo sincronización): la escribe el addon, ver abajo |

Referencia: `.upstream/wealthfolio/docs/activities/activity-types.md`.

---

## Auditoría de contrato — v3.6.2 (2026-08-06)

Verificado leyendo `node_modules/@wealthfolio/addon-sdk@3.6.2` y
`.upstream/wealthfolio` en el commit `633d3a1`, no ejemplos ni documentación de
terceros.

> **Ejecutado contra un host real el 2026-08-07.** Lo que sigue mezcla dos
> fuentes: lectura de contrato (2026-08-06) y observación de runtime
> (2026-08-07). Donde discreparon, manda el runtime y está marcado. La sesión
> completa está en [HOST_VALIDATION.md](HOST_VALIDATION.md).

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

`dateFrom`/`dateTo` son `YYYY-MM-DD` y ambos backends los resuelven a un rango
UTC **según la zona horaria de la instancia**
(`apps/tauri/src/commands/activity.rs:21`, `apps/server/src/api/activities.rs:97`).

> **Corrección por runtime (2026-08-07).** Ese detalle no es cosmético: nuestras
> fechas de actividad entran como día civil pelado y quedan guardadas a
> medianoche **UTC**, así que con `TZ=America/Santiago` la ventana entera vuelve
> corrida un día. Pedir desde el `2026-08-08` **excluye** los movimientos del
> 08-08; pedir hasta el `2026-08-04` **incluye** los del 08-05.
>
> Cae justo sobre el índice de duplicados, que acota su barrido al período de la
> cartola: un movimiento del primer día de la ventana no llegaba al índice y la
> importación lo declaraba nuevo. `activityDateFilters` pide ahora un día más por
> lado y `withinWindow` reimpone la ventana exacta sobre lo que vuelve.

La firma es **posicional**, no un objeto: `search(page, pageSize, filters,
searchKeyword, sort)`. Pasar un objeto como primer argumento devuelve 422. La
paginación es **0-indexada** (`offset = page * page_size`,
`crates/storage-sqlite/src/activities/repository.rs:422`) y `meta.totalRowCount`
es el total del conjunto filtrado, no el de la página. Las tres cosas verificadas
en runtime.

> **Error encontrado y corregido.** El addon enviaba `startDate`/`endDate`. Esos
> nombres no existen en ninguna capa: se ignoraban en silencio y toda consulta
> escaneaba la cuenta completa. Ver `services/activity-index.ts`.

Como el tipo publicado no los declara, el addon los construye en un único punto
(`activityDateFilters`) con un cast explícito. Si upstream amplía el tipo, ese
cast es lo único que hay que borrar.

### Round-trip de metadata — el contrato es asimétrico

`ActivityCreate.metadata` está declarado como `string | Record<string, unknown>`
y `ActivityDetails.metadata` como `Record<string, unknown>`
(`dist/src/data-types.d.ts:186`, `:271`). `ActivityImport` **no** tiene el campo
— otra razón para usar `saveMany`.

> **Corrección por runtime (2026-08-07).** Sólo una de las dos mitades del tipo
> de escritura es cierta. En el backend, `NewActivity.metadata` es
> `Option<String>` (`crates/core/src/activities/activities_model.rs:324`): un
> objeto cuesta un `422 Unprocessable Entity` **antes de escribir una sola
> fila**. La lectura sí devuelve el blob parseado, porque
> `ActivityDetails.metadata` es `Option<Value>`
> (`:818`). Es decir: **se escribe string, se lee objeto.**
>
> Esto habría hecho fallar toda importación contra un host real, y ningún test lo
> detectaba porque el doble estaba construido sobre la misma suposición que el
> código. `toActivityCreate` serializa; `readChileMetadata` acepta las dos formas.

Verificado en runtime: el blob sobrevive íntegro —claves anidadas, arrays,
acentos— a escritura → reinicio del contenedor → lectura, y también a un ciclo
de backup y restore.

**El host escribe en el mismo campo.** Al enlazar una transferencia agrega
`metadata.flow.is_external` junto a nuestro `wealthfolioChile`, sin tocarlo. La
convivencia por namespace funciona; ver
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md).

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
`REBATE` no. Usamos `CREDIT`/`REFUND`, que es el comportamiento buscado.
Confirmado en runtime el 2026-08-07: el subtipo se guarda y vuelve tal cual, el
saldo de la cuenta sube el monto, y la devolución no aparece en `contributions`.

### `storage` — confirmado

Clave ≤ 128 caracteres de `[A-Za-z0-9_.:-]`; valor limitado a ~250 KB y `set`
rechaza uno mayor (`dist/src/host-api.d.ts:433`). Es por dispositivo replicado,
no por addon. `ShardedList` respeta el límite con un margen de 200 KB.

Verificado en runtime: el esquema particionado (`wfcl.imports.index` +
`wfcl.imports.s0`) pasa la validación de charset del host, se lee por
`GET /api/v1/addons/storage/<addon>/<key>` y sobrevive tanto al reinicio del
contenedor como a una restauración desde backup. El límite exacto de bytes sigue
sin medirse: el esquema particionado nunca se acercó, y forzar el fallo a
propósito no aportaba nada a esta fase.

### Lo que el SDK **no** expone

Comprobado sobre `ActivitiesAPI` en `packages/addon-sdk/src/host-api.ts`. Los
métodos disponibles son:

```
getAll  search  create  update  saveMany  import  checkImport
getImportMapping  saveImportMapping
```

`POST /activities/link`, `/activities/unlink` y `/activities/transfer-pair`
existen en la API HTTP del servidor (`apps/server/src/api/activities.rs:459`)
pero **no tienen equivalente en el SDK**. Un addon de v3.6.2 no puede enlazar los
dos tramos de una transferencia, que es lo único que hace que el host la trate
como interna. Consecuencias y decisión en
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md).

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
