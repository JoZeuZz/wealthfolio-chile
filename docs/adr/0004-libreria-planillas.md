# ADR 0004 — Librería de planillas

- **Estado:** aceptado
- **Fecha:** 2026-08-05

## Problema

Hay que leer XLSX, y ojalá también XLS heredado: varios bancos chilenos ofrecen
la descarga como "Excel". El prompt del proyecto es explícito en que no se
agregue una dependencia abandonada o vulnerable solo para poder anunciar soporte
XLS.

## Alternativas evaluadas

### A. `xlsx` desde npm

`latest` en el registro público es **0.18.5**, publicado en 2022 y congelado.
Arrastra advisories conocidos (prototype pollution, ReDoS). SheetJS dejó de
publicar en npm.

Descartada: es exactamente la dependencia desatendida que el proyecto no quiere.

### B. `exceljs`

MIT, en npm, último release 4.4.0 (diciembre 2024). Lee y escribe XLSX.

Descartada por dos razones: **no lee XLS heredado (BIFF)**, y su superficie
(escritura, streaming, estilos) es mucho mayor que lo que necesitamos, que es
"grilla de strings".

### C. Descomprimir el ZIP y parsear el XML a mano

Un XLSX es un ZIP con XML. Con `fflate` más un parser sería viable.

Descartada: reimplementar shared strings, formatos de celda, fechas seriales y
las rarezas de cada generador es trabajo real y una fuente de errores propia,
para un problema ya resuelto. Y tampoco resolvería XLS.

### D. SheetJS desde su CDN oficial ✅

`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, Apache-2.0.

Es la distribución vigente del proyecto. Lee XLSX y también OLE2/BIFF, que es lo
que hace posible aceptar `.xls` de forma responsable.

## Decisión

```json
"dependencies": {
  "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
}
```

Configurada defensivamente en `core/parsing/workbook.ts`:

```ts
XLSX.read(bytes, {
  raw: false,       // todo llega como texto: nuestro parser de fechas decide
  cellDates: false, // no queremos su coerción de fechas
  cellFormula: false,
  cellStyles: false,
  bookVBA: false,   // el archivo viene de una descarga del navegador
});
```

Fórmulas, estilos y VBA quedan fuera: son irrelevantes para una cartola y solo
ensanchan la superficie de ataque de un archivo de origen externo.

## Consecuencias

**A favor**

- Versión mantenida, sin los advisories de 0.18.5.
- XLS heredado soportado sin dependencias extra.
- Un solo camino de código: todo termina siendo un `Sheet` de strings.

**En contra**

- La dependencia no viene del registro npm. El lockfile de pnpm registra la URL
  y su hash de integridad, así que la instalación es reproducible mientras el
  CDN esté disponible, pero CI necesita alcanzar `cdn.sheetjs.com`.
- Suma ~700 KB al bundle (~190 KB gzip), porque el host no la provee y el addon
  se carga como un único módulo. Para una app local de escritorio es aceptable;
  queda anotado por si el tamaño llega a importar.

## Cuándo revisar

- Si SheetJS vuelve a publicar en npm, migrar al registro.
- Si aparece una versión nueva en el CDN, actualizar la URL y volver a correr
  `./scripts/test.sh`.
- Si el tamaño del bundle se vuelve un problema, evaluar cargar el lector de
  planillas solo cuando el usuario abra una — hoy no se puede, porque el host
  carga `dist/addon.js` como un módulo blob único y un chunk separado no tendría
  URL resoluble.
