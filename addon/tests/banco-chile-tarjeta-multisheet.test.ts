import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { fromXlsxSheets, loadFixture } from './fixtures';
import { defaultRules } from '../src/core/rules/builtin';

/**
 * P0 (review independiente): un workbook con "Movimientos Nacionales" en una
 * hoja y "Movimientos Internacionales" en otra dejaba pasar la hoja Nacional
 * completa — `pickDataSheet` elige una sola hoja, `detectUnsupportedLayout`
 * sólo miraba esa hoja, y la Internacional desaparecía sin bloqueo ni aviso
 * de error. Ver `detectUnsupportedLayoutAcrossSheets` en
 * `core/providers/profile-parser.ts`.
 */

// Ancho a propósito (7 columnas) para que `pickDataSheet` la elija sobre la
// hoja Internacional (6 columnas) — la reproducción del P0 depende de que la
// hoja Nacional, no la Internacional, sea la que el picker ve primero.
const NACIONAL_ROWS = [
  ['Banco de Chile'],
  ['Titular', 'CLIENTE SINTETICO'],
  [],
  ['Movimientos Nacionales'],
  ['Categoría', 'Fecha', 'Descripción', 'Cuotas', 'Monto ($)', 'N Documento', 'Tarjeta'],
  ['SUPERMERCADO', '05/02/2026', 'SUPERMERCADO SINTETICO PROVIDENCIA', '', '38.500', '1001', '****1234'],
];

const INTERNACIONAL_ROWS = [
  ['Banco de Chile'],
  ['Titular', 'CLIENTE SINTETICO'],
  [],
  ['Movimientos Internacionales'],
  ['Categoría', 'Fecha', 'Descripción', 'País', 'Monto Moneda Origen', 'Monto (USD)'],
  ['VIAJES', '05/02/2026', 'HOTEL SINTETICO MIAMI', 'ESTADOS UNIDOS', '48,00', '52,30'],
];

const COVER_MENTIONING_USD = [
  ['Banco de Chile'],
  ['Resumen de su tarjeta — cupo disponible en USD referencial informativo'],
  ['Titular', 'CLIENTE SINTETICO'],
  [],
];

function prepare(file: ReturnType<typeof fromXlsxSheets>) {
  return prepareImport({
    file,
    accountId: 'acc-card',
    parserId: 'banco-chile.tarjeta',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('1. Nacional en hoja A + Internacional en hoja B', () => {
  const prepared = prepare(
    fromXlsxSheets('mixto.xlsx', [
      { name: 'Nacionales', rows: NACIONAL_ROWS },
      { name: 'Internacionales', rows: INTERNACIONAL_ROWS },
    ]),
  );

  it('reporta foreign-currency-unsupported', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(issue?.level).toBe('error');
  });

  it('cero transacciones — Nacional no se importa parcialmente', () => {
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.rows).toHaveLength(0);
  });

  it('validation.ok es false', () => {
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('2. Internacional en hoja A + Nacional en hoja B (orden invertido)', () => {
  const prepared = prepare(
    fromXlsxSheets('mixto-invertido.xlsx', [
      { name: 'Internacionales', rows: INTERNACIONAL_ROWS },
      { name: 'Nacionales', rows: NACIONAL_ROWS },
    ]),
  );

  it('mismo resultado: bloqueo total', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('3. Nacional + portada no transaccional que menciona USD', () => {
  const prepared = prepare(
    fromXlsxSheets('nacional-con-portada-usd.xlsx', [
      { name: 'Portada', rows: COVER_MENTIONING_USD },
      { name: 'Nacionales', rows: NACIONAL_ROWS },
    ]),
  );

  it('NO bloquea falsamente por una mención de USD fuera de un header real', () => {
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.transactions.length).toBeGreaterThan(0);
  });
});

describe('4. Dos hojas Nacional compatibles', () => {
  const secondNacional = [
    ['Banco de Chile'],
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Nacionales'],
    ['Categoría', 'Fecha', 'Descripción', 'Cuotas', 'Monto ($)'],
    ['FARMACIA', '06/02/2026', 'FARMACIA SINTETICA NUNOA', '', '12.000'],
  ];
  const prepared = prepare(
    fromXlsxSheets('dos-nacionales.xlsx', [
      { name: 'Nacionales1', rows: NACIONAL_ROWS },
      { name: 'Nacionales2', rows: secondNacional },
    ]),
  );

  it('no bloquea por foreign-currency (ninguna hoja es Internacional)', () => {
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });

  it('avisa explícitamente que hay múltiples hojas con datos (no oculta en silencio)', () => {
    expect(prepared.statement.issues.some((i) => i.code === 'multiple-sheets')).toBe(true);
  });
});

describe('5. Una sola hoja Nacional sigue igual', () => {
  const prepared = prepare(fromXlsxSheets('nacional-sola.xlsx', [{ name: 'Nacionales', rows: NACIONAL_ROWS }]));

  it('importa normalmente', () => {
    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.transactions.length).toBeGreaterThan(0);
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });
});

describe('6. Una sola hoja Internacional sigue igual', () => {
  const prepared = prepare(
    fromXlsxSheets('internacional-sola.xlsx', [{ name: 'Internacionales', rows: INTERNACIONAL_ROWS }]),
  );

  it('bloqueada con foreign-currency-unsupported', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(prepared.validation.ok).toBe(false);
    expect(prepared.statement.transactions).toHaveLength(0);
  });
});

describe('7. Nacional seguido de Internacional en la MISMA hoja', () => {
  const prepared = prepare(
    fromXlsxSheets('mixto-una-hoja.xlsx', [
      { name: 'Movimientos', rows: [...NACIONAL_ROWS, ...INTERNACIONAL_ROWS] },
    ]),
  );

  it('reporta foreign-currency-unsupported aunque la Internacional esté bajo la misma cabecera Nacional', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(issue?.level).toBe('error');
  });

  it('cero transacciones — fail-closed total, no sólo la tabla Nacional', () => {
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.rows).toHaveLength(0);
  });

  it('validation.ok es false', () => {
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('8. Internacional seguido de Nacional en la MISMA hoja (orden invertido)', () => {
  const prepared = prepare(
    fromXlsxSheets('mixto-una-hoja-invertido.xlsx', [
      { name: 'Movimientos', rows: [...INTERNACIONAL_ROWS, ...NACIONAL_ROWS] },
    ]),
  );

  it('mismo resultado: bloqueo total', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('Regresión: CSV de una sola hoja no cambia', () => {
  it('banco-chile-tarjeta.csv sigue importando Nacional normalmente', () => {
    const prepared = prepareImport({
      file: loadFixture('banco-chile-tarjeta.csv'),
      accountId: 'acc-card',
      parserId: 'banco-chile.tarjeta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });
    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });
});
