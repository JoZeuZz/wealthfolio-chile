# Pipeline de importación

Recorrido completo desde el archivo hasta las actividades en Wealthfolio, con
las decisiones que toma cada etapa y por qué.

---

## Paso 0 — El archivo entra por el DOM

El addon corre en un iframe con `sandbox="allow-scripts"` y no existe API para
leer un archivo del disco: `files.openCsvDialog()` devuelve una ruta en
escritorio y `null` en web. El wizard usa `<input type="file">` y drag & drop,
y lee los bytes con `File.arrayBuffer()`.

Ventaja lateral: los bytes nunca salen del sandbox y el addon **no declara el
permiso `files`**.

---

## Paso 1 — Reconocer el contenedor

`core/parsing/workbook.ts`

La extensión miente constantemente en este dominio: los bancos sirven `.xls`
que en realidad son HTML o texto tabulado. Manda el contenido:

| Magic bytes | Formato |
| --- | --- |
| `50 4B` (`PK`) | ZIP → XLSX |
| `D0 CF 11 E0` | OLE2 → XLS heredado |
| — | texto delimitado |

Codificación: se intenta UTF-8 estricto; si aparece el carácter de reemplazo se
decodifica como Windows-1252. Sin eso, cada `Ñ` y cada `ó` se corrompe y con
ellos todos los matches de comercio aguas abajo.

Delimitador: se elige por **consistencia**, no por frecuencia — gana el
candidato que produce el mismo número de columnas en más líneas. Contar
ocurrencias elegiría `,` en un archivo con `;` lleno de montos `1.234,56`, que
es la forma más común de arruinar una cartola chilena.

PDF se rechaza con un mensaje accionable: exporta CSV o XLSX.

---

## Paso 2 — Encontrar la cabecera y mapear columnas

`core/parsing/columns.ts`

Los exportes chilenos anteponen titular, número de cuenta y período como filas
libres. El detector recorre hacia abajo hasta encontrar una fila que mapee a
fecha + descripción + algo de monto.

El mapeo va por pasadas — exacta, prefijo, contiene — para que un encabezado
preciso nunca pierda contra uno laxo, y una columna no puede tomar dos roles.

Roles: `date`, `postedDate`, `description`, `amount`, `installmentAmount`,
`purchaseAmount`, `debit`, `credit`, `balance`, `reference`, `operationType`,
`currency`, `installment`, `card`, `category`, `directionFlag`.

`installmentAmount` y `purchaseAmount` existen porque en un estado de cuenta de
tarjeta `MONTO TOTAL` y `VALOR CUOTA` son números distintos. Estaban listados
como sinónimos del mismo rol, así que ganaba la columna que apareciera primero:
una compra de $299.940 en seis cuotas se cargaba entera cada mes y el total
derivado salía seis veces mayor que la compra.

### El orden de los campos de una fecha

`core/parsing/date-order.ts`

`03/09/2026` admite dos lecturas. La ambigüedad es del **archivo**, no de la
fila: un banco no mezcla órdenes dentro de una exportación, así que una sola
fila con un campo mayor que 12 lo resuelve para todas las demás. El orden se
decide una vez, antes de mapear ninguna fila, mirando la columna de fecha *y* la
de fecha contable.

Sólo votan las filas que van a convertirse en movimientos. Una línea
`TOTAL DEL PERIODO` con `12/25/2026` alcanzaba para declarar —con la confianza
más alta que tiene el detector— que una cartola chilena es `MM/DD/AAAA`, y
recorría todas las fechas reales del archivo.

Cuando el archivo se demuestra a sí mismo, el orden del archivo **gana al del
perfil**: el archivo es evidencia y el perfil una expectativa. Cuando no
demuestra nada, se usa el del perfil y se advierte una vez, con el número de
filas afectadas — no una advertencia por fila, que era la mitad de una cartola
real y dejaba de significar nada.

---

## Paso 3 — Elegir parser

`core/providers/profile-parser.ts`

Cada parser puntúa el archivo de 0 a 1:

| Evidencia | Peso |
| --- | --- |
| Marcador fuerte (nombre del banco) | +0,50 |
| Marcadores débiles (léxico) | +0,10 c/u, tope 0,30 |
| Nombre de archivo | +0,15 |
| Cabecera reconocible | +0,25 |
| Ajuste estructural | ±0,30 |
| Número de cuenta en el encabezado | +0,05 |

Dos detalles que costaron un bug real:

1. **Los marcadores solo se buscan en el preámbulo y la cabecera**, nunca en las
   filas de movimientos. Antes se escaneaban las primeras 25 filas completas, y
   una sola glosa `PAGO TARJETA DE CREDITO CMR` bastaba para que el parser de
   tarjeta ganara sobre el de cuenta corriente — con lo que cada compra se
   clasificaba como cargo de tarjeta.

2. **La forma de las columnas pesa tanto como el léxico.** Una columna de saldo
   implica cuenta (una tarjeta no arrastra saldo); una columna de cuotas implica
   tarjeta. Hay test de regresión para ambas.

Bajo 0,35 un parser no se ofrece siquiera. El usuario siempre puede elegir a
mano.

---

## Paso 4 — Filas al modelo canónico

`core/parsing/rows.ts`

Tres disposiciones de monto soportadas:

- **Una columna con signo** — el signo ya está.
- **Cargo / abono separados** — cargo negativo, abono positivo. Ambas llenas a
  la vez lanza error en vez de adivinar.
- **Monto sin signo + columna de dirección** — manda la columna.

Cuando ninguna existe, el perfil decide: `debit-positive` en tarjetas (un cargo
positivo es una salida), `credit-positive` o `signed` en cuentas.

Se descartan filas de subtotal (`SALDO ANTERIOR`, `TOTAL`, `PÁGINA n`).

La clasificación inicial es deliberadamente gruesa: producto + dirección. Inferir
`income` contra `internal_transfer` desde una fila aislada es exactamente la
inferencia que infla totales, así que no se intenta aquí.

---

## Paso 5 — Huella

`core/dedupe/fingerprint.ts`

```
SHA-256( v1 · accountId · fecha · monto exacto · moneda · clave(descripción) · referencia )
```

Solo campos que un banco no cambia entre dos exportes del mismo período.
Excluidos a propósito: número de fila, nombre de archivo, saldo corrido y
nuestra propia clasificación — incluirlos haría que el mismo movimiento
pareciera nuevo tras volver a descargar el archivo.

`clave(descripción)` es la forma agresiva: sin dígitos ni letras sueltas, lo que
absorbe las variaciones de formato entre exportes conservando el comercio.

La huella está **acotada a la cuenta**: los mismos $10.000 el mismo día en dos
cuentas distintas siguen siendo dos movimientos.

---

## Paso 6 — Comercio y reglas

`core/merchants/normalize.ts` → `core/rules/engine.ts`

```
COMPRA INT WEBPAY TRANSBANK 4821 SUPERMERCADO LIDER LAS CONDES
  → quitar procesador     (Webpay)
  → quitar verbo inicial  (COMPRA INT)
  → quitar referencias    (4821)
  → quitar comuna final   (LAS CONDES)
  → alias de marca        → "Lider"
```

Luego las reglas: condición → acción, orden total y estable (prioridad, luego
id). Cada transacción registra qué reglas dispararon, así que «¿por qué esto es
restaurante?» siempre tiene respuesta.

Una regex inválida escrita por el usuario desactiva su propia regla, no la
importación entera.

---

## Paso 7 — Duplicados

`core/dedupe/classify.ts`

| Veredicto | Criterio | Acción por defecto |
| --- | --- | --- |
| `exact` | Misma huella ya importada, o repetida dentro del archivo | Omitir |
| `probable` | Misma cuenta, monto y fecha (±3 días), descripción ≥72% similar | Omitir, revisable |
| `none` | Nada coincide | Importar |

`probable` existe como categoría separada precisamente porque dos cafés de
$2.500 el mismo día son dos movimientos reales. Los duplicados probables vienen
desmarcados: el costo de omitir de más (un movimiento que se re-agrega) es menor
que el de importar de más (un gasto silenciosamente duplicado).

El índice se reconstruye desde las actividades del propio Wealthfolio leyendo la
metadata que escribimos al importar.

---

## Paso 8 — Cuotas

`core/installments/`

`CUOTA 2 DE 6` → `confirmed`. Un `2/6` suelto → `suggested`, porque también
puede ser el 2 de junio. Nada aguas abajo actúa sobre una sugerencia sin que un
humano confirme.

Las compras se agrupan por comercio + total de cuotas + monto, se retrodata el
inicio desde la cuota observada más baja y se proyecta el resto mes a mes. Si
faltan cuotas intermedias, el plan se marca `hasGaps` y la proyección se declara
parcial.

---

## Paso 9 — Vista previa

`core/pipeline.ts`

Se muestran: ingresos, egresos, flujo neto, transferencias propias, pagos de
tarjeta, duplicados, ignorados, filas a revisar y planes de cuotas detectados.
La cabecera dice además qué pasó con **cada fila bajo la cabecera** —leídas,
omitidas, con error— porque «¿leímos esta cartola entera?» tiene que ser
respondible sin leer prosa.

Marcar o desmarcar una fila recalcula todo. **Nada se ha escrito todavía.**

### Los tres gates

`services/import-preparation.ts` reúne cada razón por la que escribir está
prohibido, y las reporta **todas a la vez**: arreglar una y descubrir la
siguiente es cómo se pierde la confianza en una herramienta.

| Código | Cuándo | Por qué bloquea |
| --- | --- | --- |
| `parse-failed` | El archivo no se pudo leer | No hay nada que importar |
| `statement-invalid` | `validation.ok === false` | Una fila que debía ser un movimiento no se pudo leer, o el saldo declarado no cuadra de forma sistemática. Importar el subconjunto legible deja un hueco que después parece completo |
| `duplicate-check-unavailable` | La lectura de movimientos existentes falló o quedó truncada | «No se pudo comprobar» y «no hay duplicados» son respuestas distintas |
| `account-mismatch` | Moneda distinta, número de cuenta distinto, o cuenta de instrumentos | Ningún otro control lo detecta: las huellas van scoped por cuenta, así que en la cuenta equivocada los movimientos *son* nuevos |

`statement-invalid` explica cuál de sus causas ocurrió: decirle a alguien que
«0 de 4 filas no se pudieron leer» cuando lo que falló fue el recorrido de
saldos lo manda a arreglar algo que no está roto.

Un desajuste de saldo aislado es error sólo si el perfil declara su columna
`authoritative` —hoy ninguno de los bancarios—. Un desajuste **sistemático**
(≥50 % de los pasos, mínimo 4 pasos) es error siempre: a esa proporción no es
una rareza del banco, es que el archivo se está leyendo mal. El recorrido se
hace en orden de libro, no de archivo, y acumula los montos entre dos saldos
declarados, porque hay cartolas que exportan de la más nueva a la más antigua y
cartolas que imprimen el saldo una vez por día.

---

## Paso 10 — Escribir

`core/mapping/activities.ts` → `services/import-runner.ts`

El mapeo recibe el **tipo de la cuenta de destino**. Wealthfolio sólo acepta
`WITHDRAWAL`, `TRANSFER_IN`, `CREDIT`, `FEE` e `INTEREST` en una cuenta
`CREDIT_CARD`, y rechaza el lote entero por una fila que no esté en la lista; en
esas cuentas el mapeo sustituye por el tipo permitido más cercano y deja
constancia en `metadata.subst`, para que una relectura no confunda la
sustitución con una reclasificación del usuario. Ver
[UPSTREAM.md](UPSTREAM.md).

Cada transacción se traduce a `ActivityCreate` con el monto como magnitud
positiva (el tipo lleva la dirección) y nuestra metadata bajo la clave
`wealthfolioChile`:

```json
{
  "v": 2,
  "fp": "<huella>",
  "wfp": "<huella débil>",
  "inst": "banco-chile",
  "parser": "banco-chile.cuenta-corriente",
  "parserVersion": "0.1.0",
  "fileHash": "<sha256 del archivo>",
  "runId": "run-…",
  "kind": "expense",
  "dir": "out",
  "cat": "alimentacion.supermercado",
  "merchant": "Lider",
  "cuota": { "n": 2, "of": 6 }
}
```

Se escribe con `activities.saveMany({ creates })` en lotes de 100. Un lote que
falla se reporta, **no se reintenta**: reintentar una escritura parcialmente
aplicada es justo como se crean duplicados.

En v3.6.2 y en v3.7.0 `bulk_mutate_activities` valida la petición completa antes de escribir
y, si algo falla, devuelve `created` vacío sin persistir nada. Por eso **cada
entrada de `result.errors` corresponde siempre a filas que no se crearon**, y una
fila mala cuesta su lote entero — que es el costo que acota el tamaño 100.

Al terminar se registra la corrida en el historial y se invalidan las queries de
`activities` y `portfolio`. Ese registro ocurre **después** de la escritura: si
falla, la importación sigue siendo `completed` y se reporta aparte
(`historyRecorded: false`), nunca como importación fallida.

### `dir` — la dirección original

Wealthfolio guarda un monto sin signo y expresa la dirección en el
`activityType`. Para `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_IN`, `TRANSFER_OUT`,
`FEE`, `TAX`, `INTEREST`, `CREDIT`, `DIVIDEND`, `BUY` y `SELL` eso basta: el tipo
es la autoridad y **la metadata nunca puede contradecirlo**.

Pero `UNKNOWN`, `ADJUSTMENT`, `SPLIT` y cualquier tipo futuro no llevan dirección
semántica. Un cargo `unknown / out / -4500` se escribía como `UNKNOWN` con monto
`+4500` y al releerlo volvía como `in / +4500`: el mapping no era reversible y el
índice de duplicados comparaba `+4500` contra `-4500` sin encontrar nada.

Desde `v: 2` la metadata guarda `dir` (`"in"` | `"out"`) y la lectura la usa
**sólo** cuando el tipo del host no dice nada. Una actividad de 0.1.0/0.1.1 sin
`dir` conserva el comportamiento anterior: se respeta el signo tal como el host
lo tenga almacenado.

---

## Garantía de idempotencia

Importar el mismo archivo dos veces produce cero movimientos nuevos. Hay test
que lo verifica, además de estos casos:

- el mismo archivo dos veces
- archivos con períodos solapados
- una fila repetida dentro del mismo archivo
- el mismo movimiento en dos cuentas distintas (deben seguir siendo dos)
- una descripción distinta para el mismo movimiento (→ `probable`)
