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
| Cuenta corriente | CSV / XLSX | ⚠️ pendiente | `banco-chile.cuenta-corriente` |
| Tarjeta de crédito | CSV / XLSX | ⚠️ pendiente | `banco-chile.tarjeta` |
| Cualquiera | PDF | 🚫 | — |

Mapeo asumido para cuenta corriente:

| Rol | Encabezados esperados |
| --- | --- |
| fecha | `Fecha`, `Fecha Transaccion` |
| descripción | `Descripcion`, `Detalle` |
| cargo | `Cargo`, `Cargos (CLP)`, `Cheques y Cargos` |
| abono | `Abono`, `Abonos (CLP)`, `Depositos y Abonos` |
| saldo | `Saldo`, `Saldo (CLP)` |
| referencia | `N Documento`, `Canal o Sucursal` |

**Para validarlo hace falta:** una cartola real (CSV o XLSX) de cuenta
corriente. Hay que confirmar los nombres exactos de columnas, el separador y si
los cargos vienen con signo propio o solo en su columna.

**Para la tarjeta hace falta:** un estado de cuenta real. Hay que confirmar cómo
se expresan las cuotas y si los pagos vienen en la misma columna de monto con
signo invertido.

---

## BancoEstado

| Producto | Formato | Estado | Parser |
| --- | --- | --- | --- |
| CuentaRUT | CSV / XLSX | ⚠️ pendiente | `banco-estado.cuenta` |
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

**Para validarlo hace falta:** una cartola real de CuentaRUT. Tres cosas
concretas a confirmar:

1. El separador — BancoEstado ha usado `;` y tabulaciones según la época.
2. La codificación — los exportes antiguos venían en Windows-1252 (ya
   soportado, pero conviene confirmar).
3. Si `Cargo` llega positivo o negativo.

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
pnpm calibrate -- ~/Descargas/cartola.csv
pnpm calibrate -- ~/Descargas/cartola.xlsx --parser banco-chile.cuenta-corriente
```

Imprime, y nada más que esto:

| Bloque | Para qué sirve |
| --- | --- |
| Detección | Con qué perfil se leyó, con cuánta confianza y **qué otros perfiles reclamaron el archivo**. Dos perfiles empatados es un problema de perfiles que no aparece en la salida de ninguno de los dos. |
| Cabecera | Las columnas mapeadas y, sobre todo, **las que no**. Una columna que el banco imprime y el perfil ignora es un `columnSynonyms` que falta. |
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
- ningún nombre de archivo: su extensión, su tamaño y los primeros doce
  caracteres de su huella SHA-256.

Los encabezados de columna sí salen, y a propósito: `Cargo`, `Abono`,
`Saldo contable` son el vocabulario de formato que un perfil tiene que
aprender, y no identifican a nadie. Aun así pasan por `redactSensitive`.

Todo esto está fijado por tests en `addon/tests/calibration.test.ts`, que
comprueban tanto lo que el informe dice como lo que no puede decir.

### La guarda

La herramienta **se niega** a leer un archivo que esté dentro del repositorio y
que Git no ignore:

```
"addon/cartola.csv" está dentro del repositorio y Git no lo ignora, así que un
`git add -A` lo dejaría preparado para commit.
```

`samples/private/` sí está ignorado y sí se acepta. La pregunta «¿está
ignorado?» se la hace a `git check-ignore`, no a una reimplementación de
`.gitignore`.

El archivo se lee en memoria durante una llamada y no se copia a ninguna parte:
ni al repositorio, ni a `.ai/`, ni a un directorio temporal.

### Y después

Un informe de calibración **no** convierte un perfil en `verified`. Eso sigue
necesitando el paso 5: un fixture sintético equivalente, escrito a mano, y
tests contra él. Anonimizar la cartola real cambiando unos nombres no es
equivalente y no se hace.
