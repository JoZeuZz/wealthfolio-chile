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
