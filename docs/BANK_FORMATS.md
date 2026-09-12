# Formatos bancarios

Estado real del soporte por banco y formato, y **exactamente qué falta** para
dar cada uno por validado.

Última revisión: 2026-09-03.

---

## Leyenda

| Estado | Significado |
| --- | --- |
| ✅ verificado | Probado contra un archivo real de ese banco |
| ⚠️ pendiente | Adaptador completo, mapeo derivado de documentación pública; **no** validado con una cartola real |
| 🚫 no soportado | Por diseño, o bloqueado |

Los perfiles ⚠️ funcionan de punta a punta y están cubiertos por tests con
fixtures sintéticos. Lo que no se puede garantizar sin un archivo real es que
los **nombres de columna y la convención de signo** coincidan con lo que el
banco emite hoy. El wizard lo advierte en pantalla y el historial de
importaciones guarda la versión del parser usada.

### Madurez, por evidencia

Cuatro preguntas distintas, y la tabla las separa porque responderlas juntas es
como se infla el estado de un banco:

| Perfil | Parser | Fixture sintético | Test que lo parsea | Validado en host 3.7.0 | Cartola real |
| --- | --- | --- | --- | --- | --- |
| `generico.cuenta` | ✅ | n/a | ✅ | ✅ indirecto | n/a |
| `generico.tarjeta` | ✅ | n/a | ✅ | ⬜ | n/a |
| `banco-chile.cuenta-corriente` | ✅ | ✅ | ✅ | ✅ | ⬜ |
| `banco-chile.tarjeta` | ✅ | ✅ | ✅ | ⬜ | ⬜ |
| `banco-estado.cuenta` | ✅ | ✅ | ✅ | ✅ | ⬜ |
| `banco-falabella.cmr` | ✅ | ✅ | ✅ | ✅ | ⬜ |
| `banco-falabella.cuenta` | ✅ | ✅ | ✅ | ⬜ | ⬜ |

«Validado en host» significa que una cartola **sintética** de ese perfil se
importó contra un Wealthfolio real y las actividades resultantes se verificaron
una por una. No dice nada sobre si el mapeo coincide con lo que el banco emite:
para eso está la última columna, y hoy está vacía entera.

### Lo que sigue sin evidencia en CMR

La pregunta que decide todo el cálculo de deuda comprometida: en una fila en
cuotas, **¿una columna `Monto` sin etiquetar es el valor de la cuota o el total
de la compra?** Las dos lecturas difieren por un factor igual al largo del plan.

Mientras no haya un estado de cuenta real:

- si el archivo trae una columna etiquetada (`Valor Cuota`, `Monto Cuota`), esa
  manda y no hay ambigüedad;
- si sólo trae `Monto` junto a un marcador de cuotas, la fila se marca
  `ambiguous-installment-amount`, el plan baja a `suggested` y **no se deriva el
  total de la compra**. Lo que sí se proyecta es lo que falta por pagar, porque
  eso es el cargo repetido y no depende de cuál lectura sea la correcta.

Falta también confirmar cómo CMR marca los avances en efectivo.

---

## Banco de Chile

| Producto | Formato | Estado | Parser |
| --- | --- | --- | --- |
| Cuenta corriente | XLS (BIFF) | ⚠️ pendiente (calibrado parcial 2026-09) | `banco-chile.cuenta-corriente` |
| Tarjeta de crédito | CSV / XLSX | ⚠️ pendiente | `banco-chile.tarjeta` |
| Cualquiera | PDF | 🚫 | — |

Mapeo confirmado para cuenta corriente (8 cartolas XLS reales):

| Rol | Encabezado real |
| --- | --- |
| fecha | `Fecha` |
| descripción | `Descripcion` |
| canal (`operationType`) | `Canal o Sucursal` |
| cargo | `Cargos (PESOS)` |
| abono | `Abonos (PESOS)` |
| saldo | `Saldo (PESOS)` |

No hay columna de número de documento/referencia — a diferencia del mapeo
asumido antes de calibrar, cuenta corriente no trae una.

**Hallazgos de calibración 2026-09** (8 cartolas XLS reales de cuenta
corriente; fixture sintético equivalente en `samples/synthetic/`):

1. **Fecha de movimiento:** `dd/mm`, **sin año** — igual mecanismo que
   BancoEstado CuentaRUT (`dd/mmm`), pero numérico. Confirmado en las 8.
2. **El preámbulo nunca declara un período `desde/hasta`.** Sólo trae una
   `Fecha de Emisión: dd/mm/yyyy` (fecha completa, un solo punto).
3. **El año se recupera de dos filas contables fijas:** la primera fila de la
   tabla es siempre `SALDO INICIAL` y la última siempre `SALDO FINAL`, ambas
   con fecha `dd/mm`. `SALDO FINAL` comparte día/mes con la `Fecha de Emisión`
   en las 8 cartolas, incluida una que cruza diciembre → enero. Ver
   `StatementProfile.periodFromBalanceRows` y `derivePeriodFromBalanceRows`
   (`core/providers/profile-parser.ts`) — un mecanismo específico de este
   layout, no una regla general de "emisión = fin de período".
4. Sin esas tres piezas coherentes (emisión + ambas filas ancla + mismo
   día/mes), la fila falla en vez de adivinar el año — igual que cualquier
   `dateOmitsYear` sin período.

**Confirmado con las mismas 8 cartolas:**

- Escala monetaria: `scale 2` en el 100% de las filas mapeadas es un `,00`
  literal del banco (CLP no tiene centavos, pero el export siempre los
  escribe) — mismo valor exacto que `scale 0`, no es un separador de miles mal
  leído.
- Signo de cargo/abono: `Cargo` negativo, `Abono` positivo (`amountSign:
  'signed'`) reconcilia el recorrido de saldo sin un solo descuadre en 96
  pasos comprobados (7 a 12 por cartola, las 8) una vez corregido un bug del
  propio `pnpm calibrate` — su verificación de saldo comparaba el salto
  declarado contra el monto de la última fila, no contra la suma de todas las
  filas desde el último saldo declarado, y esta cartola imprime el saldo cada
  2-3 filas, no en cada una. El validador real (`checkBalanceWalk`) nunca tuvo
  ese bug; sólo el reporte de calibración lo tenía.

**Hallazgo nuevo, sin explicar todavía — no bloquea, `balanceCheck` sigue
`advisory`:** el aviso `balance-total-mismatch` (saldo inicial declarado +
movimientos ≠ saldo final declarado) aparece en las 8 cartolas, a pesar de que
el recorrido paso a paso cuadra exacto. Probable causa: `readDeclaredBalances`
lee un saldo declarado del preámbulo con una wording distinta a la fila
`SALDO INICIAL`/`SALDO FINAL` de la tabla (p. ej. contable vs. disponible, o
un momento distinto), no confirmado sin ver el preámbulo real.

**Lo que falta confirmar con las mismas 8 cartolas antes de `verified`:**

- Clasificación (`kind`) por producto vs. por glosa, y semántica de
  transferencias/pago de tarjeta en este banco específico — no verificable sin
  ver las glosas reales; `pnpm calibrate` no las expone por diseño.
- El hallazgo de `balance-total-mismatch` de arriba.
- Separador y layout de una eventual exportación **CSV** de cuenta corriente
  (las 8 muestras reales son XLS).

**Para la tarjeta hace falta:** un estado de cuenta real. Hay que confirmar cómo
se expresan las cuotas y si los pagos vienen en la misma columna de monto con
signo invertido.

---

## BancoEstado

| Producto | Formato | Estado | Parser |
| --- | --- | --- | --- |
| CuentaRUT | CSV / XLSX | ⚠️ pendiente (calibrado 2026-09) | `banco-estado.cuenta` |
| Cuenta corriente | CSV / XLSX | ⚠️ pendiente | `banco-estado.cuenta` |
| Chequera electrónica | CSV | ⚠️ pendiente | `banco-estado.cuenta` |
| Cualquiera | PDF | 🚫 | — |

Mapeo asumido:

| Rol | Encabezados esperados |
| --- | --- |
| fecha | `Fecha`, `Fecha Transaccion`, `Fecha Movimiento` |
| descripción | `Descripcion`, `Detalle`, `Glosa` |
| cargo | `Cargo`, `Cargos`, `Giro`, `Giros` |
| abono | `Abono`, `Abonos`, `Deposito`, `Depositos` |
| saldo | `Saldo` |
| canal | `Canal`, `Tipo Movimiento` |

**Hallazgos de calibración 2026-09** (primera cartola XLSX real de CuentaRUT
observada; fixture sintético equivalente en `samples/synthetic/`):

1. **Separador de columna CSV:** `;` (punto y coma) — confirmado.
2. **Fecha de transacción:** `dd/mmm` sin año (p. ej. `03/sep`). El año se
   infiere del período declarado en el preámbulo (`Fecha Inicio`/`Fecha
   Termino`/`Fecha Final`). Sin período declarado, la fila falla — comportamiento
   intencional.
3. **Separador de miles en XLSX `Cargo`/`Abono`:** coma (`12,450`). El parser
   lo detecta automáticamente mediante evidencia léxica (grupos de tres dígitos
   separados por coma) y sólo en XLSX; un CSV con coma es ambiguo y se bloquea.
4. **Separador de miles en XLSX `Saldo`:** punto (`137.550`). Mismo archivo,
   distinto formato — el parser maneja ambos por columna.
5. **`Cargo` llega positivo** — el parser lo convierte a negativo.

**Lo que falta confirmar con una segunda cartola real:**

- Clasificación (`kind`) en escenarios distintos de compra y abono básico
  (devoluciones, pagos, avances en efectivo).
- Chequera Electrónica y cuenta corriente, que esta calibración no cubrió.
- Codificación — los exportes antiguos venían en Windows-1252 (ya soportado,
  pero conviene confirmar en un archivo real moderno).

Es el banco prioritario: CuentaRUT es la cuenta que la mayoría de los chilenos
tiene.

---

## Banco Falabella / CMR

| Producto | Formato | Estado | Parser |
| --- | --- | --- | --- |
| Tarjeta CMR | CSV / XLSX | ⚠️ pendiente | `banco-falabella.cmr` |
| Cuenta corriente | CSV / XLSX | ⚠️ pendiente | `banco-falabella.cuenta` |
| Cualquiera | PDF | 🚫 | — |

Mapeo asumido para CMR:

| Rol | Encabezados esperados |
| --- | --- |
| fecha | `Fecha`, `Fecha Compra`, `Fecha Transaccion` |
| descripción | `Descripcion`, `Comercio`, `Detalle Movimiento` |
| monto | `Monto`, `Monto Total`, `Valor Cuota` |
| cuotas | `Cuotas`, `Cuota`, `N Cuotas` |
| tarjeta | `Tarjeta`, `N Tarjeta` |
| rubro | `Rubro`, `Categoria` |

**Para validarlo hace falta:** un estado de cuenta real de CMR. La pregunta
crítica es una: **¿`Monto` es el valor de la cuota o el total de la compra?**
De eso depende todo el cálculo de deuda comprometida. También hay que confirmar
cómo se marcan los pagos recibidos y las anulaciones.

Es el banco donde las cuotas más importan: en el retail chileno casi todo se
vende en cuotas, y una importación CMR que se pierda los marcadores de cuota da
una imagen muy equivocada de lo comprometido.

---

## Genérico

| Formato | Estado | Parser |
| --- | --- | --- |
| CSV / TXT / XLSX de cuenta | ✅ verificado | `generico.cuenta` |
| CSV / TXT / XLSX de tarjeta | ✅ verificado | `generico.tarjeta` |

Funcionan con cualquier archivo que tenga fecha, descripción y monto (o
cargo/abono). Es la salida cuando el formato de un banco cambia o cuando se
quiere importar de una institución todavía no cubierta.

---

## Soporte por formato de archivo

| Formato | Estado | Nota |
| --- | --- | --- |
| CSV | ✅ | Comillas RFC 4180, delimitador autodetectado, UTF-8 y Windows-1252 |
| TXT / TSV delimitado | ✅ | Mismo lector |
| XLSX | ✅ | SheetJS 0.20.3 |
| XLS (BIFF antiguo) | ✅ | SheetJS lee OLE2. Ver [ADR 0004](adr/0004-libreria-planillas.md) |
| OFX / QFX / CAMT | 🚫 todavía | Ningún banco chileno de los prioritarios lo ofrece por defecto |
| PDF | 🚫 | Nunca como fuente primaria si existe un archivo tabular |
| OCR | 🚫 | Último recurso; no está en el roadmap |

---

## Cómo calibrar un perfil cuando llegue una cartola real

1. Poner el archivo en `samples/private/` (ignorado por Git — **nunca** lo
   subas).
2. Importarlo desde el wizard. Elegir el banco a mano si la detección falla.
3. Revisar la vista previa: fechas, signos, montos, saldo final.
4. Ajustar `columnSynonyms`, `amountSign` o `ignoreRowPatterns` en el perfil
   correspondiente de `addon/src/core/providers/`.
5. Crear un **fixture sintético equivalente** en `samples/synthetic/`: misma
   estructura, mismos encabezados, datos inventados. Nunca copiar el real.
6. Añadir tests contra ese fixture.
7. Subir `parserVersion` y cambiar `validationStatus` a `verified`.
8. Actualizar este documento.

El paso 5 no es opcional: es lo que permite que el arreglo quede protegido por
un test sin que ningún dato real entre al repositorio. Ver
[PRIVACY.md](PRIVACY.md).

---

## `pnpm calibrate` — el paso 3, con números

Los pasos 3 y 4 de arriba dicen «revisar la vista previa» y «ajustar el
perfil». Entre los dos hay una pregunta que a ojo no se responde: *en qué* se
equivocó el perfil. Para eso existe la herramienta.

```bash
cd addon
pnpm --silent calibrate -- ~/Descargas/cartola.csv
pnpm --silent calibrate -- ~/Descargas/cartola.xlsx --parser banco-chile.cuenta-corriente
```

Imprime, y nada más que esto:

| Bloque | Para qué sirve |
| --- | --- |
| Detección | Con qué perfil se leyó, con cuánta confianza y **qué otros perfiles reclamaron el archivo**. Dos perfiles empatados es un problema de perfiles que no aparece en la salida de ninguno de los dos. |
| Cabecera | Roles normalizados y posiciones sin mapear. El operador mira esa posición en el archivo privado; el informe no copia texto libre. |
| Filas | Leídas, omitidas, fallidas, con los números de línea de las fallidas. |
| Montos | Cuántos montos quedaron en cada escala decimal. Una nube de escala 2 en una cartola en pesos dice que el separador de miles se leyó como decimal — el error más caro posible, invisible en un conteo de filas. |
| Fechas | Orden del archivo, fechas distintas, filas cuya fecha o monto admitía más de una lectura. |
| Saldos | Pasos comprobados, descuadres y **de qué clase**: `sign` (convención de signo al revés), `scale-100` (factor de cien). La clase, nunca el tamaño. |
| Clasificación | Filas por tipo, sin clasificar, y las clasificadas sólo por el producto. |

### Lo que no imprime, por diseño

Un informe de calibración se pega en un issue y se lee por encima del hombro,
así que no lleva la cartola:

- ninguna glosa, comercio ni nombre de titular;
- ningún monto — ni siquiera un total. Sólo la *forma* de los montos;
- ningún RUT, número de cuenta ni de tarjeta;
- ningún nombre ni huella del archivo: sólo su extensión allowlisted y tamaño.

Los encabezados de columna no salen: una cabecera inusual puede contener un
nombre o número de cuenta. El informe muestra roles canónicos (`date`,
`description`, `debit`, `credit`, `balance`) y posiciones sin mapear.

Todo esto está fijado por tests en `addon/tests/calibration.test.ts`, que
comprueban tanto lo que el informe dice como lo que no puede decir.

### La guarda

La herramienta acepta dentro del repositorio sólo `samples/private/`, y sólo
mientras Git lo ignore. Cualquier otra ubicación interna se rechaza sin repetir
la ruta privada:

```
El archivo está dentro del repositorio y fuera de samples/private/.
```

`samples/private/` está ignorado y se acepta. La pregunta «¿está
ignorado?» se la hace a `git check-ignore`, no a una reimplementación de
`.gitignore`.

El archivo se lee en memoria durante una llamada y no se copia a ninguna parte:
ni al repositorio, ni a `.ai/`, ni a un directorio temporal.

### Y después

Un informe de calibración **no** convierte un perfil en `verified`. Eso sigue
necesitando el paso 5: un fixture sintético equivalente, escrito a mano, y
tests contra él. Anonimizar la cartola real cambiando unos nombres no es
equivalente y no se hace.
