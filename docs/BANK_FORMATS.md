# Formatos bancarios

Estado real del soporte por banco y formato, y **exactamente qué falta** para
dar cada uno por validado.

Última revisión: 2026-08-05.

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
