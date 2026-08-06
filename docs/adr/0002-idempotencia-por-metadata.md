# ADR 0002 — Idempotencia mediante metadata de actividad

- **Estado:** aceptado
- **Fecha:** 2026-08-05

## Problema

Importar la misma cartola dos veces no debe crear ningún movimiento nuevo. Las
cartolas chilenas rara vez traen un identificador de transacción, así que la
identidad hay que derivarla del contenido — y hay que guardarla en alguna parte
para reconocerla la próxima vez.

## Alternativas evaluadas

### A. Registro paralelo en `ctx.api.storage`

Guardar todas las huellas importadas en el almacenamiento del addon.

Descartada. Se desincroniza en cuanto el usuario borra una actividad a mano:
el addon seguiría creyendo que ese movimiento existe y se negaría a
reimportarlo. Además crece sin límite contra un almacenamiento con tope de
~250 KB por valor.

### B. Apoyarse en la detección de duplicados de Wealthfolio

`activities.checkImport()` marca `duplicateOfId`.

Descartada como mecanismo principal: su criterio es de Wealthfolio, no nuestro,
no está documentado como estable, y no cubre el caso de dos exportes del mismo
período con descripciones distintas.

### C. Huella en la metadata de la actividad ✅

`ActivityCreate.metadata` acepta JSON arbitrario y `ActivityDetails.metadata` lo
devuelve al buscar. La huella viaja con el movimiento.

## Decisión

Escribir en cada actividad creada:

```json
{
  "wealthfolioChile": {
    "v": 1,
    "fp": "<sha256 de la huella>",
    "wfp": "<huella débil>",
    "inst": "banco-chile",
    "parser": "banco-chile.cuenta-corriente",
    "parserVersion": "0.1.0",
    "fileHash": "<sha256 del archivo>",
    "runId": "run-…",
    "kind": "expense",
    "cat": "alimentacion.supermercado"
  }
}
```

El índice de duplicados se reconstruye en cada importación leyendo las
actividades de la cuenta con `activities.search()`.

Consecuencia operativa: importamos con `saveMany({ creates })` y no con
`activities.import()`, porque `ActivityImport` **no** tiene campo `metadata`
(`packages/addon-sdk/src/data-types.ts:362`).

### Receta de la huella

```
SHA-256( "v1" · accountId · fecha · monto exacto · moneda · clave(descripción) · referencia )
```

Incluye solo lo que un banco no cambia entre dos exportes del mismo período.
Quedan fuera a propósito el número de fila, el nombre del archivo, el saldo
corrido y nuestra propia clasificación: incluirlos haría que el mismo movimiento
pareciera nuevo tras volver a descargar el archivo.

`clave(descripción)` elimina dígitos y letras sueltas, absorbiendo las
variaciones de formato entre exportes.

La huella está acotada a la cuenta: el mismo monto el mismo día en dos cuentas
distintas son dos movimientos.

### Huella débil

Sin descripción: cuenta + fecha + monto. Agrupa candidatos a duplicado
*probable*, que nunca se omiten automáticamente sin marcarlos como tales — dos
cafés de $2.500 el mismo día son dos movimientos reales.

## Consecuencias

- Reimportar el mismo archivo produce cero movimientos nuevos. Con test.
- Si el usuario borra una actividad, se puede reimportar. Correcto.
- La huella depende de la receta: cambiarla exige subir `FINGERPRINT_VERSION` y
  aceptar que los movimientos antiguos conservan la huella vieja.
- El escaneo de actividades está paginado y acotado (40 páginas × 500).

## Verificado por

`addon/tests/import.test.ts`: mismo archivo dos veces, archivos solapados, fila
repetida dentro del archivo, misma fila en dos cuentas, descripción distinta
para el mismo movimiento.
