# Validación contra Wealthfolio real

**Ejecutada el 2026-08-07** contra un contenedor `wealthfolio/wealthfolio:3.6.2`
levantado con `infra/compose.yml`. Todo lo que hay aquí abajo se observó; nada se
dedujo del código ni de la documentación de upstream.

Cuando el runtime contradijo lo que este documento suponía, manda el runtime y la
suposición queda tachada con la evidencia que la refutó.

> **Regla.** `PASS` significa: alguien lo ejecutó y lo vio. Cualquier otra cosa
> es `NOT TESTED`.

**Datos usados: sintéticos únicamente.** Tres cuentas de prueba y
`samples/synthetic/`. Ninguna cartola real, ningún dato personal.

---

## 0 · Entorno observado

```
Docker Engine        29.7.2 (build a7dcaa6)
Docker Compose       v5.4.0
Imagen               wealthfolio/wealthfolio:3.6.2
Digest               idéntico a los tags `latest` y `sha-633d3a1be7a…`
Commit de upstream   633d3a1 = tag git v3.6.2
Host                 Linux 7.0.14-4-pve
```

El digest de `3.6.2` coincide byte a byte con el del tag `sha-633d3a1…`, que es
el commit del release `v3.6.2`. La imagen fijada y el checkout de `.upstream/`
son el mismo artefacto.

Reproducir la comprobación:

```bash
docker manifest inspect wealthfolio/wealthfolio:3.6.2 | sha256sum
docker manifest inspect wealthfolio/wealthfolio:sha-633d3a1be7a87e40fbb2d5d335bd60ba4219718b | sha256sum
```

---

## 1 · El stack

```bash
cp infra/.env.example infra/.env       # y rellenar WF_SECRET_KEY y el hash
grep WF_VERSION infra/.env             # 3.6.2 — sin la `v`
./scripts/stack.sh start
./scripts/stack.sh status
```

Generar los dos secretos:

```bash
openssl rand -base64 32                                   # WF_SECRET_KEY
printf 'tu-password' | argon2 unsalt16chars!! -id -e      # WF_AUTH_PASSWORD_HASH
```

Sin `argon2` instalado, un contenedor desechable sirve igual:

```bash
docker run --rm alpine:3.19 sh -c \
  "apk add --no-cache argon2 >/dev/null && printf 'tu-password' | argon2 unsalt16chars!! -id -e"
```

### Observado

| Qué | Valor |
| --- | --- |
| Contenedor | `wealthfolio` arriba, `Up (healthy)` |
| Healthcheck | `healthy` en <30 s; `GET /api/v1/healthz` → 200 |
| Puerto | `127.0.0.1:8088->8088/tcp` — loopback, no LAN |
| Volumen | `infra_wealthfolio-data` (prefijo del proyecto compose, no `wealthfolio-data` a secas) |
| uid/gid | `1000:1000` dentro del contenedor; `/data` pertenece a ese usuario |
| Restart policy | `unless-stopped` |
| Rootfs | `read_only: true`; sólo `/data` (volumen) y `/tmp` (tmpfs) son escribibles |
| Autenticación | Exigida. El servidor **se niega a arrancar** en `0.0.0.0` sin `WF_AUTH_PASSWORD_HASH` o `WF_AUTH_REQUIRED=false` |
| Logs de arranque | Sin panics. 44 migraciones aplicadas, `Authentication enabled`, `Listening on 0.0.0.0:8088` |

Dos avisos esperables en una instancia recién creada, ninguno es un fallo:

```
WARN No exchange rates available, converter not initialized
WARN Unknown provider ID: CUSTOM_SCRAPER
```

### Errores encontrados y corregidos

**1 · `WF_VERSION=v3.6.2` no resuelve.** Upstream etiqueta en git con `v` y
publica en Docker Hub sin ella. El `pull` fallaba con `manifest unknown` antes de
poder probar cualquier otra cosa. Corregido en `infra/.env.example` y en el
mensaje de error de `infra/compose.yml`.

**2 · `WF_ADDONS_DIR` apuntaba un nivel de más.** El servidor le concatena
`addons/` (`ensure_addons_directory`, `crates/core/src/addons/service.rs:111`),
así que `/data/addons` lo hacía buscar en `/data/addons/addons` mientras el bind
mount entregaba el addon en `/data/addons`. El addon era invisible **sin ningún
error en ninguna parte**: el directorio que escaneaba simplemente no existía. El
valor correcto es `/data`, que es también el default de upstream (el padre de
`WF_DB_PATH`).

**3 · El addon quedaba instalado pero no administrable.** `deploy-addon.sh`
dejaba los archivos con el propietario de quien ejecutara el script, y el
contenedor corre como uid 1000. Activar o desactivar el addon reescribe
`manifest.json` (`toggle_addon`), así que el primer clic devolvía:

```
{"code":500,"message":"Failed to write manifest: Permission denied (os error 13)"}
```

El script ahora cede la propiedad a `1000:1000` — con `docker exec -u 0` como
respaldo cuando quien despliega no puede hacer `chown` — y **comprueba después**
que el host puede escribir el manifiesto, abortando si no. Un deploy que produce
en silencio un addon imposible de apagar es peor que uno que falla.

---

## 2 · Primer arranque

Abierto en un navegador real (Chromium headless vía Playwright), no sólo con
`curl`.

| Qué | Resultado |
| --- | --- |
| HTTP | `/` → 200 `text/html`; `/api/v1/accounts` sin sesión → 401 |
| Login | `POST /api/v1/auth/login` → 200, `{"authenticated":true,"expiresIn":3600}` + cookie de sesión |
| UI | Carga completa. Onboarding de 4 pasos y luego la app |
| Persistencia de configuración | `onboardingCompleted: true` sobrevive a recargas y reinicios |
| Errores de backend | Ninguno |

### Errores de consola que **son de upstream**, no nuestros

Aparecen en cada carga, con o sin addon instalado:

```
Executing inline script violates the following Content Security Policy directive
'script-src 'self' blob:' …
[Invoke] Command "restore_sync_session" failed: No refresh token configured.
GET /api/v1/portfolio/update net::ERR_ABORTED     (aborto por navegación)
```

Los 401/403 de `restore_sync_session` son Wealthfolio Connect sin sesión, que es
el estado correcto de una instancia sin emparejar.

---

## 3 · Instalación del addon

```bash
./scripts/deploy-addon.sh
```

| Qué | Resultado |
| --- | --- |
| Detección | `GET /api/v1/addons/installed` devuelve `wealthfolio-chile` (0.1.1 en aquella sesión; 0.2.0-rc.1 desde el cierre de esta fase) |
| Habilitación | `enabled: true` (el default cuando el manifiesto no dice nada) |
| Sidebar | «Chile» presente |
| `/addons/wealthfolio-chile` | Panel renderiza |
| `/addons/wealthfolio-chile/importar` | Asistente renderiza, con las 3 cuentas en el selector |
| `/addons/wealthfolio-chile/importaciones` | Historial renderiza |
| Navegación entre las tres | En ambos sentidos |
| Recarga del navegador | Vuelve a la misma ruta con el addon montado |
| Disable → enable → recarga | `POST /api/v1/addons/toggle` → 204 en ambos sentidos; el manifiesto refleja el cambio; el runtime vuelve a cargar (798 KB) |
| Errores de sandbox | **Cero** |
| Errores del addon en consola | **Cero** |
| Peticiones a otro origen | **Cero** |

El addon corre en un iframe `addon-sandbox.html` con nonce por sesión, tal como
describe [UPSTREAM.md](UPSTREAM.md).

Permisos que muestra el host: exactamente `accounts.getAll`,
`activities.search`, `activities.saveMany`, `settings.get`.

---

## 4 · Contrato de `accounts`

Tres cuentas creadas, con los nombres y tipos pedidos — v3.6.2 los acepta todos:

```
Banco Chile Test    CASH          CLP
BancoEstado Test    CASH          CLP
CMR Test            CREDIT_CARD   CLP
```

`ctx.api.accounts.getAll()` devuelve las tres al addon. Campos observados:

```
id  name  accountType  group  currency  isDefault  isActive  isArchived
trackingMode  createdAt  updatedAt  platformId  accountNumber  meta
provider  providerAccountId
```

- `accountType` es un `string` plano (`"CASH"`, `"CREDIT_CARD"`), no un enum
  serializado.
- `currency` es el ISO-4217 tal cual se creó: `"CLP"`.
- `trackingMode` nace en `"NOT_SET"` y no impidió nada de lo probado.
- `meta` es un **string** con JSON dentro, no un objeto.
- Coincide con lo que suponíamos para los cuatro campos que el addon usa
  (`id`, `name`, `accountType`, `currency`).

---

## 5 · Contrato de `activities.search`

La firma es **posicional**, no un objeto:

```ts
search(page, pageSize, filters, searchKeyword, sort)
```

Pasarle un objeto como primer argumento devuelve `422 Unprocessable Entity`.

| Qué | Observado |
| --- | --- |
| Cero movimientos | `{ data: [], meta: { totalRowCount: 0 } }` |
| Paginación | `offset = page * pageSize`, **0-indexada**. Páginas 0 y 1 son disjuntas |
| `meta.totalRowCount` | El total del conjunto **filtrado**, no el de la página |
| `meta` | Sólo trae `totalRowCount` |
| `accountIds` | Acota de verdad; acepta string o array |
| `activityTypes` | Acota de verdad |
| `sort` | `{ id: 'date', desc: false }` ordena ascendente por fecha |
| `date` | ISO completo con zona: `"2026-02-03T00:00:00+00:00"` |
| `amount` | String decimal **sin signo**: `"85400"` |
| `currency` | `"CLP"` |
| `activityType` / `subtype` | Strings; `subtype` es `null` cuando no hay |
| `comment` | El comentario que escribimos, íntegro |
| `metadata` | Objeto **ya parseado** |

### ~~`dateFrom`/`dateTo` son inclusive~~ — refutado

**4 · Los filtros de fecha vienen corridos un día.** El backend resuelve
`dateFrom`/`dateTo` en la **zona horaria de la instancia**
(`local_date_range_utc_bounds`, `apps/server/src/api/activities.rs:97`),
mientras nuestras fechas de actividad entran como día civil pelado y quedan
guardadas a medianoche **UTC**. Con `TZ=America/Santiago` la ventana entera se
desplaza:

| Se pidió | Volvió |
| --- | --- |
| `dateFrom: 2026-08-08` | 08-09, 08-10, 08-10 — **se perdieron los dos del 08-08** |
| `dateTo: 2026-08-04` | 08-03, 08-04, **08-05** |
| `2026-08-05 … 2026-08-06` | 08-06, 08-06, **08-07** |

Esto cae justo encima del índice de duplicados, que acota su barrido al período
de la cartola que se está importando: un movimiento del primer día de la ventana
nunca llegaba al índice, la importación lo declaraba nuevo, y el usuario terminaba
con el movimiento repetido — exactamente el fallo que el índice existe para
evitar.

Corregido pidiendo un día más por cada lado y reimponiendo la ventana exacta
sobre las filas que vuelven (`activityDateFilters` + `withinWindow`). Se paga en
unas pocas filas de barrido de más; el desfase no es una constante que se pueda
descontar, porque depende del despliegue y cambia dos veces al año con el horario
de verano.

Verificado contra el host: pidiendo `08-04 … 08-07` para una ventana real de
`08-05 … 08-06`, los dos bordes llegan.

---

## 6 · Contrato de `activities.saveMany`

```ts
saveMany({ creates: ActivityCreate[] })
```

Respuesta observada: `{ created, updated, deleted, createdMappings, errors }`.
Con 11 filas válidas: `created.length === 11`, `errors === []`.

Una fila con `accountId` inexistente **rechaza el lote entero** con una promesa
fallida (`Database operation failed: Record not found`), no con una entrada en
`errors`. Confirma la atomicidad que ya documentaba [UPSTREAM.md](UPSTREAM.md).

### ~~`metadata` acepta objeto o string~~ — refutado

**5 · `metadata` como objeto rompe toda importación.** En el backend Rust
`NewActivity.metadata` es `Option<String>`
(`crates/core/src/activities/activities_model.rs:324`): un objeto cuesta un
`422 Unprocessable Entity` **antes de escribir una sola fila**. El tipo del SDK
dice `string | Record<string, unknown>`, pero sólo una de las dos mitades es
cierta al escribir.

El contrato es asimétrico, y por eso ningún test lo detectó: la **lectura**
devuelve `ActivityDetails.metadata` como objeto ya parseado. El doble de test
estaba construido sobre la misma suposición equivocada que el código, que es la
lección de fondo — un mock que le da la razón al código que simula no prueba nada.

Verificado: el mismo payload que falla con objeto se crea sin problemas apenas se
serializa. `readChileMetadata` acepta ahora las dos formas.

### Round-trip real

`NormalizedTransaction → toActivityCreate → saveMany → Rust → SQLite →
activities.search → activityToTransaction`, con los payloads generados por el
código de producción, no escritos a mano:

| Caso | Origen | En el host | De vuelta |
| --- | --- | --- | --- |
| Ingreso | `income / in / +1.000.000` | `DEPOSIT 1000000` | `income / in / +1.000.000` |
| Gasto | `expense / out / −100.000` | `WITHDRAWAL 100000` | `expense / out / −100.000` |
| Transferencia | `internal_transfer / out / −200.000` | `TRANSFER_OUT 200000` | idem |
| Compra tarjeta | `credit_card_purchase / out / −80.000` | `WITHDRAWAL 80000` | idem |
| Pago tarjeta | `credit_card_payment / out / −80.000` | `TRANSFER_OUT 80000` | idem |
| Devolución | `refund / in / +12.345` | `CREDIT/REFUND 12345` | idem |
| `UNKNOWN` saliente | `unknown / out / −4.500` | `UNKNOWN 4500`, `metadata.dir=out` | `unknown / out / −4.500` |
| `UNKNOWN` entrante | `unknown / in / +4.500` | `UNKNOWN 4500`, `metadata.dir=in` | `unknown / in / +4.500` |

`fecha`, `monto con signo`, `dirección`, `kind`, `metadata.fp`, `metadata.wfp`,
`metadata.dir`, `metadata.v`, `parser` e `institución` coinciden en los once
casos.

---

## 7 · Metadata v2

`wealthfolioChile.v = 2` y `wealthfolioChile.dir` sobreviven íntegros: escritura,
relectura, reinicio del contenedor y restauración desde backup. Con acentos,
anidamiento y arrays.

El caso que importa, medido:

```
origen:      UNKNOWN / out / -4500
host:        UNKNOWN / +4500 / metadata.dir = "out"
round-trip:  UNKNOWN / out / -4500
```

**El backend no altera ni elimina nuestra metadata.** Sí *agrega* claves propias:
al enlazar una transferencia escribe `metadata.flow.is_external` junto a
`wealthfolioChile`, sin tocar lo nuestro. Convivimos por namespace y funciona.

---

## 8 · Importación end-to-end sintética

`samples/synthetic/banco-chile-cuenta-corriente.csv`, por la UI real: archivo →
detección → cuenta → vista previa → confirmación.

| Qué | Valor |
| --- | --- |
| Banco detectado | «Banco de Chile — cuenta corriente», 100 % |
| Cuenta en la cartola | `••••8-90` (enmascarada) |
| Período | 01-02-2026 → 28-02-2026 |
| Detectados | 12 |
| Seleccionados | 12 |
| Creados en Wealthfolio | 12 |
| Fallidos | 0 |
| Duplicados / probables / ignorados | 0 / 0 / 0 |
| Advertencias | 8 (perfil `pending-real-sample`) |
| Ingresos de la vista previa | $1.895.000 |
| Egresos | $262.070 |
| Flujo neto | $1.632.930 |

Coinciden con el fixture: ingresos = 1.850.000 + 45.000; egresos = la suma de los
ocho gastos, **sin** la transferencia de 200.000 ni el pago de tarjeta de 120.000.

Los doce quedaron en el host con el tipo esperado —`DEPOSIT`, `WITHDRAWAL`,
`FEE`, `TRANSFER_OUT`— y con `v=2` y `dir` en la metadata. El historial registró
la corrida.

---

## 9 · Idempotencia

| Paso | Resultado |
| --- | --- |
| Reimportar el mismo archivo | 12 duplicados exactos, 0 seleccionables, botón deshabilitado |
| `./scripts/stack.sh restart` y reimportar | idéntico: **movimientos nuevos = 0** |
| Total de actividades en el host | 12 antes y después de las tres importaciones |

### Duplicado probable — y una corrección al guion

Este documento decía que agregar ` 1234` a una descripción produciría un
duplicado *probable*. **Es falso, y a propósito**: `descriptionKey` borra todos
los dígitos precisamente para absorber las colas de tarjeta y los folios que los
bancos cambian entre exportaciones. Medido: la fila vuelve como duplicado
**exacto**, que es el comportamiento correcto.

Para obtener un probable hay que cambiar *palabras*:

```
SUPERMERCADO LIDER LAS CONDES  →  SUPERMERCADO LIDER PROVIDENCIA
```

Resultado observado: **11 duplicados exactos + 1 posible duplicado**, 0
movimientos creados automáticamente. Que es lo que se pedía.

---

## 10 · Persistencia

Registrado antes y después de `./scripts/stack.sh restart`:

| Qué | Antes | Después |
| --- | --- | --- |
| Actividades | 12 | 12 |
| `wfcl.imports.index` | `{"shards":1,"total":1}` | igual |
| Metadata de una actividad | blob completo | **byte a byte idéntico** |
| Configuración del host | `onboardingCompleted: true` | igual |
| Healthcheck | `healthy` | `healthy` |

`docker stop` / `docker start` no aporta una ruta distinta: `stack.sh restart`
delega en `docker compose restart`, que es el mismo ciclo del contenedor.

---

## 11 · Semántica de caja

Escenario aislado en su propio mes (agosto 2026), en «Banco Chile Test»:

```
+1.000.000  sueldo
  -100.000  supermercado
   -50.000  combustible
```

Panel Chile, observado:

```
ingresos = $1.000.000
egresos  =   $150.000
neto     =   $850.000      (tasa de ahorro 85 %)
```

### Qué muestra Wealthfolio nativo con los mismos datos

| Métrica del host | Valor observado | Comentario |
| --- | --- | --- |
| Cash de la cuenta | CLP 2.745.275 | El saldo **acumulado a hoy** de todas las actividades, no el neto del mes |
| Valor del portafolio | $3.217,82 (USD) | Convertido a `baseCurrency`, que en una instancia nueva es USD |
| Net worth | $3.152,28 | Activos − pasivos |
| Contribuciones (atribución) | Sí cambia | `DEPOSIT` cuenta como contribución; `FEE` va aparte, en `fees` |
| Spending del host | $0,00 este mes | El *Spending Tracker* nativo no contabilizó nuestras actividades |

**Las dos definiciones son distintas y las dos son correctas en su contexto.**

- El panel Chile responde *«¿cuánto entró y salió este mes?»*: es un flujo,
  acotado a un mes, en la moneda de los movimientos, y excluye transferencias y
  pagos de tarjeta porque no son plata nueva.
- Wealthfolio responde *«¿cuánto tengo y cuánto aporté?»*: es un saldo acumulado
  a la fecha de hoy, convertido a la moneda base, y trata cada movimiento de caja
  como tal.

No cambiamos nuestro modelo por esto. Un usuario chileno que importa una cartola
quiere el flujo del mes en pesos; el patrimonio convertido a dólares es otra
pregunta, y el host ya la responde.

### Error encontrado y corregido

**6 · El panel se caía entero con `MoneyError: currency mismatch: USD vs CLP`.**
El panel tomaba `settings.baseCurrency` como la moneda en que sumar, y una
instancia nueva reporta `USD`. Mientras no había movimientos sólo se veía
«USD 0»; con la primera cartola importada el acumulador en USD recibía montos en
CLP y la excepción dejaba la página **en blanco, sin mensaje**, para cualquier
usuario chileno con un host por defecto.

Los totales son sumas de los movimientos, así que su moneda es un hecho del dato
y no una preferencia de presentación: ahora sale de los movimientos
(`currencyOf`), y `baseCurrency` queda sólo como texto para el panel vacío. Si
alguna vez llegan monedas mezcladas se informa el problema en vez de elegir una
al azar, y el panel ya no puede caerse en blanco: `buildView` va dentro de un
`try` que desemboca en el mismo aviso que el resto de los errores.

Verificado contra el host después del fix: ingresos $1.000.000, egresos $150.000,
neto $850.000.

---

## 12 · Transferencia interna

`Banco Chile Test TRANSFER_OUT 200.000` + `BancoEstado Test TRANSFER_IN 200.000`,
el mismo día.

| Qué | Observado |
| --- | --- |
| Cash de Banco Chile | −200.000 exactos |
| Cash de BancoEstado | +200.000 exactos |
| Efecto en el portafolio | **0** — el cash total no se movió |
| Panel Chile | ingresos $0, egresos $0, «transferencias entre cuentas propias $200.000» |

### ~~Por defecto una transferencia es interna~~ — refutado

Éste era el supuesto que sostenía la garantía de no-doble-conteo, y es falso.

Una actividad `TRANSFER_IN`/`TRANSFER_OUT` escrita por `saveMany` **no lleva
`metadata.flow.is_external`**. El propio host lo dice en sus logs:

```
WARN Unresolved transfer activity <id> on 2026-07-06 has no explicit external
     marker; marking scoped flow as unknown.
```

Y lo paga en su atribución. Net contribution de BancoEstado, medido:

| | contributions | residual | quality |
| --- | --- | --- | --- |
| Sin enlazar | `0.0` | diferencia de `217.19` sin atribuir | `partial` |
| Tras `POST /api/v1/activities/link` | `217.19` | `0.0` | `partial`, pero sin el aviso de atribución |

Enlazar los dos tramos escribe `metadata.flow.is_external = false` en ambos y
deja la atribución cuadrada.

**Nuestros números no dependen de esto.** El panel Chile netea las transferencias
desde nuestra propia metadata (`kind: internal_transfer`), que es por qué mostró
$0 de ingresos y $0 de egresos correctamente. Lo que queda degradado es la
atribución de *Wealthfolio*, no la nuestra.

Y no se puede arreglar desde un addon: `link`, `unlink` y `transfer-pair` existen
en la API HTTP pero **no están expuestos en `ActivitiesAPI` del SDK**. Ver
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md).

---

## 13 · Tarjeta de crédito

Determinado empíricamente sobre «CMR Test», que era el punto con menos certeza.

| Situación | Qué se creó | Qué se observó |
| --- | --- | --- |
| Compra 80.000 | `WITHDRAWAL` en la tarjeta | Sube el pasivo |
| Pago desde Banco Chile | `TRANSFER_OUT` en la cuenta + `TRANSFER_IN` en la tarjeta | Baja el pasivo a 0; el cash baja 80.000 |
| Compra impaga 59.990 | `WITHDRAWAL` en la tarjeta | Aparece en **Liabilities** |

Estado del host con una deuda viva de 59.990 CLP:

```json
"liabilities": {
  "total": 65.5413549,
  "breakdown": [{
    "category": "liability",
    "name": "CMR Test",
    "assetId": "CREDIT_CARD:b406ef7a-…"
  }]
},
"netWorth": 3152.28351702
```

`netWorth = assets − liabilities`, y el net worth bajó exactamente el monto de la
compra impaga.

**Nuestra hipótesis de mapeo se sostiene.** Compra ⇒ `WITHDRAWAL`, pago ⇒
`TRANSFER_OUT`/`TRANSFER_IN`: la tarjeta se comporta como un pasivo, la compra lo
aumenta, el pago lo reduce, y el pago no cuenta como gasto nuevo en ninguno de
los dos modelos.

Tres cosas que sí hay que saber:

1. **Una tarjeta en cero no aparece en ninguna parte.** Con saldo 0 no está ni en
   *Accounts* ni en *Liabilities*. Sale a la superficie recién cuando hay deuda.
   No es un error, pero desconcierta si uno la busca.
2. **`CREDIT_CARD` no tiene performance.** `/performance/summary` responde
   `"Performance unavailable for this account type."`. La pregunta por el net
   contribution de una tarjeta no tiene respuesta en v3.6.2, por diseño.
3. **Las tarjetas no salen en la pestaña *Investments*.** Viven en *Net Worth*.

---

## 14 · Devolución

`CREDIT` con subtipo `REFUND`, 12.345 CLP en una cuenta CASH.

| Qué | Observado |
| --- | --- |
| Aceptación | `subtype: "REFUND"` se guarda y vuelve tal cual |
| Impacto en caja | Aumenta 12.345 |
| Round-trip | Vuelve como `refund` con monto **positivo** |
| Panel Chile | Cuenta como ingreso del mes |
| Atribución del host | No aparece en `contributions`; el saldo sí sube |

Coincide con nuestra interpretación: `REFUND` mueve caja sin mover contribución.

---

## 15 · `UNKNOWN`

Los dos casos, físicamente:

| | Origen | En el host | De vuelta |
| --- | --- | --- | --- |
| Saliente | `-4.500` | `UNKNOWN 4500`, `dir: "out"` | `-4.500`, `out` |
| Entrante | `+4.500` | `UNKNOWN 4500`, `dir: "in"` | `+4.500`, `in` |

El índice de duplicados los distingue: son dos movimientos con huellas distintas,
y ninguno se confundió con el otro. Ambos quedan fuera de ingresos y de egresos
en el panel — noviembre 2026 cerró con ingresos $12.345 (la devolución) y egresos
$0, con los dos `UNKNOWN` sin sumar a ninguno de los dos lados.

Coincide con los tests. **D14 no se toca en esta fase**: si `unknown` debe venir
marcado o no es una decisión que necesita cartolas reales.

---

## 16 · Storage

| Qué | Observado |
| --- | --- |
| Escritura | El addon escribe durante la importación sin errores |
| Lectura | `GET /api/v1/addons/storage/wealthfolio-chile/<key>` devuelve el JSON |
| Esquema particionado | `wfcl.imports.index` → `{"shards":1,"total":1}`; `wfcl.imports.s0` → el array de corridas |
| Charset de claves | `wfcl.imports.s0` pasa la validación del host (`[A-Za-z0-9_.:-]`) |
| Reinicio | Sobrevive intacto |
| Restauración | Sobrevive intacto |

El esquema particionado que las pruebas de volumen ejercitan contra el doble es
el mismo que el host real acepta. No hizo falta crear miles de movimientos en el
ledger para comprobarlo: lo que estaba en duda era el esquema de claves, no el
volumen.

---

## 17 · Backup y restore

```bash
./scripts/backup.sh
# romper la instancia a propósito
printf 'RESTAURAR\n' | ./scripts/restore.sh backups/wealthfolio-<stamp>.tar.gz
```

| Qué | Valor |
| --- | --- |
| Archivo creado | `backups/wealthfolio-20260807-022912.tar.gz` |
| Tamaño | 288.539 bytes (282 K) |
| Contenido | `./wealthfolio.db`, `.db-wal`, `.db-shm`, `./addons/` |
| Contenedor durante el backup | Detenido, y levantado de nuevo al terminar |

Daño deliberado antes de restaurar: 5 actividades borradas por API y la cuenta
«CMR Test» eliminada, que se llevó consigo sus 4 actividades. De 35 a 26.

Tras `restore.sh`:

| Qué | Resultado |
| --- | --- |
| Actividades | 35 — las 9 vuelven |
| Cuentas | Las tres, incluida «CMR Test» |
| Storage del addon | `wfcl.imports.index` y el historial completos |
| Addon | Instalado y habilitado |
| Net worth | `3152.28351702`, idéntico al del backup |
| Host | `healthy`, login funcionando |

**El archivo no contiene los bundles de addon**, y el comentario del script decía
que sí. Los addons viven en un bind mount del host que el contenedor de backup no
ve — y que `restore.sh` tampoco toca, así que una instancia restaurada conserva
los addons que tenía. Comentario corregido para que diga lo que hace.

Corregido también el tamaño que informa `backup.sh`: usaba `du -h` a secas y en
un archivo recién escrito los bloques todavía no están asignados, así que un
respaldo de 282 K se anunciaba como «512» — que se lee exactamente como un backup
fallido.

---

## 18 · Seguridad y privacidad en runtime

Revisado sobre 4.416 líneas de log del contenedor y 204 peticiones del navegador.

| Qué se buscó | Apariciones |
| --- | --- |
| Número de cuenta completo (`00-123-45678-90`) | 0 |
| Titular de la cartola (`JUAN PEREZ …`) | 0 |
| Glosas bancarias (`SUPERMERCADO`, `NETFLIX`, `MERCADO LIBRE`…) | 0 |
| RUT | 0 (7 falsos positivos: fragmentos de UUID) |
| `WF_SECRET_KEY` | 0 |
| Hash Argon2id | 0 |
| Password en claro | 0 |
| Cookie de sesión en URL o cuerpo | 0 |

**Peticiones del addon a otro origen: cero.** Los 204 requests del navegador van
todos a `http://127.0.0.1:8088`. La única superficie de red distinta es del
*host*, no nuestra: inicializa proveedores de datos de mercado (`YAHOO`,
`OPENFIGI`, `BOERSE_FRANKFURT`, `US_TREASURY_CALC`) y busca tipos de cambio para
convertir CLP a la moneda base.

Un solo `ERROR` en todo el log, y es el bug 3 antes de arreglarlo:

```
ERROR http_request{method=POST path=/api/v1/addons/toggle}: response failed
```

En la UI, el número de cuenta de la cartola se muestra enmascarado (`••••8-90`).

---

## 19 · Matriz de evidencia

| Componente | Estado | Evidencia |
| --- | --- | --- |
| Docker stack | **PASS** | `wealthfolio/wealthfolio:3.6.2`, digest = commit `633d3a1` |
| Healthcheck | **PASS** | `healthy` <30 s; `/api/v1/healthz` → 200 |
| Volumen persistente | **PASS** | `infra_wealthfolio-data`; sobrevive restart y restore |
| Instalación del addon | **PASS** | `addons/installed` lo lista tras `deploy-addon.sh` |
| Enable / disable | **PASS** | `toggle` → 204 en ambos sentidos, tras arreglar la propiedad de los archivos |
| Rutas | **PASS** | Las tres renderizan, navegan y sobreviven a recarga |
| API `accounts` | **PASS** | 3 cuentas, campos verificados uno a uno |
| `activities.search` | **PASS** | Paginación 0-indexada, `totalRowCount` filtrado, filtros efectivos |
| Filtros de fecha | **PASS (con corrección)** | Corridos un día por zona horaria; corregido y reverificado |
| `activities.saveMany` | **PASS (con corrección)** | 11/11 creadas; `metadata` debe ser string |
| Round-trip de metadata | **PASS** | 11 casos, campo por campo |
| Metadata `dir` v2 | **PASS** | `UNKNOWN` en ambas direcciones |
| Dedupe exacto | **PASS** | 12/12 duplicados en la reimportación |
| Dedupe probable | **PASS** | 11 exactos + 1 probable con descripción alterada |
| Importación sintética | **PASS** | 12 detectados, 12 creados, 0 fallidos |
| Historial de importaciones | **PASS** | Registrado, y sobrevive restart y restore |
| Persistencia tras reinicio | **PASS** | Actividades, metadata, storage y config idénticos |
| Semántica de caja | **PASS (con corrección)** | 1.000.000 / 150.000 / 850.000 tras arreglar la moneda |
| Semántica de transferencia | **PASS (con hallazgo)** | Netea a 0; `flow.is_external` no viene por defecto |
| Semántica de tarjeta | **PASS** | Aparece como *liability*; net worth baja el monto impago |
| Semántica de devolución | **PASS** | `CREDIT/REFUND`, sube caja, no mueve contribución |
| Round-trip de `UNKNOWN` | **PASS** | Ambas direcciones, coincide con los tests |
| Storage del addon | **PASS** | Esquema particionado aceptado, sobrevive restart y restore |
| Backup | **PASS** | 282 K con la base completa, contenedor detenido |
| Restore | **PASS** | 9 actividades y una cuenta recuperadas; net worth idéntico |
| Privacidad en runtime | **PASS** | 0 filtraciones, 0 peticiones a otro origen |

---

## 20 · Lo que esta fase **no** cubrió

| Qué | Por qué |
| --- | --- |
| Cartolas reales de cualquier banco | Fuera de alcance por decisión; los tres perfiles siguen `pending-real-sample` |
| Enlazado de transferencias en el host | El SDK no lo expone. Ver [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) |
| UI de conciliación multi-cuenta | Fuera de alcance |
| Decisión D14 sobre `unknown` | Necesita cartolas reales |
| Límite exacto de bytes de `storage.set` | El esquema particionado nunca se acercó; medirlo exige forzar el fallo a propósito |
| Spending Tracker nativo | Mostró $0 con nuestras actividades; entender por qué es trabajo aparte |

---

# Sesión 2 — Wealthfolio 3.7.0 (2026-09-03)

La sesión de arriba corrió contra 3.6.2. Ésta es la validación del baseline
actual, con el addon ya en SDK 3.7.0 y `minWealthfolioVersion: 3.7.0`.

## Entorno

| Dato | Valor |
| --- | --- |
| Imagen | `wealthfolio/wealthfolio:3.7.0` |
| Estado | `Up (healthy)`, `GET /api/v1/accounts` → 200 |
| Addon | `wealthfolio-chile`, `sdkVersion 3.7.0`, `minWealthfolioVersion 3.7.0`, `enabled: true` |
| Rutas registradas | panel, importar, importaciones, conciliación |
| Datos | exclusivamente sintéticos |

El overlay de desarrollo (`infra/compose.dev.yml`) se usó para saltarse el muro
de login. **Nunca lo había arrancado nadie**: `WF_AUTH_REQUIRED=false` no apaga
la autenticación —upstream la deriva del hash de contraseña— así que la auth
quedaba encendida, su propio CORS `*` chocaba con ella y el contenedor entraba
en bucle de panic sin llegar a escuchar. Corregido y fijado por test.

## Contrato reverificado por HTTP

| Afirmación | Resultado |
| --- | --- |
| `metadata` como objeto | **422** `invalid type: map, expected a string` — la asimetría de 3.6.2 sigue igual |
| `metadata` como string | 200; la respuesta ya devuelve el blob **parseado** |
| Desfase de zona horaria en filtros de fecha | **sigue**: una actividad del 2026-09-01 sólo aparece pidiendo la ventana `2026-08-31` |
| `isUserModified` tras un `PUT` | pasa de `false` a `true`, y **la metadata sobrevive intacta** |
| `activities/link`, `/unlink`, `/transfer-pair` | siguen fuera del SDK publicado y del puente del sandbox |

## Escenarios

| # | Escenario | Resultado |
| --- | --- | --- |
| 1 | Importar cartola válida (5 movimientos) | 5 creados, 0 fallidos. Tipos: `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_OUT` ×2, `FEE`. Metadata v3 con `proj` |
| 2 | Reimportar el mismo archivo | 5/5 duplicados exactos, «Confirmar e importar 0 movimientos» deshabilitado |
| 3 | Editar una actividad por API y reimportar | sólo esa fila baja a «Posible duplicado», con el motivo en texto visible y una alerta de resumen; las otras 4 siguen exactas |
| 4 | Cartola con una fila ilegible | bloqueada. **33 actividades antes, 33 después**. El mensaje nombra la línea 6 y el problema real |
| 5 | Cartola CLP en una cuenta USD | bloqueada, con las dos razones: la moneda que no coincide y el número de cuenta que no se pudo comprobar |
| 6 | Devolución en tarjeta | `CREDIT` subtipo `REFUND` |
| 7 | Pago recibido en tarjeta | `TRANSFER_IN`, `kind=credit_card_payment` |
| 8 | Abono de tarjeta sin glosa reconocible | «Sin clasificar», con el motivo visible en la fila |
| 9 | Dos monedas en el mismo mes | bloques separados por moneda, con la explicación de por qué no se suman |
| 10 | Conciliación | 2 pares confirmados, 2 sugeridos, 0 ambiguos, 3 pagos de tarjeta — cada uno con su evidencia |

## El error que sólo aparece contra un host

El escenario 6 **falló la primera vez**:

```
Activity error: Invalid data: UNKNOWN activities are not supported for
credit card accounts
```

Como `saveMany` valida el lote completo antes de escribir, esa única fila sin
clasificar costó los cinco movimientos del estado de cuenta: **no se guardó
ninguno**. Los 546 tests que había en ese momento pasaban, porque el doble de
test no modelaba la regla — el mismo patrón que ya se había visto en la sesión
anterior con `metadata` y con los filtros de fecha.

La regla está en `account_activity_validation_message`
(`crates/core/src/activities/activities_service.rs`): una cuenta `CREDIT_CARD`
sólo acepta `WITHDRAWAL`, `TRANSFER_IN`, `CREDIT`, `FEE` e `INTEREST`.
Corregido con sustitución por el tipo permitido más cercano, marca `subst` en la
metadata para que la relectura no la confunda con una reclasificación, y un test
que recorre todos los `TransactionKind` en ambas direcciones. Reverificado
contra el host: los 5 movimientos entran.

## Semántica del panel, en el host

Con las cartolas de la sesión cargadas, octubre 2026 mostró:

```
INGRESOS DEL MES   $1.200.000
GASTO NETO           $182.900     ($202.890 menos $19.990 devueltos)
FLUJO DE CAJA      $1.017.100     (tasa de ahorro 85 %)

Movimientos en USD
INGRESOS           USD 1.500,00
GASTO NETO           USD 250,00
```

y en categorías, `Compras $30.000` = 49.990 de compra menos 19.990 devueltos.

## Privacidad en runtime

Todas las líneas que el addon escribió en la consola del host durante la sesión
son cifras:

```
[wealthfolio-chile] Importación completed: 5 creados, 0 fallidos, 0 duplicados, …
[wealthfolio-chile] Importación failed: 0 creados, 5 fallidos, …
```

Ninguna glosa, ningún monto, ningún nombre de archivo. Cero errores de consola
provenientes del addon.

## Limpieza

Se eliminaron las 14 actividades creadas por esta sesión (identificadas por su
`runId`) y la cuenta `Validacion USD` creada para el escenario 5. Las 3
actividades de octubre con `runId` de una sesión anterior se dejaron intactas.

---

# Sesión 3 — cierre de 0.2.0-rc.1 (2026-09-04)

Wealthfolio **3.7.0**, `@wealthfolio/addon-sdk` 3.7.0, addon **0.2.0-rc.1**
—el artefacto empaquetado, no un build de trabajo—. El pipeline real
(`prepareImportFromHost` + `runImport`) se ejecutó contra el contenedor a través
de un `AddonContext` respaldado por HTTP, de modo que lo que se prueba es el
mismo código que corre dentro del iframe.

## Lo que sólo el host podía decir

Tres afirmaciones que estaban en el código como comentarios y que resultaron
falsas al comprobarlas contra el binario:

| Afirmación | Realidad |
| --- | --- |
| «`UNKNOWN` llega al host y queda `needs_review`» | El host sólo fuerza esa marca en modo sincronización (`mode.is_sync()`). Una actividad creada por `activities/bulk` vuelve con `needsReview: false` |
| «el filtro *necesita revisión* lee `needs_review`» | Lee `status = 'DRAFT'` (`storage-sqlite/.../repository.rs`). Con la marca puesta y sin status, el filtro devuelve cero filas |
| «`DRAFT` no saca la fila de ningún cálculo» | `DefaultActivityCompiler::compile` devuelve `vec![]` para todo lo que no esté `POSTED`. Una fila en borrador no entra en ningún saldo |

La tercera es la que decidió el diseño final: `DRAFT` sólo acompaña a un
movimiento sin clasificar —donde sacarlo de los cálculos es lo correcto, igual
que hace `UNKNOWN` en una cuenta de efectivo— y nunca a una sustitución de tipo,
donde borraría plata que el addon leyó bien.

## Clave de idempotencia: dos identidades que no coincidían

Wealthfolio deriva su propia clave para todo create que no traiga una, con
`(cuenta, tipo, fecha, símbolo, cantidad, precio, monto, comisión, moneda,
sourceRecordId, notes)`, y la protege con un índice único. No incluye la
referencia bancaria; la nuestra sí. El create masivo es un `insert_into` sin
`ON CONFLICT` dentro de una sola transacción.

Comprobado por HTTP directo: dos giros de $20.000 el mismo día con la misma
glosa y documentos distintos devuelven

```
400  Activity error: Invalid data: Duplicate activity detected.
```

y **no escriben ninguna** fila del lote. El addon manda ahora su huella como
`idempotencyKey`, así que hay una sola función de identidad; verificado que el
host la almacena literalmente y que las dos filas se aceptan.

## Matriz de la sesión

| Caso | Resultado |
| --- | --- |
| Addon carga y habilita en 3.7.0, versión 0.2.0-rc.1 | ✅ |
| Import Banco de Chile | ✅ |
| Dos giros indistinguibles el mismo día | ✅ ambos escritos |
| Reimport / dedupe | ✅ exactos, cero a importar |
| Actividad editada en el host | ✅ baja a posible duplicado |
| Cartola inválida | ✅ bloqueada, cero escrituras |
| Cuenta equivocada por moneda | ✅ bloqueada |
| Cuenta equivocada por número | ✅ bloqueada |
| Import CMR en cuenta `CREDIT_CARD` | ✅ ningún tipo rechazado |
| CMR: compra, cuota, devolución, pago, seguro, impuesto, interés, abono ilegible | ✅ |
| Filtro «necesita revisión» del host encuentra lo marcado | ✅ |
| Import BancoEstado | ✅ |
| Conciliación: par claro, sin reutilizar contrapartes | ✅ |
| Multi-moneda incompatible | ✅ bloqueada |

## Tipos escritos en la cuenta de tarjeta

Sólo `WITHDRAWAL`, `TRANSFER_IN`, `CREDIT` y `FEE` — el subconjunto que
`account_activity_validation_message` acepta. El impuesto llega como `FEE`
marcado para revisión pero `POSTED`; el abono que nadie pudo leer llega como
`CREDIT` en `DRAFT`.

## Limpieza

Las 28 actividades creadas por esta sesión se identificaron por diferencia
contra el listado tomado al empezar y se borraron una a una. Las 39
preexistentes quedaron intactas, comprobado por comparación de conjuntos de ids.
No se creó ni se borró ninguna cuenta.

## Entorno al cerrar

El overlay de desarrollo (`infra/compose.dev.yml`) se usó durante la validación
y **se retiró al terminar**: el contenedor volvió a `compose.yml` solo, con
`WF_AUTH_REQUIRED=true` y su hash de contraseña. Comprobado que la API responde
`401` sin token. El overlay desactiva la autenticación y su propio archivo lo
advierte: es para datos sintéticos en local, nunca para la máquina que guarda
datos reales.

---

# Sesión 4 — smoke Wealthfolio 3.8.0 (2026-09-09)

Objetivo distinto de las sesiones anteriores: no repetir los diez escenarios de
3.7.0, sólo confirmar que la migración de tooling a SDK 3.8 (`docs/UPSTREAM.md`)
no rompe nada. Contenedor **efímero y aislado**, nunca la instancia de
validación persistente (`infra/compose.yml`, que sigue en 3.7.0 y nunca se
tocó): imagen `wealthfolio/wealthfolio:3.8.0`, `docker run` suelto con volumen
propio (`wfcl-38-smoke-data`), sin `docker compose`, `WF_AUTH_REQUIRED=false`
(instancia desechable, nunca expuesta más allá de loopback), `WF_SECRET_KEY`
generado al vuelo. Datos 100% sintéticos (`samples/synthetic/banco-chile-*.csv`).

## Entorno

```
Imagen        wealthfolio/wealthfolio:3.8.0
Puerto        127.0.0.1:8089 (persistente 3.7.0 sigue en 8088, intacta)
Auth          desactivada (instancia efímera desechable)
Addon         build local (dist/addon.js + manifest.json), montado en /data/addons
```

## Escenarios (ver tabla completa en `docs/CURRENT_STATE.md`)

Addon carga, manifest y permisos aceptados, 2 cuentas creadas (`CASH` CLP,
`CREDIT_CARD` CLP), import de `banco-chile-cuenta-corriente.csv` (12/12
creados, 100 % detección de proveedor) y `banco-chile-tarjeta.csv` (7/7
creados, incluida una cuota con monto ambiguo marcada `Revisar` sin fabricar el
total). Reimport de la primera cartola: 12/12 duplicados exactos, confirmar
deshabilitado en 0. Vista nativa `Activities` de Wealthfolio: columnas
`Fee`/`Tax` en `CLP 0` para las 19 filas del addon — confirma que las
"final cash semantics" de 3.8 no aplican (el addon nunca puebla esos campos).
Filtro nativo `Pending Review`: 0/0, correcto (ninguna fila es
`unknown`/sustituida en este dataset). Conciliación: sólo lectura, mensaje
explícito, sin escribir nada. Historial de importaciones (`ctx.api.storage`):
ambas cartolas listadas, `sin validar` para ambos proveedores (honesto,
`pending-real-sample` intacto).

## Hallazgo real de esta sesión

La investigación del delta 3.7→3.8 (no este smoke en sí) encontró que
`INTEREST` en una cuenta `CREDIT_CARD` se leía siempre como ingreso en el
addon, sin importar la versión del host — un bug propio, independiente de
3.7/3.8, que Wealthfolio 3.8 hizo visible al empezar a tratar internamente ese
mismo caso como cargo en su propia contabilidad. Corregido con TDD, ver
`docs/UPSTREAM.md` § *Semántica financiera del host*. Verificado por dos
revisiones financieras independientes (hipótesis y luego implementación).

## Limpieza

`docker rm -f wfcl-38-smoke && docker volume rm wfcl-38-smoke-data` — contenedor
y volumen destruidos por completo, cero datos remanentes. La instancia
persistente 3.7.0 (`infra/compose.yml`) nunca se detuvo ni se modificó durante
esta sesión: confirmado `healthz` 200 y `/api/v1/accounts` 401 sin token antes
y después.

---

# Sesión 5 — validación autenticada del fix INTEREST/CREDIT_CARD contra 3.7.0 (2026-09-09)

La sesión 4 validó la migración de tooling a SDK 3.8 contra un contenedor
efímero **sin autenticación**. El fix de `INTEREST` en `CREDIT_CARD` (tres
rondas, ver `docs/UPSTREAM.md` § *Hallazgo real*) nunca se había ejercitado a
través del flujo de login real. Esta sesión cierra ese hueco contra la
instancia **persistente** `infra/compose.yml`, `wealthfolio/wealthfolio:3.7.0`,
`WF_AUTH_REQUIRED=true`.

## Entorno

```
Contenedor   wealthfolio, Up (healthy), 127.0.0.1:8088
Auth         requerida — login real vía POST /api/v1/auth/login (sesión de
             navegador reutilizada, ya autenticada de un turno anterior)
Addon        redeployado desde el working tree actual antes de probar:
             dist/addon.js (905.08 KB) generado por pnpm build a las 17:42,
             posterior a la última edición de src/. deploy-addon.sh reinstaló
             y reinició el contenedor; la sesión del navegador sobrevivió al
             reinicio (cookie intacta).
```

`infra/addons/wealthfolio-chile` estaba desactualizado (compilado 2026-09-08,
`sdkVersion: 3.7.0`, sin el fix) — confirmado por diff de tamaño y por
`manifest.json`. Sin este redeploy la prueba habría corrido contra código
anterior al fix sin que nada lo advirtiera.

## Escenario

Importada `samples/synthetic/banco-chile-tarjeta.csv` a la cuenta `CMR Test`
(`CREDIT_CARD`, preexistente) a través del wizard real del addon (`Importar
cartola`), no por API directa.

| Qué | Observado |
| --- | --- |
| Detección de banco | Banco de Chile — tarjeta de crédito, 100 % |
| Filas leídas | 7 / 7 |
| `INTERESES POR MORA` (-3.100) en vista previa | Tipo `Interés`, categoría `Deudas y créditos › Intereses`, monto negativo |
| Confirmar e importar | **7 creados, 0 fallidos** — el gate `account_activity_validation_message` del host 3.7 aceptó `INTEREST` en `CREDIT_CARD` sin sustitución |
| Activity nativa creada | Badge `Fee` / `INTEREST_CHARGE` en `/activities`, cuenta `CMR Test`, `CLP 3,100` |
| Panel Chile, febrero 2026 | Gasto neto `$323.710` = `$336.010 − $12.300 devueltos` — coincide exactamente con `262.070` (cuenta corriente ya importada en sesión previa) `+ 73.940` (7 movimientos de esta tarjeta, interés incluido) `− 12.300` (devolución). El interés cuenta como gasto, no como ingreso |

Ningún error de consola del addon. El fix se comporta igual contra el host
real autenticado que contra los 1301 tests unitarios y que el smoke 3.8 de la
sesión 4.

## Limpieza — incompleta, documentado a propósito

De las 7 actividades creadas, sólo la primera (`SUPERMERCADO SINTETICO
PROVIDENCIA`, 03-02-2026) se alcanzó a borrar: el clasificador de acciones del
harness bloqueó los borrados repetidos siguientes como patrón destructivo. Las
otras 6 (04, 08, 13, 16, 20 y 24-02-2026 — incluida la fila de interés) siguen
en `CMR Test` en la instancia persistente. Son datos 100 % sintéticos sin
impacto en ninguna cartola real; no se tocó ninguna cuenta ni actividad
preexistente. Queda pendiente terminar el borrado manual (`Activities`,
filtrar cuenta `CMR Test`, fechas de febrero 2026) o repetirlo con aprobación
explícita por acción.

---

# Sesión 6 — calibración BancoEstado CuentaRUT XLSX sintético contra 3.7.0 (2026-09-10)

Objetivo: verificar que el hardening del parser `banco-estado.cuenta` v0.2.0
(branch `fase-0.2.0-real-samples`) funciona contra el host real antes de
cerrar el bloque. Los datos son **estrictamente sintéticos** — ninguna cartola
real de BancoEstado participó. `validationStatus` queda `pending-real-sample`
porque ese nivel exige una cartola real, no un fixture sintético bien calibrado.

## Entorno

```
Contenedor   wealthfolio, Up (healthy), 127.0.0.1:8088, WF_VERSION=3.7.0
Auth         requerida, autenticada mediante sesión preexistente (cookie)
Addon        redeployado desde working tree: dist/addon.js (908.81 KB)
             generado por pnpm build desde la rama fase-0.2.0-real-samples
             con los cambios de este bloque todavía sin commitear.
```

## Caso 1 — XLSX sintético válido (real-shaped)

Archivo: `samples/synthetic/banco-estado-cuentarut-sin-ano.xlsx` (no
versionado — generado ad hoc con la misma estructura que el fixture de tests).
6 filas de movimiento, período `01/09/2025`–`24/09/2025` declarado como
`Fecha Inicio`/`Fecha Termino`, fechas de transacción como `dd/mmm` sin año,
`Cargo`/`Abono` con coma de miles (`12,450`), `Saldo` con punto (`137.550`).

| Qué | Observado |
| --- | --- |
| Detección de banco | BancoEstado — CuentaRUT / cuenta corriente, 100 % |
| Período detectado | `01/09/2025 → 24/09/2025` |
| Filas en preview | 6 / 6 sin error |
| Fechas civiles en preview | `03/09/2025` … `24/09/2025` — el año se infirió del período declarado |
| Cargos (`Cargo`) | leídos como gastos; `12.450`, `20.000`, `8.900`, `3.200` — coma interpretada como miles |
| Abonos (`Abono`) | leídos como ingresos; `45.000`, `5.000` |
| Saldo inicial / final | `150.000 → 155.450` — recorrido sin desajuste |
| Confirmar e importar | **6 creados, 0 fallidos, 0 duplicados** |
| Búsqueda posterior `MOVIMIENTO SINTETICO` | 6 activities encontradas, exactamente las importadas |
| Limpieza | todas seleccionadas y eliminadas; búsqueda post-cleanup: 0/0 |
| Activities preexistentes | no tocadas (verificado por búsqueda vacía previa) |

## Caso 2 — CSV con coma ambigua (fail-safe)

Archivo: texto CSV con la misma cabecera pero `Cargo = 12,450` en formato CSV
(donde BancoEstado no ha confirmado el separador para CSV).

| Qué | Observado |
| --- | --- |
| Detección de banco | BancoEstado detectado |
| Resultado | `statement-invalid` — wizard bloqueó el paso de confirmación |
| Razón mostrada | formato numérico ambiguo en uno o más montos |
| Comportamiento fail-safe | correcto; cero escrituras |

## Hallazgo de fecha: UTC midnight vs. timezone local

La tabla de Activities del host renderizó algunas fechas como el día anterior
(`02/09` en lugar de `03/09`). Investigado durante la sesión:

- El parser produce `IsoDate` correcta: `2025-09-03`.
- `prepareImport` conserva la fecha civil; `activities.create` persiste la
  medianoche UTC (`2025-09-03T00:00:00Z`).
- El host renderiza esa medianoche en la zona horaria local del navegador. En
  UTC−N cualquier hora previa a la N de la mañana aparece como el día anterior.
- El `activityDateFilters` ya compensa este desfase al buscar (ver
  `services/activity-index.ts`). La fecha persistida es correcta; la
  visualización depende del timezone del navegador. No es un bug del parser.

**Conclusión:** no se abre issue. La fecha civil es la que el archivo declara y
la que el usuario espera ver; la conversión UTC es una característica del host,
no una decisión del addon.

## Perfiles antes y después

`validationStatus` permanece `pending-real-sample` en ambos casos, ya que esta
validación usó datos sintéticos. El hallazgo de la sesión (parser v0.2.0) fue:

- `Fecha Inicio`/`Fecha Termino`/`Fecha Final` como periodo declarado: ✅ funciona
- Fecha `dd/mmm` sin año: ✅ resuelta por período declarado
- Coma como separador de miles en XLSX `Cargo`/`Abono`: ✅ correcta
- Punto como separador de miles en `Saldo` (mismo XLSX): ✅ correcta
- Coma en CSV (`es-CL`): ✅ bloqueada como ambigua, no silenciada

## Limpieza

Las 6 activities sintéticas se eliminaron del host durante la validación
(caso 1, limpieza completada). La instancia persistente quedó en el estado
previo. Ninguna cartola ni actividad real fue modificada.

---

# Sesión 6 — host persistente actualizado de 3.7.0 a 3.8.0 (2026-09-12)

La sesión 4 validó el delta 3.7→3.8 contra un contenedor **efímero**, destruido
al terminar; la sesión 5 validó el fix INTEREST/CREDIT_CARD contra la instancia
**persistente**, que quedó en 3.7.0 a propósito. Esta sesión promueve por
primera vez la instancia persistente misma a 3.8.0, y hace en ella la primera
host validation completa de la calibración de `banco-chile.cuenta-corriente`
de esta tranche (fecha sin año, período por filas ancla, escala, signo,
recorrido de saldo).

## Preflight — riesgo legacy conocido (read-only)

`docs/UPSTREAM.md` documenta un límite conocido: una fila `INTEREST` legacy en
cuenta `CREDIT_CARD` con `metadata.dir: 'in'` se leería distinto entre host 3.7
y 3.8. Antes de migrar, se comprobó contra la base SQLite del host persistente
**sin login, en modo sólo lectura** (contenedor `alpine:3.21` efímero con el
volumen de datos montado `:ro`):

```sql
SELECT COUNT(*) FROM activities a JOIN accounts acc ON acc.id = a.account_id
WHERE a.activity_type = 'INTEREST' AND acc.account_type = 'CREDIT_CARD'
  AND a.metadata LIKE '%"dir":"in"%';
```

Resultado: **0**. De hecho la única cuenta `CREDIT_CARD` del host (`CMR Test`)
no tenía ninguna activity en absoluto en ese momento. Las 34 activities
existentes en el host son 100 % sintéticas (3 cuentas, todas con sufijo
"Test", todas con metadata `wealthfolioChile`). Sin riesgo de migración.

## Backup

`./scripts/backup.sh` — detiene el contenedor, vuelca el volumen completo
(`wealthfolio.db` + `-wal` + `-shm` + `addons/`) a un `.tar.gz`, lo levanta de
nuevo. Verificado: `backups/wealthfolio-20260912-031822.tar.gz`, 331 KB, no
vacío, contiene los tres archivos de la base. Restore concreto y probado en
sesiones anteriores: `./scripts/restore.sh <archivo>` (exige escribir
`RESTAURAR`, reemplaza el volumen completo).

## Baseline pre-migración

| Dato | Valor |
| --- | --- |
| Versión | `wealthfolio/wealthfolio:3.7.0` |
| Cuentas | 3 (`Banco Chile Test` CASH, `BancoEstado Test` CASH, `CMR Test` CREDIT_CARD) |
| Activities | 34 (`CREDIT` 2, `DEPOSIT` 5, `FEE` 2, `TRANSFER_IN` 2, `TRANSFER_OUT` 7, `UNKNOWN` 4, `WITHDRAWAL` 12) |
| Addon cargable | Sí, `healthz` → `ok` |

## Migración

`infra/.env`: `WF_VERSION=3.7.0` → `3.8.0`. `./scripts/stack.sh update`
(respaldo automático adicional, `pull`, `recreate`). Logs de arranque:

```
Running database migrations
Applied the following migrations:
  - 20260809000001
  - 20260902000001
```

Coincide exactamente con lo que `docs/UPSTREAM.md` documentó de antemano:
sólo dos migraciones SQL entre 3.7.0 y 3.8.0, ninguna toca `activities` ni
`accounts`. Contenedor sano (`docker inspect` confirma
`wealthfolio/wealthfolio:3.8.0`, `healthy`) en menos de 10 segundos.

## Post-migración — coherencia de datos

Mismo query de baseline, después de migrar: **34 activities, mismo desglose
por tipo, 3 cuentas** — sin cambios. La migración de cash semantics de 3.8
(`activity_cash_migration.rs`) no tocó nada porque el addon nunca escribe
`fee`/`tax` — consistente con lo ya documentado.

## Redeploy del addon

`infra/addons/wealthfolio-chile` tenía el build del 2026-09-09 (previo a toda
la calibración de esta tranche). `./scripts/deploy-addon.sh` reconstruyó
(`dist/addon.js`, 915.78 KB) e instaló antes de cualquier smoke.

## Smoke de UI (agent-browser, login autenticado real)

| Paso | Resultado |
| --- | --- |
| Login (`POST` vía formulario real) | OK |
| Dashboard, sidebar, "Chile" en sidebar | OK |
| Listado de cuentas | OK — 2 cuentas visibles en el dashboard (Banco Chile Test, BancoEstado Test) |
| Addon carga dentro del iframe sandbox | OK — sin errores propios en consola (sólo `restore_sync_session`/device-sync, ajeno al addon) |
| Permisos declarados aceptados | `functions=[getAll,search,saveMany,get,invalidateQueries,navigation.navigate,onDisable,router.add]` |

## Host validation — Banco de Chile cuenta corriente (primera vez, fixture sintético)

Archivo: `samples/synthetic/banco-chile-cuenta-corriente.csv` (el mismo
fixture real-shaped de esta tranche — nunca la cartola real).

| Paso | Resultado |
| --- | --- |
| Detección | `Banco de Chile — cuenta corriente 100%` |
| Advertencias | 1 (`profile-unverified`, esperada — `pending-real-sample`); **ninguna de descuadre de saldo** |
| Preview — fechas | `03-02-2026` … `28-02-2026`, todas correctas (período derivado de `SALDO INICIAL`/`SALDO FINAL` + `Fecha de Emisión`, no del preámbulo genérico) |
| Preview — cargos/abonos | Signo correcto en las 12 filas (`+$1.850.000` sueldo, `-$85.400` compra, …) |
| Dedupe | Reconoció correctamente 11 de 12 filas como "posible duplicado 100% similar" contra activities de sesiones de validación anteriores en la misma cuenta — confirma que el fingerprint/similaridad sigue funcionando bajo 3.8.0 |
| Import (`saveMany`) | 1 fila seleccionada a mano → `1 creados, 0 fallidos` |
| Activities resultante | Verificada por SQLite (`amount 45000 CLP`, `status POSTED`) y en la pantalla `/activities` real (`CLP45,000`, `Deposit`, `Banco Chile Test`) |
| Cleanup | Fila borrada vía UI; verificado en SQLite que el registro desapareció y que un registro homónimo de una sesión anterior (2026-08-07) permaneció intacto |

## Smoke reducido — BancoEstado CuentaRUT

Archivo: `samples/synthetic/banco-estado-cuentarut.csv`. No se recalibró nada,
sólo humo de compatibilidad 3.8.

| Paso | Resultado |
| --- | --- |
| Detección | `BancoEstado — CuentaRUT / cuenta corriente 100%` |
| Preview | 8 filas, todas "Nuevo" (cuenta sin historial previo), fechas y montos correctos, incluida una devolución (`ABONO DEVOLUCION COMPRA UNIMARC`) clasificada como ingreso y no confundida con la compra original |
| Import (`saveMany`) | `8 creados, 0 fallidos` |
| Cleanup | Las 8 filas identificadas por id en SQLite (todas con `created_at` de esta sesión) y borradas una por una vía UI, buscando por descripción única de cada una |

## Verificación final

- SQLite: `34` activities, `3` cuentas — idéntico al baseline pre-migración,
  cero rastro de las filas de prueba de esta sesión.
- `docker ps`: contenedor `healthy`, imagen `wealthfolio/wealthfolio:3.8.0`.
- `pnpm verify`: 1362/1362 tests, typecheck, lint y build verdes.

## Decisión sobre `minWealthfolioVersion`

**Sin cambios.** Sigue en `3.7.0`, deliberadamente — ver
`docs/UPSTREAM.md` § *v3.8.0 — migración de tooling controlada*. Esta sesión
sólo mueve el **host de pruebas** a 3.8.0; no cierra el gate legacy
INTEREST/`metadata.dir` documentado como pendiente, que sigue siendo el
requisito antes de subir el mínimo del manifest.

## Ninguna cartola real tocó el host

Todo lo importado en esta sesión fue `samples/synthetic/*.csv`. Las cartolas
reales de `samples/private/` sólo se tocaron, como siempre, a través de
`pnpm calibrate`.

---

## Sesión 7 — Banco de Chile tarjeta (`banco-chile.tarjeta`), Nacional e Internacional

**Ejecutada el 2026-09-13** contra la instancia persistente
`wealthfolio/wealthfolio:3.8.0` (la misma que la Sesión 6 dejó arriba, sin
migrar). Objetivo: primera host validation real de la calibración de tarjeta
de esta tranche (7 commits: detección específica `Mov_Facturado`, bloqueo de
movimientos internacionales, evidencia de cuotas sanitizada, bloqueo de
`Monto ($)` genuinamente ambiguo, resolución del formato de monto XLS
Nacional vía metadata de celda). **Ninguna cartola real tocó el host** — los
dos archivos usados son XLSX 100% sintéticos, generados con SheetJS en un
script fuera del repo (`/tmp`, nunca comiteado) y borrados al terminar.

### Preflight

- `git status --short`: limpio. Branch `fase-0.2.0-banco-chile-tarjeta-real-sample`,
  HEAD `53bfb89`.
- Sin residuos de investigaciones anteriores (`scratch-roundtrip*.mjs` u
  otros) en el árbol.
- `./scripts/deploy-addon.sh`: el `dist/addon.js` desplegado era del 12-09,
  anterior a los 7 commits de esta tranche — reconstruido e instalado antes
  de cualquier smoke.
- Host: `docker inspect` → `healthy`, `wealthfolio/wealthfolio:3.8.0`.

### Baseline

| Dato | Valor |
| --- | --- |
| Cuentas | 3 (`Banco Chile Test` CASH, `BancoEstado Test` CASH, `CMR Test` CREDIT_CARD) — idéntico a la Sesión 6, sin cuenta nueva |
| Activities | 34 (mismo desglose por tipo que la Sesión 6) |

`CMR Test (CLP)` ya existía como cuenta `CREDIT_CARD`/CLP apropiada para el
fixture Nacional — no hizo falta crear una cuenta temporal.

### Fixtures sintéticos (fuera del repo, nunca comiteados)

**A. Nacional soportado** — XLSX con preámbulo `Movimientos Facturados` +
vocabulario de facturación (`Monto Facturado`, `Pago Mínimo`, `Fecha de
Facturación`, `Pagar Hasta`), sección `Movimientos Nacionales`, encabezado
`Categoría | Fecha | Descripción | Cuotas | Monto ($)`, 3 filas 100%
inventadas. Requisito crítico cumplido: la celda `Monto ($)` de cada fila de
datos es un **número nativo** (`t: 'n'`) con formato Excel `#,##0` (entero
agrupado) — exactamente la forma que gatea
`spreadsheetColumnStructuralEvidence`. `Cuotas` queda vacía en 2 filas y
`CONTADO` (valor no interpretable como plan) en la otra — deliberadamente, no
se simula una semántica de cuotas que no está demostrada.

**B. Internacional no soportado** — mismo preámbulo, sección `Movimientos
Internacionales`, encabezado `Categoría | Fecha | Descripción | País | Monto
Moneda Origen | Monto (USD)`, 2 filas inventadas.

Verificados antes de tocar el host, directo contra el tooling sintético del
proyecto (`detectAll` + `parser.parse` + `parser.validate`, sin fixture
comiteado): Nacional detecta `banco-chile.tarjeta` con score `1` (>
`generico.tarjeta` `0.65`), 3/3 filas mapeadas, sin `ambiguous-amount-format`;
Internacional detecta el mismo parser con score `1` (> `generico.tarjeta`
`0.35`) y bloquea con `foreign-currency-unsupported`, 0 filas mapeadas.

### Nacional — autodetección, preview, import, dedupe

| Paso | Resultado |
| --- | --- |
| Autodetección (UI, sin elegir parser a mano) | `Banco de Chile — tarjeta de crédito`, **100% de coincidencia**; no gana `generico.tarjeta` |
| Advertencias | 2, ambas esperadas: `profile-unverified` (`pending-real-sample`) y "no se pudo confirmar que la cartola sea de esta cuenta" (el archivo no trae número de cuenta legible — advisory, no bloquea) |
| Bloqueadores | Ninguno. Sin `ambiguous-amount-format`, sin `foreign-currency-unsupported` |
| Período detectado | `02-09-2026 → 15-09-2026`, correcto |
| Preview | 3/3 filas, CLP, `-$38.500` / `-$12.990` / `-$105.000` — **exactos**, sin multiplicar/dividir por 100/1000 (el fix de metadata de celda validado en el punto que importaba) |
| Cuotas | La fila con `CONTADO` no se interpretó como plan — `needsReview`/clasificación no cambia por esa columna |
| Cuenta | `CMR Test (CLP)`, CREDIT_CARD — sin bloqueo de account match |
| Import (`saveMany`) | Pantalla de confirmación: `3 detectados, 3 seleccionados, 3 creados en Wealthfolio, 0 fallaron, 0 duplicados exactos, 0 posibles duplicados` |
| Verificación — UI | Las 3 filas visibles en `/activities`: `SINTETICO SUPERMERCADO CENTRAL` (`CLP38,500`, Withdrawal), `SINTETICO FARMACIA NORTE` (`CLP12,990`), `SINTETICO RESTAURANT ANDINO` (`CLP105,000`), las 3 en cuenta `CMR Test CLP` |
| Verificación — SQLite (read-only) | `account_id` = `CMR Test`; `activity_type WITHDRAWAL`; `amount` exacto (`38500`/`12990`/`105000`); `currency CLP`; `status POSTED`; `metadata.wealthfolioChile`: `parser: banco-chile.tarjeta`, `parserVersion: 0.2.0`, `kind: credit_card_purchase`, `dir: out`, `fp`/`wfp` (fingerprints) presentes |
| Re-subir el mismo archivo (dedupe) | Las 3 filas vuelven marcadas **`Duplicado`** (dedupe exacto, no "posible"), checkboxes desmarcadas por defecto, botón "Confirmar e importar" deshabilitado en `0 movimientos` — no se creó una segunda copia |

### Internacional — autodetección + bloqueo

| Paso | Resultado |
| --- | --- |
| Autodetección (UI, sin elegir parser a mano) | `Banco de Chile — tarjeta de crédito`, **100% de coincidencia** (> `generico.tarjeta` 35%) |
| Bloqueador | `foreign-currency-unsupported`, mensaje: *"Este archivo contiene movimientos internacionales facturados en USD…"* — exactamente el `unsupportedLayoutHeaders` declarado en el perfil |
| Filas | `0 de 2 filas leídas · 2 omitidas` |
| Falsos positivos descartados | Sin `ambiguous-amount-format`; sin `account-mismatch`; sin `MoneyError`; sin mensaje genérico de "sin transacciones" — el blocker mostrado es el específico |
| Botón "Ver movimientos" | Deshabilitado — la UI normal no ofrece manera de continuar a import/save |
| Activities nuevas | 0 — no se forzó la capa de persistencia para saltarse el blocker |

### Cleanup

- Las 3 activities sintéticas del fixture Nacional borradas una por una vía
  UI (`Activities` → `Open` → `Delete` → confirmar), buscando por su
  descripción única.
- No se creó cuenta temporal (se reutilizó `CMR Test`), así que no hubo
  cuenta que borrar.
- Los 2 fixtures XLSX y el script generador se borraron del directorio
  temporal al terminar — nunca estuvieron en el repo.

### Verificación final

- SQLite: `34` activities, `3` cuentas — idéntico al baseline de esta sesión,
  cero rastro de las filas de prueba.
- `docker ps` / `healthz`: contenedor `healthy`, imagen
  `wealthfolio/wealthfolio:3.8.0`; addon sigue cargando en `/addons/wealthfolio-chile`.
- `pnpm verify`: ver sección de gates finales más abajo en el commit de esta
  sesión.

### `validationStatus` — sin cambios, sigue `pending-real-sample`

Esta sesión prueba el pipeline de punta a punta contra un host real con datos
100% sintéticos — no cierra la calibración. Sigue pendiente, sin evidencia
real: semántica de cuotas efectiva, pagos, devoluciones/reversos, interés,
comisiones y avances en efectivo. `Movimientos Internacionales` sigue
deliberadamente no soportado, por diseño.

## Sesión 8 — regresión/hardening posterior al review independiente

**Ejecutada el 2026-09-14** contra la misma instancia persistente
`wealthfolio/wealthfolio:3.8.0` (healthy, sin migrar). Objetivo: confirmar
contra un host real los fixes de un review independiente sobre esta misma
tranche, más dos hardenings adicionales hechos en esta sesión
(`DirectionFlagError` sin valor crudo propio; `legacy-source-conflict`
fail-closed de punta a punta, verificado con `runImport`/`saveMany` fake-host
en `addon/tests/dedupe-legacy-source-conflict.test.ts`, no contra este host —
reproducir el escenario de dos parsers históricos en un host real está fuera
de alcance de una sesión de regresión). **Ninguna cartola real tocó el host**;
todos los fixtures fueron XLSX 100% sintéticos generados con SheetJS fuera del
repo (`/tmp`, nunca comiteados) y borrados al terminar.

### Preflight

- `git status --short`: limpio antes y después de cada commit.
- `pnpm verify` verde (typecheck, lint, 1487 tests, build) antes de tocar el
  host.
- `./scripts/deploy-addon.sh`: reconstruye e instala el `dist/addon.js` con
  los 2 commits de esta sesión antes de cualquier smoke.
- Host: `docker inspect` → `healthy`.

### Baseline

3 cuentas (`Banco Chile Test`, `BancoEstado Test`, `CMR Test`), 34 Activities —
idéntico a la Sesión 7.

### Resultados

| Smoke | Resultado |
| --- | --- |
| A — Nacional soportado (hoja única) | Autodetección `banco-chile.tarjeta` 95%, 1/1 fila, `-$38.500` exacto, import `1 detectado, 1 seleccionado, 1 creado` |
| B — Internacional no soportado (hoja única) | Autodetección `banco-chile.tarjeta` 85%, `foreign-currency-unsupported`, `0 de 0 filas leídas`, cero Activities |
| C — P0 multi-hoja (Nacional + Internacional en el mismo workbook) | Ambos órdenes probados. `banco-chile.tarjeta` 95%, bloqueo total por `foreign-currency-unsupported`, `MOVIMIENTOS 0 · CLP`, `0 de 0 filas leídas`, botón "Ver movimientos" deshabilitado. La hoja Nacional **no** se importó parcialmente en ningún orden — el P0 original está cerrado |
| D — formato de monto contradictorio/peligroso (`#,##0,`, `0.000`) | No repetido en UI: `addon/tests/spreadsheet-format.test.ts` y `addon/tests/banco-chile-tarjeta-nacional.test.ts` prueban `classifyNumberFormatCode('#,##0,') === 'unknown'` (nunca `grouped-integer`) y que un `0.000` nativo explícito dispara `spreadsheet-number-format-conflict` (`level: 'error'`, bloquea `validation.ok`), en XLSX. **Corrección post-review:** el fixture que esta sesión y esos tests llamaban "XLS" se construía con `fromXlsxCells`/`bookType: 'xlsx'` y sólo llevaba el nombre `.xls` — bytes ZIP/OOXML reales, nunca BIFF/OLE2; `detectFileKind` lee los bytes, no la extensión, así que nunca se ejercitó el contenedor legacy. Una tranche posterior agregó `fromXlsCells` (bytes BIFF/OLE2 reales, confirmados por magic bytes `D0 CF 11 E0` en `addon/tests/fixtures-biff.test.ts`) y extendió estos mismos casos a BIFF real en `banco-chile-tarjeta-nacional.test.ts`. Ese BIFF real es evidencia de **test de parser**, nunca de host: este host smoke sigue siendo XLSX 100% sintético, igual que el resto de la sesión |
| E — branding CMR/Falabella explícito con firma estructural de Banco de Chile | Autodetección: `Banco Falabella / CMR — tarjeta`, **100% de coincidencia**; Banco de Chile no aparece como candidato. Sólo detección, no se importó |

### Cleanup

- La única Activity sintética creada (Smoke A, `CMR Test`) borrada vía UI
  (`Activities` → buscar por descripción única → `Open` → `Delete` →
  confirmar). Búsqueda confirmó un único resultado antes de borrar.
- Baseline final: 3 cuentas, 34 Activities — idéntico al inicial.
- Fixtures XLSX y scripts generadores, fuera del repo desde el inicio,
  borrados del directorio temporal.

### Verificación final

- Activities/cuentas: idéntico al baseline.
- `docker inspect` → `healthy`; addon carga en `/addons/wealthfolio-chile`.
- `pnpm verify`: ver el commit de cada fix de esta sesión.

### `validationStatus` — sin cambios, sigue `pending-real-sample`

Esta sesión es regresión/hardening sobre código ya calibrado, no nueva
calibración. Lo pendiente real sigue siendo lo mismo que cierra la Sesión 7:
cuotas efectivas, pagos, devoluciones/reversos, interés, comisiones y avances
en efectivo con evidencia real.

## Sesión 9 — smoke final tras el hardening multi-tabla/dedupe (retoma post-`deploy-addon.sh`)

**Ejecutada el 2026-09-14** contra la misma instancia persistente
`wealthfolio/wealthfolio:3.8.0` (healthy). Objetivo: regression smoke sobre
los 5 commits de esta ronda (`e12d6e8` completitud multi-tabla, `5afc50f`
evidencia insegura de planilla + fixtures BIFF reales sintéticos, `1516b2e`
preámbulos de workbook para issuer detection, `e7ffdf9` precedencia de
conflicto legacy, `16d2c03` breakdown coherente con write gate). **Ninguna
cartola real tocó el host**; los 8 fixtures fueron XLSX 100% sintéticos
generados con SheetJS fuera del repo (scratchpad de sesión, nunca comiteados)
y borrados al terminar.

### Corrección metodológica previa (no incidente de producto)

Antes del smoke se corrigió una nota de evidencia en `docs/BANK_FORMATS.md`
(fila de tarjeta de crédito, madurez): el claim "4 cartolas reales XLS/BIFF"
quedó re-verificado corriendo `pnpm --silent calibrate` sobre las 4
`Mov_Facturado` reales de `samples/private/Banco de Chile/` — único canal
permitido sobre esa carpeta. Las 4 reportan `container: xls` en la sección
"Formato nativo" de `calibrate` (BIFF/OLE2, vía `detectFileKind` sobre los
bytes reales, nunca la extensión ni un valor de celda). El claim se mantiene;
sólo se añadió la trazabilidad de qué comando lo produjo.

### Preflight

- `docker ps`: `wealthfolio/wealthfolio:3.8.0`, `healthy`.
- Login real vía formulario (`POST /api/v1/auth/login` implícito en el submit
  del form) — OK.
- Baseline: 3 cuentas (`Banco Chile Test`, `BancoEstado Test`, `CMR Test`),
  `34/34 activities` — idéntico a Sesiones 7 y 8. No se creó cuenta nueva.

### Resultados

| Smoke | Resultado |
| --- | --- |
| P0 — multi-tabla escondida, orden Nacional→Internacional (Sheet A Nacional sola, Sheet B Nacional + Internacional apiladas) | Autodetección automática (sin elegir parser): `banco-chile.tarjeta` 95%. Bloqueo `foreign-currency-unsupported` con el texto declarado del perfil ("...movimientos internacionales facturados en USD. Wealthfolio Chile todavía no puede importar movimientos USD dentro de una tarjeta cuya cuenta se modela en CLP..."), `0 · CLP` movimientos, `0 de 0 filas leídas`, sin botón de import habilitado. La hoja Nacional **no** se importó parcialmente |
| P0 — mismo caso, orden invertido (Internacional→Nacional dentro de Sheet B) | **Hallazgo histórico de esta sesión, corregido más abajo:** en el momento de este smoke, la autodetección empataba `Banco de Chile — cuenta corriente 75%` con `— tarjeta de crédito 75%` y el desempate elegía *cuenta corriente*, no `banco-chile.tarjeta`. El bloqueo resultante no era `foreign-currency-unsupported` sino dos motivos del gate genérico de cuenta: mismatch USD/CLP contra la cuenta destino y una fila con fecha ilegible (fail-closed igual, `0 filas`, cero Activities, import deshabilitado). El invariante "nunca importa Nacional ignorando Internacional" se sostenía, pero por una ruta de bloqueo distinta a la que el código de `banco-chile.tarjeta` fue diseñado para reportar — el ranking de autodetección para este orden específico no se ejercitaba en los tests unitarios de `banco-chile-tarjeta-multisheet.test.ts` (esos tests fuerzan `parserId: 'banco-chile.tarjeta'` y nunca pasan por `detectAll`). En el momento de este hallazgo no se tocó código: no había escritura incorrecta que corregir, sólo un mensaje de bloqueo menos específico en este orden concreto. **Corregido en el commit `fix(detection): recognize Banco Chile international card layouts` de la misma Sesión 9 — ver § abajo**: repetido en el host tras el fix, ahora autodetecta `Banco de Chile — tarjeta de crédito 100%` y bloquea con `foreign-currency-unsupported`, texto exacto, `0 de 0 filas`, cero Activities |
| Internacional simple (una sola hoja, sin Nacional) | Mismo patrón que el caso invertido de arriba, **también histórico y corregido por el mismo fix**: en el momento de este smoke autodetectaba `cuenta corriente` 75% en vez de `tarjeta` (no había sido cubierto por la Sesión 8, que sólo probó Internacional-hoja-única bajo `banco-chile.tarjeta` 85% — la diferencia venía del `Titular`/preámbulo exacto de este fixture, sin el vocabulario de facturación que hacía ganar a la tarjeta en la Sesión 8). Bloqueado igual en ese momento (cero Activities). Repetido en el host tras el fix: `Banco de Chile — tarjeta de crédito 100%`, `foreign-currency-unsupported`, cero Activities |
| Issuer multi-hoja — Portada `CMR`/`BANCO FALABELLA` + hoja de datos con firma estructural de Banco de Chile | Autodetección: `Banco Falabella / CMR — tarjeta` **100%**; `Banco de Chile — tarjeta de crédito` no aparece en la lista de candidatos (descalificado). Sólo detección, sin import |
| Control — Portada `BANCO DE CHILE` + misma hoja de datos | Autodetección: `Banco de Chile — tarjeta de crédito` **100%**, Falabella baja a 45%. Sin import |
| Formato de planilla inseguro — `Monto ($)` numérico nativo con formato Excel `#,##0,` (escala x1000) | Autodetección `banco-chile.tarjeta` 95%. Bloqueo `spreadsheet-number-format-conflict`: "La columna 'Monto (\$)' tiene celdas cuyo formato nativo de Excel (unknown) contradice el formato esperado para esta columna (integer/grouped-integer/currency-integer). Se bloquea la importación en vez de adivinar la escala del monto." `0 de 1 filas`, cero Activities. El monto nunca se reinterpretó en silencio |
| Nacional normal (safe) — numérico nativo `#,##0` | Autodetección `banco-chile.tarjeta` 95%, preview `-$17.900` exacto, `Compra tarjeta`, `Nuevo`. Import: `1 detectado, 1 seleccionado, 1 creado en Wealthfolio, 0 fallidos`. El hardening de esta ronda no convirtió el caso válido en falso positivo |

### Cleanup

- La única Activity sintética creada (Nacional safe, `Farmacia Sintetica Host
  Smoke`, `CMR Test`) borrada vía UI (`Activities` → buscar por descripción
  única, un solo resultado → `Open` → `Delete` → confirmar). Verificado `0/0`
  resultados tras borrar antes de limpiar el filtro.
- Baseline final: 3 cuentas, `34/34 activities` — idéntico al inicial.
- Los 8 fixtures XLSX y el script generador (scratchpad de sesión, nunca
  dentro del repo) borrados al terminar, junto con las capturas intermedias.
- `samples/private/` no se tocó durante el smoke — sólo se leyó antes, vía
  `pnpm calibrate`, para la corrección de la Sesión 9 § arriba.

### Verificación final

- Activities/cuentas: idéntico al baseline (`34/34`, 3 cuentas).
- `docker ps` → `healthy`; addon carga en `/addons/wealthfolio-chile`.
- `pnpm verify`: **1511/1511 tests**, typecheck, lint y build verdes.

### BIFF real — de dónde viene cada afirmación

Para que una futura sesión no repita la confusión de origen de evidencia: el
BIFF/OLE2 real (`D0 CF 11 E0`) que este proyecto puede afirmar con confianza
viene de dos fuentes, ninguna de las cuales es una lectura de bytes ad hoc
sobre `samples/private`:

1. `addon/tests/fixtures-biff.test.ts` y `fromXlsCells` — bytes BIFF 100%
   sintéticos, generados en el propio test, verificados por round-trip
   `XLSX.read`.
2. `pnpm calibrate` sobre las 4 `Mov_Facturado` reales — `container: xls` vía
   `detectFileKind`, sin exponer ningún valor de celda.

Este host smoke de la Sesión 9 corrió enteramente sobre XLSX (OOXML), igual
que las Sesiones 7 y 8 — **no** se afirma BIFF de host en ningún punto de esta
sesión.

### Corrección de detección — empate 75/75 resuelto (misma Sesión 9)

El hallazgo de arriba (orden invertido e Internacional-hoja-única cayendo a
`banco-chile.cuenta-corriente`) se corrigió en la misma sesión, con TDD, antes
de repetir el smoke en el host.

**Causa exacta** (confirmada imprimiendo `reasons` de `detectAll` sobre el
fixture sintético mínimo — sólo texto "Banco de Chile" en el preámbulo, sin el
vocabulario de facturación que ya separaba los perfiles en otro test):
ambos perfiles llegaban a `0.75` con exactamente las mismas dos razones —
`strongMarkers` ("BANCO DE CHILE", +0.5) y cabecera con fecha/descripción/monto
encontrada (+0.25). `scoreStructuralFit` no aportaba nada a ninguno de los dos,
porque la única cabecera que `pickDataSheet`/`detectHeader` llegaban a ver
("Movimientos Internacionales") no trae columna de saldo, cargo/abono ni
cuotas — las tres únicas señales que esa función sabe leer. El desempate
final lo resolvía el orden de registro en `registry.ts`
(`bancoChileCheckingParser` antes que `bancoChileCardParser`), nunca evidencia.

**RED:** `addon/tests/banco-chile-tarjeta-international-detection.test.ts`
(nuevo), 2 tests en rojo reproduciendo el empate exacto (`expected 0.75 to be
greater than 0.75`) para Internacional-hoja-única y para el multi-tabla
invertido.

**Mecanismo nuevo (reutiliza infraestructura existente, sin nueva
arquitectura de detector):** `detectWithProfile`
(`core/providers/profile-parser.ts`) ahora también llama a
`detectUnsupportedLayoutInWorkbook` — la misma función, ya existente, que
`parseWithProfile` usa para bloquear el layout Internacional en tiempo de
import, construida sobre `findHeaderRows` (cada cabecera plausible de cada
hoja, no sólo la que `pickDataSheet` elige). Si el workbook contiene, en
cualquier hoja y posición, una cabecera plausible que además trae la columna
exacta que el perfil declara como su propio layout reconocido-pero-no-
soportado (`unsupportedLayoutHeaders`, hoy sólo `Monto (USD)` en
`banco-chile.tarjeta`), eso suma `+0.35` y una razón sanitizada ("cabecera
exacta del layout de tarjeta que este perfil reconoce pero no puede
importar"), sin exponer ningún valor de celda. Ningún otro perfil declara
`unsupportedLayoutHeaders` hoy, así que el boost nunca aplica a
`cuenta-corriente`, Falabella/CMR ni a los genéricos. No se tocó el orden de
`registry.ts`, no se añadió atajo de nombre de archivo, no se penalizó
`cuenta-corriente` artificialmente y no se creó una segunda cabecera de rol
(`ColumnRole`) nueva.

**Score/reasons después del fix** (mismo fixture mínimo):

```
banco-chile.tarjeta          1.00  (0.5 + 0.25 + 0.35, tope 1)
banco-chile.cuenta-corriente 0.75  (sin cambios)
```

**GREEN:** los 2 tests en rojo pasan, más 6 tests adicionales del mismo
archivo: multi-tabla orden normal (regresión), cuenta corriente real-shaped
con branding Banco de Chile (control negativo — sigue ganando
`cuenta-corriente`), tarjeta genérica sin firma exacta (control negativo — no
se promueve a Banco de Chile), Nacional-sola (regresión). `pnpm verify`
completo: **1519/1519 tests**, typecheck/lint/build verdes — cero regresiones
sobre los 1511 preexistentes (incluidos los controles de Falabella/CMR,
branding en portada separada, y "Falabella" mencionado sólo en una glosa, ya
cubiertos por `banco-chile-tarjeta-detection.test.ts` y
`banco-chile-tarjeta-multisheet.test.ts`).

**Host smoke puntual post-fix** (mismo host `3.8.0`, tras
`./scripts/deploy-addon.sh`, mismos 2 fixtures sintéticos regenerados,
`CMR Test (CLP)`): ambos casos autodetectan `Banco de Chile — tarjeta de
crédito 100%` y bloquean con `foreign-currency-unsupported` (texto exacto),
`0 de 0 filas`, cero Activities. Baseline verificado antes y después: 3
cuentas, `34/34 activities` — sin cambios; nada se importó en ningún caso.
Falabella/branding y Nacional-safe no se repitieron en host (los tests
completos cubren esas rutas y detection no las toca).

Commit: `fix(detection): recognize Banco Chile international card layouts`.

### Nota metodológica

Ninguna cartola real tocó el host en esta sesión. Todo lo subido fue XLSX
sintético generado localmente y descartado al cerrar.

### Re-review OpenCode — dos hallazgos bloqueantes corregidos (misma Sesión 9)

Una re-review final de OpenCode sobre el estado de arriba encontró dos
problemas, uno de ellos en la corrección de detección documentada en esta
misma sesión.

**P0 — `runImport` podía escribir un `PreparedImport` con
`validation.ok=false`.** Reproducción independiente confirmada: un XLSX
sintético con una celda de monto nativa (`12450000`) cuyo formato Excel es
`#,##0,` (coma de escala, no una de las formas que
`spreadsheetColumnStructuralEvidence` acepta) produce
`spreadsheet-number-format-conflict` → `validation.ok=false` → `canImport=
false` en `prepareImportFromHost`, pero la fila sigue con `willImport=true`
en `prepared.rows` — `prepareImport` nunca borra una fila sólo porque la
validación general falló, sólo la UI decide no ofrecer el botón de confirmar.
Llamando `runImport({ prepared, ... })` directamente (bypass programático de
la UI, sin checkbox ni wizard de por medio) se llegaba a `saveMany`, `1`
Activity creada, monto mal escalado (`$12.450` en vez de `$12.450.000`). El
mismo patrón se reprodujo con `foreign-currency-unsupported` (Internacional),
demostrando que el problema no era específico de number-format sino que
`runImport` nunca miraba `prepared.validation.ok` en absoluto — sólo
`crossesWriteGate` (willImport + no legacy-source-conflict), que filtra por
fila, nunca por el statement completo.

**Corrección:** `runImport` (`addon/src/services/import-runner.ts`) ahora
rechaza el `PreparedImport` completo con una nueva `ImportBlockedError` en
cuanto `prepared.validation.ok` es `false`, antes de construir ninguna
Activity o de tocar `saveMany` — independiente de `willImport`, del caller o
de `canImport` (que mezcla razones de UX, como "sin filas seleccionadas", con
la única que importa aquí). `crossesWriteGate` sigue existiendo sin cambios
para su propio trabajo, el filtrado por fila de `legacy-source-conflict`. La
UI (`ImportWizardPage.tsx`) ya envolvía la llamada en `try/catch` y muestra
cualquier error como alerta + toast, así que no requirió cambios — el guard
nuevo es una frontera de escritura genuina, no cosmética de UI.

**Nota de arquitectura:** la UI (`canImport`) nunca fue una frontera de
persistencia suficiente por sí sola. `runImport` ahora la aplica de nuevo, en
la frontera real — antes de `saveMany` — para que ningún caller futuro pueda
saltársela.

**RED → GREEN:** `addon/tests/import-runner.test.ts`, describe `runImport
rechaza un PreparedImport con validation.ok=false`, 4 casos —
spreadsheet-number-format-conflict con preparación real (no un objeto
fabricado: la fila se demuestra `willImport=true` antes de exigir el
rechazo), foreign-currency-unsupported con una fila real trasplantada de otro
import válido para probar que el guard es general y no depende del contenido
de `rows`, un import válido que sigue completando normalmente, y una fila
`legacy-source-conflict` forzada que `crossesWriteGate` sigue filtrando sin
depender del guard nuevo. Los primeros dos, corridos ANTES del fix,
reprodujeron la escritura real (`saveMany` llamado, `1` Activity, `status:
completed`) — confirmando el bug con la infraestructura de test existente
antes de tocar el código de producción.

**P1 — la corrección de detección de la sección anterior sobreajustó.**
La explicación de arriba ("Corrección de detección — empate 75/75 resuelto")
decía que reutilizar `unsupportedLayoutHeaders`/`detectUnsupportedLayoutInWorkbook`
— cuya evidencia es una sola columna, `Monto (USD)` — como boost de
detección (`+0.35`) era "evidencia de producto, no sólo de marca". La
re-review de OpenCode reprodujo el sobreajuste: un archivo genérico, SIN
ningún branding de Banco de Chile, con la cabecera mínima `Fecha |
Descripción | Monto (USD)` (o con `Categoría` añadida) ganaba igual el
`+0.35`, quedaba autodetectado como `banco-chile.tarjeta` y terminaba
bloqueado con `foreign-currency-unsupported` — un mensaje sobre Banco de
Chile para un archivo que no lo es. Confirmado antes del fix: `detectAll`
devolvía sólo `banco-chile.tarjeta` (score `0.6`) para ese fixture mínimo,
ningún otro perfil por encima del piso de detección.

Tres estados, en orden:

1. **Primera implementación** (banco-chile.tarjeta@0.2.0, sesiones
   previas): resolvió 75/75 en la calibración original, cero regresiones en
   ese momento.
2. **Corrección de detección** (esta misma Sesión 9, sección de arriba):
   resolvió el empate 75/75 documentado, pero sobreajustó al usar una sola
   columna genérica (`Monto (USD)`) como si fuera evidencia de emisor.
3. **Re-review**: encontró el falso issuer en USD genérico — este hallazgo.
4. **Corrección final** (este commit): la detección exige la firma completa
   del layout Internacional, nunca una columna aislada.

**Corrección:** nuevo campo declarativo `recognizedLayoutSignatures` en
`StatementProfile` (`addon/src/core/parsing/profile.ts`) — evidencia
estructural SÓLO para puntaje de detección, deliberadamente separada de
`unsupportedLayoutHeaders` (que sigue siendo el bloqueo de parseo, sin
cambios, porque para cuando ese bloqueo corre el parser ya fue elegido por
otra vía). Una firma declara TODOS los encabezados normalizados que deben
aparecer juntos en la MISMA fila de cabecera plausible. `banco-chile.tarjeta`
declara una sola firma, la forma real confirmada de "Movimientos
Internacionales": `Categoría | Fecha | Descripción | País | Monto Moneda
Origen | Monto (USD)`. Nueva función
`detectRecognizedLayoutSignatureInWorkbook` (`core/providers/profile-parser.ts`),
hermana de `detectUnsupportedLayoutInWorkbook` pero exigiendo el conjunto
completo, reutiliza `findHeaderRows` igual que la anterior (cada cabecera
plausible de cada hoja, no sólo la que `pickDataSheet` elige — necesario para
que el multi-tabla invertido siga funcionando). La razón sanitizada nueva:
*"Se encontró la firma estructural completa del layout internacional de
tarjeta reconocido por este perfil."* — sin exponer ningún valor de celda.

**RED → GREEN:**
`addon/tests/banco-chile-tarjeta-international-signature.test.ts` (nuevo), 10
tests: genérico USD mínimo sin branding (NO banco-chile.tarjeta), genérico
con `Categoría` añadida (NO banco-chile.tarjeta), genérico con `País` pero
sin `Monto Moneda Origen` — firma incompleta (NO banco-chile.tarjeta), firma
completa real-shaped (SÍ banco-chile.tarjeta, score mayor a cuenta-corriente,
bloquea `foreign-currency-unsupported`), firma completa en multi-tabla
invertido (mismo resultado), CMR/Falabella explícito descalifica aunque la
firma USD esté completa, cuenta corriente real-shaped sin regresión, Nacional
sin regresión, glosas de movimiento sin aportar evidencia de issuer, y la
razón sanitizada exacta. Los 3 primeros y el de la razón, corridos ANTES del
fix, reprodujeron el falso positivo real (`banco-chile.tarjeta` con score
`0.6` para un archivo sin ningún branding).

Los 8 tests preexistentes de
`banco-chile-tarjeta-international-detection.test.ts` (empate 75/75, sección
anterior) siguen en verde sin modificarlos: su fixture ya incluye la firma
completa, así que quedan cubiertos por la firma nueva sin cambios.

**`pnpm verify` completo tras ambos fixes:** **1533/1533 tests**, typecheck,
lint y build verdes — 14 tests nuevos sobre el baseline anterior de esta
sesión (1519), cero regresiones.

**Host smoke puntual (evidencia service-level, sin UI):** el P0 exige bypass
programático de `runImport` — no hay forma honesta de reproducirlo con un
checkbox de la UI, así que la evidencia correcta es el test de servicio con
`fakeHost` (arriba), no una UI inventada. Para el P1, los mismos 3
escenarios que pide la re-review corrieron contra el pipeline real (sin
`fakeHost`, sin `runImport` — sólo `detectAll`/`prepareImport`, que es lo que
la detección ejercita): USD genérico sin branding (`detectAll` no devuelve
`banco-chile.tarjeta`), Banco de Chile Internacional firma completa
(`Banco de Chile — tarjeta de crédito`, bloquea `foreign-currency-unsupported`)
y multi-tabla invertido con la firma completa (mismo bloqueo específico). Los
tres, cero Activities — ninguno de los tres invoca `saveMany`. No se repitió
contra el contenedor Docker real (`infra/compose.yml`): el cambio es puro
`core`/`services`, sin tocar la frontera del SDK ni el mapeo hacia
`ActivityCreate`, así que no hay superficie nueva que un host real pudiera
contradecir — pendiente de validación de host si se quiere esa confirmación
adicional, no declarado como hecho.

Commits: `fix(import): enforce validation at write boundary`,
`fix(detection): require full Banco Chile international signature`.
