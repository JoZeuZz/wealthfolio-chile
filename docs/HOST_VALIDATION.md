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
| Detección | `GET /api/v1/addons/installed` devuelve `wealthfolio-chile` 0.1.1 |
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
