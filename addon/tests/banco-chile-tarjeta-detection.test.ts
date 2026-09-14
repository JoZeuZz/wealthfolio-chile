import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll } from '../src/core/providers/registry';
import type { ParserInput } from '../src/core/providers/parser';
import { fromXlsxRows, fromXlsxSheets, loadFixture } from './fixtures';
import type { SourceFile } from '../src/core/parsing/tabular';

/**
 * `banco-chile.tarjeta` losing autodetection to `generico.tarjeta` on all 4
 * real samples is a functional-security problem, not just UX: if the generic
 * parser wins, an international file might never reach the
 * `foreign-currency-unsupported` guard, which only `banco-chile.tarjeta`
 * declares.
 *
 * Why it lost: `genericCardParser`'s weak markers (`CUOTA`, `TARJETA`,
 * `FACTURACION`) are single common words that any card statement's own
 * vocabulary trivially satisfies, and they cap at the same 0.3 ceiling as
 * `bancoChileCardParser`'s narrower weak markers (`TARJETA DE CREDITO`,
 * `CUPO TOTAL/UTILIZADO`) — which the real preamble mostly does not spell
 * out. Structural fit (installment column, no balance) scores identically
 * for both, since it only depends on the statement's *product*, not which
 * bank profile is being scored. Neither `strongMarkers` (`BANCO DE CHILE`,
 * `BANCHILE`) nor `fileNamePatterns` (`tarjeta`, `estado.?cuenta`) match a
 * real `Mov_Facturado*.xls` at all.
 *
 * The fix adds one `strongMarkers` entry built from a *combination* of two
 * structural facts the user confirmed by hand from the real files (never
 * read directly by this project): a `Movimientos Nacionales`/
 * `Internacionales` section title, together with the card's own
 * billing-summary vocabulary (`Monto Facturado`, `Pago Mínimo`, `Fecha de
 * Facturación`, `Pagar Hasta`, or the `Movimientos Facturados` title itself).
 * Neither half alone is trusted as Banco-de-Chile-specific — `Pago Mínimo` or
 * `Facturación` could appear on any Chilean card statement — but seeing a
 * `Movimientos Nacionales/Internacionales` split *together with* this
 * project's billing vocabulary is the actual export layout, confirmed on all
 * 4 real files structurally (never their values). No new detection
 * abstraction: this is one more entry in the existing `strongMarkers` array.
 */

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

function topParser(file: SourceFile) {
  return detectAll(inputForFile(file))[0];
}

/**
 * Real layout, confirmed structurally: title, billing summary, section,
 * header. Deliberately without the literal text "Banco de Chile" or
 * "Banchile" anywhere — none of the 4 real files matched that strong marker
 * either, which is itself part of why detection lost to the generic parser.
 */
function nationalFile(name = 'mov-facturado-nacional.xlsx') {
  return fromXlsxRows(name, [
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Facturados'],
    ['Monto Facturado', 'Pago Minimo', 'Fecha de Facturacion', 'Pagar Hasta'],
    [],
    ['Movimientos Nacionales'],
    ['Categoria', 'Fecha', 'Descripcion', 'Cuotas', 'Monto ($)'],
    ['VIAJES', '05/02/2026', 'HOTEL SINTETICO', '', '38.500'],
  ]);
}

function internationalFile(name = 'mov-facturado-internacional.xlsx') {
  return fromXlsxRows(name, [
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Facturados'],
    ['Monto Facturado', 'Pago Minimo', 'Fecha de Facturacion', 'Pagar Hasta'],
    [],
    ['Movimientos Internacionales'],
    ['Categoria', 'Fecha', 'Descripcion', 'Pais', 'Monto Moneda Origen', 'Monto (USD)'],
    ['VIAJES', '05/02/2026', 'HOTEL SINTETICO MIAMI', 'ESTADOS UNIDOS', '48,00', '52,30'],
  ]);
}

describe('autodetección — Nacional', () => {
  it('banco-chile.tarjeta gana, con score mayor que generico.tarjeta', () => {
    const detections = detectAll(inputForFile(nationalFile()));
    const bancoChile = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    const generico = detections.find((d) => d.parser === 'generico.tarjeta');

    expect(bancoChile).toBeDefined();
    expect(generico).toBeDefined();
    expect(bancoChile!.score).toBeGreaterThan(generico!.score);
    expect(detections[0]?.parser).toBe('banco-chile.tarjeta');
  });
});

describe('autodetección — Internacional', () => {
  it('banco-chile.tarjeta gana también sobre el layout internacional', () => {
    const detections = detectAll(inputForFile(internationalFile()));
    const bancoChile = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    const generico = detections.find((d) => d.parser === 'generico.tarjeta');

    expect(bancoChile).toBeDefined();
    expect(generico).toBeDefined();
    expect(bancoChile!.score).toBeGreaterThan(generico!.score);
    expect(detections[0]?.parser).toBe('banco-chile.tarjeta');
  });
});

describe('controles negativos', () => {
  it('un genérico de tarjeta con vocabulario común no se convierte en Banco de Chile', () => {
    const file = fromXlsxRows('generic-card-export.xlsx', [
      ['Resumen de Facturacion'],
      [],
      ['Fecha', 'Descripcion', 'Monto', 'Cuotas'],
      ['05/02/2026', 'COMPRA GENERICA', '10.000', ''],
    ]);

    expect(topParser(file)?.parser).not.toBe('banco-chile.tarjeta');
  });

  it('Banco Falabella CMR no pierde contra Banco de Chile', () => {
    expect(topParser(loadFixture('falabella-cmr.csv'))?.parser).toBe('banco-falabella.cmr');
  });

  it('Banco de Chile cuenta corriente sigue ganando para su propio formato', () => {
    expect(topParser(loadFixture('banco-chile-cuenta-corriente.csv'))?.parser).toBe(
      'banco-chile.cuenta-corriente',
    );
  });

  it('CMR real-shaped con firma estructural de Banco de Chile: gana Falabella CMR, no Banco de Chile', () => {
    // Reproduce el P1 del review: branding CMR/Falabella explícito PERO el
    // vocabulario estructural (Movimientos Nacionales + billing summary) que
    // activa el strong marker propio de Banco de Chile. Antes del fix ambos
    // empataban en score 1 y el orden del registry (Banco de Chile primero)
    // desempataba mal.
    const file = fromXlsxRows('cmr-realshaped.xlsx', [
      ['CMR FALABELLA'],
      ['Titular', 'CLIENTE SINTETICO'],
      [],
      ['Movimientos Facturados'],
      ['Monto Facturado', 'Pago Minimo', 'Fecha de Facturacion', 'Pagar Hasta'],
      [],
      ['Movimientos Nacionales'],
      ['Fecha', 'Descripcion', 'Cuotas', 'Monto'],
      ['05/02/2026', 'COMPRA SINTETICA', '3/12', '15.000'],
    ]);

    const detections = detectAll(inputForFile(file));
    const bancoChile = detections.find((d) => d.parser === 'banco-chile.tarjeta');

    expect(topParser(file)?.parser).toBe('banco-falabella.cmr');
    // Banco de Chile no sólo pierde: queda descalificado del todo, no sólo
    // relegado a segundo lugar por un margen chico.
    expect(bancoChile).toBeUndefined();
  });

  it('lo mismo sin que el nombre de archivo mencione cmr/falabella — el texto basta', () => {
    const file = fromXlsxRows('archivo-neutro.xlsx', [
      ['CMR FALABELLA'],
      ['Titular', 'CLIENTE SINTETICO'],
      [],
      ['Movimientos Facturados'],
      ['Monto Facturado', 'Pago Minimo', 'Fecha de Facturacion', 'Pagar Hasta'],
      [],
      ['Movimientos Nacionales'],
      ['Fecha', 'Descripcion', 'Cuotas', 'Monto'],
      ['05/02/2026', 'COMPRA SINTETICA', '3/12', '15.000'],
    ]);

    expect(topParser(file)?.parser).toBe('banco-falabella.cmr');
  });

  it('Banco de Chile real-shaped SIN branding textual rival sigue ganando (sin regresión)', () => {
    expect(topParser(nationalFile())?.parser).toBe('banco-chile.tarjeta');
  });

  it('Banco de Chile cuenta corriente no se ve afectado por el marker descalificante de tarjeta', () => {
    expect(topParser(loadFixture('banco-chile-cuenta-corriente.csv'))?.parser).toBe(
      'banco-chile.cuenta-corriente',
    );
  });

  it('el nombre de archivo Mov_Facturado.xls por sí solo no basta sin la firma estructural', () => {
    const file = fromXlsxRows('Mov_Facturado.xls', [
      ['Estado de Cuenta Tarjeta de Credito'],
      [],
      ['Fecha', 'Descripcion', 'Monto', 'Cuotas'],
      ['05/02/2026', 'COMPRA GENERICA', '10.000', ''],
    ]);

    expect(topParser(file)?.parser).not.toBe('banco-chile.tarjeta');
  });
});

/**
 * P1 (re-review OpenCode) — branding en una hoja distinta a la de datos.
 *
 * `detectWithProfile` sólo miraba el preámbulo de la hoja que `pickDataSheet`
 * elige. Un workbook real puede traer una "Portada" separada con el branding
 * explícito del banco y los movimientos en OTRA hoja cuya firma estructural
 * coincide con `banco-chile.tarjeta` (Movimientos Nacionales + vocabulario
 * de facturación) — `pickDataSheet` elige la hoja de datos por ancho/columnas,
 * nunca la Portada, así que ni `strongMarkers` de Falabella ni
 * `disqualifyingMarkers` de Banco de Chile veían nunca el "CMR"/"BANCO
 * FALABELLA" de la portada. `workbookPreambleText` agrega el preámbulo de
 * TODAS las hojas (nunca sus filas de movimiento) antes de evaluar markers.
 */
describe('branding multi-hoja (Portada separada de los datos)', () => {
  const dataSheetRows = [
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Facturados'],
    ['Monto Facturado', 'Pago Minimo', 'Fecha de Facturacion', 'Pagar Hasta'],
    [],
    ['Movimientos Nacionales'],
    ['Categoria', 'Fecha', 'Descripcion', 'Cuotas', 'Monto ($)'],
    ['VIAJES', '05/02/2026', 'HOTEL SINTETICO', '', '38.500'],
  ];
  const portadaRows = [['CMR'], ['BANCO FALABELLA'], ['Estado de Cuenta']];

  it('Portada con CMR/Banco Falabella + hoja de datos con firma de Banco de Chile: gana Falabella, Banco de Chile queda descalificado', () => {
    const file = fromXlsxSheets('cmr-portada-separada.xlsx', [
      { name: 'Portada', rows: portadaRows },
      { name: 'Movimientos', rows: dataSheetRows },
    ]);

    const detections = detectAll(inputForFile(file));
    const bancoChile = detections.find((d) => d.parser === 'banco-chile.tarjeta');

    expect(topParser(file)?.parser).toBe('banco-falabella.cmr');
    expect(bancoChile).toBeUndefined();
  });

  it('mismo resultado con el orden de hojas invertido (datos primero, Portada después)', () => {
    const file = fromXlsxSheets('cmr-portada-separada-invertido.xlsx', [
      { name: 'Movimientos', rows: dataSheetRows },
      { name: 'Portada', rows: portadaRows },
    ]);

    expect(topParser(file)?.parser).toBe('banco-falabella.cmr');
  });

  it('Banco de Chile verdadero (sin Falabella en ninguna hoja) no se ve afectado', () => {
    const file = fromXlsxSheets('banco-chile-portada-separada.xlsx', [
      { name: 'Portada', rows: [['BANCO DE CHILE'], ['Estado de Cuenta']] },
      { name: 'Movimientos', rows: dataSheetRows },
    ]);

    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });

  it('"Falabella" mencionado sólo en una descripción de movimiento NO descalifica a Banco de Chile', () => {
    const rowsWithFalabellaMerchant = [
      ...dataSheetRows.slice(0, -1),
      ['VIAJES', '05/02/2026', 'COMPRA EN FALABELLA RETAIL', '', '38.500'],
    ];
    const file = fromXlsxSheets('banco-chile-comercio-falabella.xlsx', [
      { name: 'Portada', rows: [['BANCO DE CHILE'], ['Estado de Cuenta']] },
      { name: 'Movimientos', rows: rowsWithFalabellaMerchant },
    ]);

    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });
});
