import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { prepareImport } from '../src/core/pipeline';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll } from '../src/core/providers/registry';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText, fromXlsxRows, fromXlsxSheets } from './fixtures';
import type { ParserInput } from '../src/core/providers/parser';
import type { SourceFile } from '../src/core/parsing/tabular';

/**
 * P1 (re-review OpenCode) — `Monto (USD)` aislada NO identifica Banco de
 * Chile.
 *
 * El fix anterior (ver `banco-chile-tarjeta-international-detection.test.ts`)
 * reutilizó `detectUnsupportedLayoutInWorkbook` — que sólo exige la columna
 * `Monto (USD)` — también como evidencia de PRODUCTO en tiempo de detección.
 * Pero esa función existe para BLOQUEAR una vez que el parser YA fue
 * elegido, no para demostrar que el archivo es de Banco de Chile: un archivo
 * genérico sin ningún branding, con la única columna "Monto (USD)", ganaba
 * el +0.35 de todos modos y terminaba mal identificado y mal bloqueado con
 * `foreign-currency-unsupported`.
 *
 * El fix exige la firma ESTRUCTURAL COMPLETA del layout Internacional
 * (`recognizedLayoutSignatures`, sólo para puntaje de detección — el blocker
 * de parseo sigue usando `unsupportedLayoutHeaders` sin cambios, porque para
 * cuando se llega a bloquear el parser ya fue elegido por otra vía).
 */

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

function topParser(file: SourceFile) {
  return detectAll(inputForFile(file))[0];
}

function prepareWith(file: SourceFile, parserId: string) {
  return prepareImport({
    file,
    accountId: 'acc-card',
    parserId,
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

const FULL_SIGNATURE_HEADER = ['Categoría', 'Fecha', 'Descripción', 'País', 'Monto Moneda Origen', 'Monto (USD)'];

describe('P1 — Monto (USD) aislada no basta como evidencia de producto', () => {
  it('Caso A — genérica mínima sin branding: NO banco-chile.tarjeta', () => {
    const file = fromXlsxRows('generic-usd-minima.xlsx', [
      ['Fecha', 'Descripción', 'Monto (USD)'],
      ['05/02/2026', 'HOTEL GENERICO', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    expect(detections.find((d) => d.parser === 'banco-chile.tarjeta')).toBeUndefined();
  });

  it('Caso B — genérica con Categoría añadida: NO banco-chile.tarjeta', () => {
    const file = fromXlsxRows('generic-usd-categoria.xlsx', [
      ['Categoría', 'Fecha', 'Descripción', 'Monto (USD)'],
      ['VIAJES', '05/02/2026', 'HOTEL GENERICO', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    expect(detections.find((d) => d.parser === 'banco-chile.tarjeta')).toBeUndefined();
  });

  it('Caso C — con País pero SIN Monto Moneda Origen: la firma no está completa, NO banco-chile.tarjeta', () => {
    const file = fromXlsxRows('generic-usd-pais.xlsx', [
      ['Categoría', 'Fecha', 'Descripción', 'País', 'Monto (USD)'],
      ['VIAJES', '05/02/2026', 'HOTEL GENERICO', 'ESTADOS UNIDOS', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    expect(detections.find((d) => d.parser === 'banco-chile.tarjeta')).toBeUndefined();
  });

  it('Caso D — firma completa de Banco de Chile Internacional: SÍ banco-chile.tarjeta, con score mayor a cuenta-corriente, y bloquea foreign-currency-unsupported', () => {
    const file = fromXlsxRows('banco-chile-internacional-completo.xlsx', [
      FULL_SIGNATURE_HEADER,
      ['VIAJES', '05/02/2026', 'HOTEL SINTETICO MIAMI', 'ESTADOS UNIDOS', '48,00', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    const card = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    const checking = detections.find((d) => d.parser === 'banco-chile.cuenta-corriente');
    expect(card).toBeDefined();
    if (checking) expect(card!.score).toBeGreaterThan(checking.score);

    const prepared = prepareWith(file, 'banco-chile.tarjeta');
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(true);
    expect(prepared.validation.ok).toBe(false);
  });

  it('Caso E — firma completa en workbook multi-tabla invertido: sigue bloqueando específicamente', () => {
    const nacional = [
      ['Categoría', 'Fecha', 'Descripción', 'Cuotas', 'Monto ($)'],
      ['SUPERMERCADO', '05/02/2026', 'SUPERMERCADO SINTETICO', '', '38.500'],
    ];
    const file = fromXlsxSheets('multi-tabla-invertido.xlsx', [
      { name: 'Nacionales', rows: nacional },
      { name: 'Movimientos', rows: [FULL_SIGNATURE_HEADER, ['VIAJES', '05/02/2026', 'HOTEL', 'ESTADOS UNIDOS', '48,00', '52,30'], [], ...nacional] },
    ]);

    const detections = detectAll(inputForFile(file));
    const card = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    expect(card).toBeDefined();
    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');

    const prepared = prepareWith(file, 'banco-chile.tarjeta');
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(true);
    expect(prepared.validation.ok).toBe(false);
  });

  it('Caso F — branding CMR/Falabella explícito descalifica Banco de Chile aunque la firma USD esté completa', () => {
    const file = fromXlsxRows('cmr-falabella-usd.xlsx', [
      ['CMR Falabella'],
      ['Banco Falabella'],
      FULL_SIGNATURE_HEADER,
      ['VIAJES', '05/02/2026', 'HOTEL', 'ESTADOS UNIDOS', '48,00', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    expect(detections.find((d) => d.parser === 'banco-chile.tarjeta')).toBeUndefined();
  });

  it('Caso G — Banco de Chile cuenta corriente real-shaped: sin regresión', () => {
    const file = fromText(
      'cartola-cuenta-corriente.csv',
      [
        'Banco de Chile',
        'Fecha;Descripcion;Canal o Sucursal;Cargos (PESOS);Abonos (PESOS);Saldo (PESOS)',
        '01/05;SALDO INICIAL;;;;500.000',
        '05/05;COMPRA SINTETICA;INTERNET;38.500;;461.500',
        '10/05;SALDO FINAL;;;;461.500',
      ].join('\n'),
    );

    expect(topParser(file)?.parser).toBe('banco-chile.cuenta-corriente');
  });

  it('Caso H — Nacional Banco de Chile: sin regresión', () => {
    const file = fromXlsxRows('nacional-solo.xlsx', [
      ['Banco de Chile'],
      ['Titular', 'CLIENTE SINTETICO'],
      [],
      ['Movimientos Nacionales'],
      ['Categoría', 'Fecha', 'Descripción', 'Cuotas', 'Monto ($)'],
      ['SUPERMERCADO', '05/02/2026', 'SUPERMERCADO SINTETICO', '', '38.500'],
    ]);

    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });

  it('Caso I — glosas/movement text no aportan evidencia de issuer', () => {
    const file = fromXlsxRows('generic-usd-glosas.xlsx', [
      ['Fecha', 'Descripción', 'Monto (USD)'],
      ['05/02/2026', 'BANCO DE CHILE VIAJES INTERNACIONAL', '52,30'],
    ]);

    const detections = detectAll(inputForFile(file));
    // El texto de la fila (glosa) menciona "Banco de Chile", pero los markers
    // sólo se buscan en el preámbulo/encabezado — nunca en filas de
    // movimiento — así que no debe convertirse en evidencia de issuer.
    expect(detections.find((d) => d.parser === 'banco-chile.tarjeta')).toBeUndefined();
  });
});

describe('reason sanitizada del boost de firma completa', () => {
  it('el motivo no incluye valores ni texto bancario libre, sólo la explicación fija', () => {
    const file = fromXlsxRows('banco-chile-internacional-reason.xlsx', [
      FULL_SIGNATURE_HEADER,
      ['VIAJES', '05/02/2026', 'HOTEL SINTETICO MIAMI', 'ESTADOS UNIDOS', '48,00', '52,30'],
    ]);

    const detection = detectAll(inputForFile(file)).find((d) => d.parser === 'banco-chile.tarjeta');
    expect(detection).toBeDefined();
    expect(detection!.reasons).toContain(
      'Se encontró la firma estructural completa del layout internacional de tarjeta reconocido por este perfil.',
    );
  });
});
