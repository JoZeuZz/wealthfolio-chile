# Decisiones

Resumen de las decisiones que dieron forma al proyecto. Las que necesitan
justificación larga tienen su propio ADR en [`adr/`](adr/).

---

## D1 — Addon, no fork

**Decisión.** Construir sobre el Addon SDK. Al decidirlo se usaba 3.6.2; el
build actual usa SDK 3.8.0 y el mínimo de host sigue en 3.7.0. No tocar el core.

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

**Por qué histórico, SDK <=3.7.** El core tenía un subsistema `spending` con
reglas de categorización, presupuestos y merchants
(`crates/storage-sqlite/src/spending/`), pero no estaba expuesto al SDK de
addons. No había `ctx.api.spending`.

Ver [ADR 0003](adr/0003-categorizacion-propia.md), que también registra qué
API upstream pediríamos para poder eliminar esta duplicación.

**Addendum independiente (2026-09-16).** La premisa “no hay
`ctx.api.spending`” fue cierta para SDK 3.7. SDK 3.8 expone `SpendingAPI` para
categorías personales y reglas del host. Esta decisión sigue aplicando a la
clasificación semántica chilena: compra, pago, devolución, avance y costo
financiero no caben en una categoría personal genérica. No se deben duplicar
indefinidamente categorías y reglas personales del host. Adoptar esa API exige
decisión del propietario, mínimo de host 3.8 y actualizar o sustituir esta
decisión y ADR 0003 si cambia el comportamiento.

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

Hasta que se decida, el titular del copyright conserva sus derechos, pero
terceros no tienen permiso explícito para usar, copiar, modificar o distribuir
el código. El directorio comunitario de Wealthfolio exige una licencia detectable
para un listing activo; `UNLICENSED` impide esa publicación.

---

## D14 — `unknown` sigue viniendo marcado en la vista previa — pendiente

**Estado.** Sin decidir. Requiere una decisión explícita del propietario.

**Cómo está hoy.** Una fila que el clasificador no supo leer
(`TransactionKind.unknown`) llega a la vista previa **marcada para importar**,
igual que cualquier otra. El usuario la ve y «Requieren revisión» la suma.
En una cuenta cash, donde el host lo permite, se escribe `UNKNOWN`. En tarjeta,
una salida `unknown` se sustituye por `WITHDRAWAL` y una entrada por `CREDIT`.
Toda fila `unknown` usa `status: DRAFT` y lleva `needsReview`. Las sustituciones
de tarjeta además conservan `metadata.kind: unknown` y registran `subst`; no se
presentan como clasificación semántica resuelta.

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
| Desmarcado por defecto | En cuenta cash, `UNKNOWN` queda fuera de los cálculos del host; omitirlo evita escribir una fila no entendida | Un banco mal calibrado puede producir muchas filas `unknown`: el usuario importaría una fracción de su cartola sin notarlo. En tarjeta, salida `unknown` es `WITHDRAWAL` y entrada `unknown` es `CREDIT`, ambas sustituidas y en revisión. Spending puede leer la salida como gasto y la entrada como refund que reduce gasto, pese a no existir clasificación semántica |
| Marcado (hoy) | La cartola entra completa; nada se pierde en silencio | Se escriben filas que nadie clasificó, y el costo de sacarlas después es manual |

**Qué falta para decidir.** Saber qué proporción de filas queda `unknown` con
cartolas reales y evaluar por separado cash y tarjeta. Con perfiles todavía
`pending-real-sample` ese número no existe. La falta de evidencia real no cierra
el gate del propietario: D14 sigue **OPEN** hasta su decisión explícita.

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

## D19 — Una transferencia saliente en una tarjeta cuesta clasificación, no saldos

**Decisión.** En una cuenta `CREDIT_CARD` una salida clasificada como
`internal_transfer` o `credit_card_payment` se escribe `WITHDRAWAL`, marcada
`subst` y con `needsReview`. No se busca un tipo mejor porque no existe.

**Qué comprobamos.** Sobre el checkout de Wealthfolio en la etiqueta `v3.7.0`:

- `ActivitiesService::account_activity_validation_message`
  (`crates/core/src/activities/activities_service.rs`) acepta en una cuenta
  `CREDIT_CARD` únicamente `WITHDRAWAL`, `TRANSFER_IN`, `CREDIT`, `FEE` e
  `INTEREST`. `TRANSFER_OUT` está prohibido; no es una elección del addon.
- `handle_withdrawal`
  (`crates/core/src/portfolio/snapshot/holdings_calculator/handlers/cash_flows.rs`)
  y la rama de efectivo de `handle_transfer_out` (`.../handlers/transfers.rs`)
  hacen lo mismo: `add_cash(-(monto + comisión + impuesto))` y la misma suma a
  `net_contribution`. **El saldo de la cuenta es idéntico se escriba cual se
  escriba.** El propio comentario de upstream lo dice: «Transfers always affect
  account-level net_contribution; portfolio boundary is handled by aggregation».
- Difieren en dos consumidores: `economic_events::event_kind` clasifica
  `WITHDRAWAL` como `CashFlow` —flujo externo— mientras que `TRANSFER_OUT`
  depende de `TransferBoundary`; y `spending::classify_activity` cuenta un
  `WITHDRAWAL` en una tarjeta como `Expense`, mientras que un `TRANSFER_OUT`
  quedaría `Ignored`.

**Conclusión.** La degradación no toca el saldo ni el patrimonio; hace que el
informe de gasto del host cuente como gasto de tarjeta algo que no lo es. Y
aunque `TRANSFER_OUT` estuviera permitido, sin `source_group_id` —que el SDK no
deja escribir, ver [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md)—
tampoco obtendría el tratamiento de transferencia interna.

**Lo que sí se corrigió.** El origen real de esas filas no era el clasificador
—`defaultKindForRow` da `credit_card_purchase` a toda salida de tarjeta— sino
`builtin.transferencia-propia`, que disparaba `mark_transfer` con `match: 'any'`
sobre `TRASPASO`. En una cartola de tarjeta chilena `TRASPASO A 12 CUOTAS` y
`TRASPASO DE DEUDA` son refinanciamiento, no transferencias, así que la regla
que existe para sacar un movimiento del total de gasto lo estaba metiendo. La
condición `product` del motor de reglas separa ahora ambos documentos.

**Pendiente de evidencia — resuelto en parte, ver D20.** Un avance en efectivo
ya no queda como `credit_card_purchase`: tiene tipo propio. Lo que sigue
pendiente es el caso de un avance abonado a una cuenta propia que el usuario
también importa, donde el efectivo reaparece como entrada. Ese ingreso se deja
sin resolver en vez de leerse como ingreso, y el par lo propone la pantalla de
conciliación, no un clasificador. `BLOCKED: real-bank-sample`.

## D20 — Lo que cuesta el crédito se nombra; el emisor no es un comercio

**Fecha.** 2026-09-07 · `0.2.0-rc.3`

Un estado de cuenta chileno trae líneas que no son compras, y el modelo tenía
tres palabras para todas: `fee`, `interest`, `tax`. Mantienen los totales
correctos y no responden nada. Una comisión de mantención y una comisión por
avance son ambas `fee`, llegan el mismo mes y significan lo contrario: una es
el precio de tener la tarjeta, la otra el de haber pedido efectivo con ella.

**Por qué se pudo modelar sin cartola real.** La NCG 537 de la CMF tuvo que
enumerar estos costos para definir el Monto No Financiable del pago mínimo, y
el glosario del reglamento de información al consumidor define cada uno. El
vocabulario lo publica el regulador, no lo observamos en un archivo.

**Cuatro decisiones.**

1. **Una dimensión que refina, no reemplaza.** `financialCostKind` tiene diez
   valores y cada uno mapea a un tipo que Wealthfolio ya expresa, así que nada
   exige un `ActivityType` inexistente. Viaja en la metadata del addon, esquema
   5, y sólo cuando la glosa nombró el costo específico: la presencia del campo
   es la confianza.
2. **Un avance en efectivo no es una compra.** El reglamento lo define como el
   emisor otorgando "un préstamo o mutuo de dinero" contra el cupo. Se mantiene
   como un movimiento —partirlo en dos inventaría la contraparte que ningún
   banco reportó— con tipo propio. El principal queda fuera de consumo, gasto,
   costos financieros, comercios y planes de compra; se informa como
   financiamiento. Comisión, interés e impuesto son movimientos separados.
3. **Un cobro del emisor no tiene comercio.** Visto en un host real:
   `INTERES POR MORA` y `GASTOS DE COBRANZA` competían en «Comercios
   principales» con el supermercado, porque el nombre se lee del texto de la
   glosa y la glosa de un cargo del banco también tiene texto. Salen del
   ranking y se informan aparte; el dinero no desaparece del panel.
4. **Consumo se suma por inclusión.** Son compras y servicios salientes sin
   dimensión de costo financiero. No se calcula restando costos y avances al
   gasto total: una comisión ambigua, una devolución o un movimiento sin
   clasificar no puede quedar convertido en consumo por diferencia.

**Lo que deliberadamente no está.** Los seguros: el reglamento define la prima
cargada a una tarjeta como una obligación que el consumidor contrae
*voluntariamente* por un producto propio. La NCG 537 la cuenta dentro del Monto
No Financiable porque ésa es una regla sobre cuánto hay que pagar este mes, no
una afirmación de que sea un costo del crédito. Y el «súper avance»: buscado en
cada texto legal revisado, encontrado en ninguno — es terminología comercial.

**Lo que sigue sin saberse.** Si una cuota lleva interés o no es el único dato
de cuotas con peso regulatorio, y exige que la cartola lo declare línea por
línea. No se lee ni se infiere. `BLOCKED: real-bank-sample`.

## D21 — El procesador de pago no es el comercio al que le pagaste

**Fecha.** 2026-09-07 · `0.2.0-rc.3`

La extracción de comercio pelaba la glosa hasta dejar un nombre, y no tenía
forma de decir *nada*: lo que sobreviviera al pelado era el comercio. En
cartolas chilenas eso producía comercios llamados «4 Tcom» —el sufijo de ruteo
de Mercado Pago—, «Online» —el comodín que un banco imprime para un comercio
que no tiene registrado— y «Cajero Automatico», que es una máquina.

**La pregunta que faltaba, y que se puede responder.** ¿Este procesador deja
ver el comercio? Es una propiedad del procesador y está documentada. El centro
de ayuda de Flow dice que un cargo `FLOW` significa "un pago para alguno de los
comercios adheridos" y no dirá cuál. Banco Falabella publica un glosario donde
le explica a sus propios clientes que `MERCADO PAGO` "puede ser cualquier
comercio que acepte Mercado Pago" — el banco tampoco puede resolverlo. Google,
en cambio, documenta `GOOGLE *{Company}`.

**Lo que no se construyó: una gramática basada en el asterisco.** El mismo
documento de Falabella muestra `GOOGLE GARENA` y `GOOGLE *GARENA` para lo que
parece el mismo cargo: el separador no sobrevive de forma confiable el camino
desde la red de tarjetas hasta la cartola. Se usa donde un procesador lo
documenta y no se asume en ninguna otra parte.

**Consecuencia.** Cuando el procesador oculta el comercio, la respuesta es
«desconocido» con el procesador nombrado, nunca el procesador ascendido a
comercio. Un comercio equivocado es una categoría equivocada, una recurrencia
equivocada y un ranking equivocado, y los tres parecen correctos.

## D22 — Un hecho del estado de cuenta sólo existe si el documento lo dijo

**Fecha.** 2026-09-07 · `0.2.0-rc.3`

Qué campos tiene un estado de cuenta de tarjeta está establecido: la CMF
enumera trece elementos y el artículo 26 del reglamento que entra en vigencia
el 2028-02-06 los detalla, hasta la redacción de cada etiqueta. Dónde está cada
uno en una cartola que un banco chileno emite hoy no está documentado en
ninguna fuente pública.

**Por eso la extracción es por etiqueta y nunca por posición.** La etiqueta
viene de la norma; la posición tendría que venir de una cartola real, y no hay
ninguna. Un perfil que no encuentra nada no está roto: es un perfil cuyas
etiquetas no se han comparado con un archivo real, y eso es exactamente lo que
informa `pnpm calibrate`, campo por campo, sin decir jamás una cifra.

**La regla que gobierna el extractor.** Estas cifras son las que una persona
usa para decidir, así que el intercambio se hace explícito y siempre en la
misma dirección:

> falta un hecho **<** hecho equivocado

Un pago mínimo ausente cuesta una línea de la vista previa. Un pago mínimo
leído del RUT del titular cuesta una decisión.

**Ausente no es cero.** `minimumPayment: 0` afirmaría que este mes no hay nada
que pagar. Y el pago mínimo se lee, jamás se calcula: la fórmula de la NCG 537
tiene cinco etapas hasta 2028-06-04, admite excepciones discrecionales del
emisor y exige saber por línea si cada cuota lleva interés.

**Estado.** Arquitectura lista y probada contra fixtures sintéticos construidos
con la redacción del reglamento. Ninguna cartola real de ningún banco ha pasado
por esto. `BLOCKED: real-bank-sample`.

---

## D23 — Una cuota facturada es una Activity, una sola vez; el conteo restante nunca infiere un total

**Fecha.** 2026-09-15 · `0.2.0-cmr-real-sample`

**El problema.** Una compra en cuotas CMR reaparece en cada estado de cuenta
mensual mientras el plan sigue abierto — no es una fila, son N filas a lo
largo de N meses, cada una un hecho económico distinto (el cargo de *ese*
ciclo). Wealthfolio 3.8.0 no tiene ningún concepto nativo de cuota: catorce
`ActivityType` fijos, sin `relatedActivityId` ni ningún otro enlace entre
Activities, y el SDK no expone `link`/`unlink`/`transfer-pair` (ver ADR 0005).
Cualquier semántica de cuota tiene que vivir enteramente en cómo el addon
mapea cada fila, no en algo que el host entienda.

**Decisión — Activity por cuota facturada.** Cada fila importada de un ciclo
es una Activity, exactamente una vez, con `amount` igual al cargo de *ese*
ciclo (`VALOR CUOTA` cuando la columna existe — `readAmount` ya lo prioriza
sobre `MONTO`, sin cambios). Importar el ciclo siguiente agrega una Activity
nueva para el cargo de ese ciclo, no vuelve a escribir el total de la compra.
Esto es lo que la arquitectura fila-por-fila ya produce; no hizo falta
rediseñar el mapping, sólo confirmarlo con evidencia real (`docs/BANK_FORMATS.md`).

Se descartaron: una Activity por el total de la compra (cuenta el consumo una
vez pero de más — el dinero no salió todo ese día) y compra total + mecanismo
de financiamiento separado (no hay dónde representarlo: sin subtype de cuota
ni relación entre Activities en el host).

**El conteo restante nunca infiere un total.** La columna real (`CUOTAS
PENDIENTES`) es un entero simple — cuotas que faltan tras este cargo, no un
par `n de m` — confirmado en el 100 % de 130 filas reales de 4 estados de
cuenta. `detectRemainingInstallments` (`core/installments/detect.ts`) lo lee
tal cual y nunca deriva `current`/`total` de él, ni de `MONTO ÷ VALOR CUOTA`
(redondeo e interés lo invalidarían). Se guarda como
`NormalizedTransaction.installmentRemaining`, separado de `installment`
(`current`/`total`, para el patrón `n de m` de otros bancos) — nunca los dos
a la vez, y el primero nunca alimenta `buildInstallmentPlans`, que sigue
exigiendo un total. El costo es honesto: CMR no proyecta un outlook de
cuotas comprometidas hasta tener evidencia real de un total (posible con PDF,
`Número Cuotas` — pendiente, ver `docs/BANK_FORMATS.md`).

**El fingerprint tuvo que incorporar el conteo.** Evidencia real (comparación
cruzada de 2 estados de cuenta consecutivos) mostró que la `FECHA` de una
cuota activa **no avanza** entre ciclos — la cuota 2 trae la misma fecha que
la cuota 1. Sin ajuste, `computeFingerprint` (fecha+monto+glosa+cuenta)
habría hasheado ambas cuotas igual, y la segunda se habría leído como
duplicado exacto de la primera y perdido en el reimport. Se agregó el
conteo restante al final de la lista de campos hasheados, **sólo cuando el
campo existe** — así que cada fingerprint calculado antes de que este campo
existiera (todo otro banco, y toda fila CMR sin columna de cuotas legible)
queda byte a byte igual: sin bump de versión, sin hash legado dual, porque
nada que se haya publicado produjo jamás este campo.

**Estado.** Implementado y probado (`tests/cmr.test.ts`, `tests/host-authority.test.ts`,
`tests/installments.test.ts`) contra evidencia real de 4 estados de cuenta XLSX.
Sin validar contra host real todavía — ver `docs/HOST_VALIDATION.md`.

**Addendum (review independiente, P1 — 2026-09-15).** Cuatro correcciones
sobre lo de arriba, cada una con commit y tests propios:

1. **El conteo restante quedó contaminando otros bancos.**
   `ColumnRole.installment` se resuelve por un encabezado genérico (`CUOTA`,
   `CUOTAS`, ...), así que una columna `Cuotas` de Banco de Chile o de un
   perfil genérico — que nombra el TOTAL de un plan, no lo que falta —
   alimentaba `installmentRemaining` igual que la `CUOTAS PENDIENTES` real
   de CMR. `StatementProfile.remainingInstallmentHeaders` ahora declara
   explícitamente qué encabezado exacto tiene esa semántica; sólo
   `banco-falabella.cmr` lo declara. Ver `tests/installment-remaining-scope.test.ts`.

2. **La transición histórica de fingerprint necesitaba guardia, no sólo
   comentario.** El párrafo "El fingerprint tuvo que incorporar el conteo"
   de arriba es correcto sobre fingerprints NUEVOS, pero no decía qué pasa
   con una Activity que este mismo parser escribió ANTES de ese cambio: su
   fingerprint no incluye el conteo, así que reimportar el mismo archivo la
   dejaba fuera de ambas búsquedas (fuerte y débil) y la fila salía `new`.
   `FALABELLA_CARD.parserVersion` subió a `0.2.0` y
   `core/dedupe/classify.ts#isLegacyIncompatibleCmrSource` extiende el mismo
   guard `legacy-source-conflict` que ya existía para
   `banco-chile.tarjeta` — estrecho a `sourceFileHash` igual, para no
   bloquear la cuota del ciclo siguiente (archivo distinto). Ver
   `tests/dedupe-legacy-cmr-transition.test.ts`. No se migran Activities
   antiguas automáticamente; el guard sólo bloquea el reimport para revisión
   manual.

3. **El marcador de pago era substring libre.** `PAGO TARJETA` como
   substring convertía cualquier comercio cuyo nombre lo contuviera (p. ej.
   "COMERCIO PAGO TARJETA EXPRESS") en `credit_card_payment`. El matcher
   ahora exige que el marcador ABRA la glosa normalizada. Ver
   `tests/card-payment-anchoring.test.ts`.

4. **El calibrador PDF filtraba texto del documento por consola.**
   `pdfjs-dist` escribe internamente a `console.log`/`warn`, un canal que
   la sanitización propia del calibrador no controla. Cerrado con una
   supresión de consola local al ciclo de vida del documento en
   `pdf-extract.ts`. Ver `tests/pdf-console-privacy.test.ts`.

Las cuatro se recalibraron contra las 4 muestras XLSX reales de CMR y una
muestra real de Banco de Chile tarjeta (canal `pnpm calibrate` únicamente):
mismos conteos de clasificación y de cuotas que antes de estos fixes — cero
regresión observada.
