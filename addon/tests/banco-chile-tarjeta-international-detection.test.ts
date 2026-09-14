import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll } from '../src/core/providers/registry';
import { defaultRules } from '../src/core/rules/builtin';
import { fromXlsxRows, fromXlsxSheets, fromText } from './fixtures';
import type { ParserInput } from '../src/core/providers/parser';
import type { SourceFile } from '../src/core/parsing/tabular';

/**
 * P0 (review independiente, host smoke Sesión 9): un workbook cuya única
 * marca de banco es el texto llano "Banco de Chile" — sin el vocabulario de
 * facturación (`Monto Facturado`, `Pago Mínimo`, ...) que
 * `banco-chile-tarjeta-detection.test.ts` ya usa para separar
 * `banco-chile.tarjeta` de `generico.tarjeta` — empataba 75%/75% contra
 * `banco-chile.cuenta-corriente` cuando la única cabecera transaccional que
 * `pickDataSheet`/`detectHeader` llegaba a ver era la tabla "Movimientos
 * Internacionales" (sin columna de cuotas, así que `scoreStructuralFit` no
 * aportaba nada a favor de la tarjeta). El desempate por orden de registro
 * (`bancoChileCheckingParser` antes que `bancoChileCardParser` en
 * `registry.ts`) resolvía el empate a favor de cuenta corriente, y el archivo
 * terminaba bloqueado por un motivo genérico de cuenta/moneda en vez de
 * `foreign-currency-unsupported` — el único blocker que declara
 * `banco-chile.tarjeta`.
 *
 * El fix reutiliza `detectUnsupportedLayoutInWorkbook` (ya existía para el
 * P0 de import — ver `profile-parser.ts`) también en tiempo de DETECCIÓN:
 * si el workbook contiene, en cualquier hoja y en cualquier posición, una
 * cabecera transaccional plausible (`findHeaderRows`) que además trae la
 * columna exacta que el perfil declara como layout reconocido-pero-no-
 * soportado (`Monto (USD)`), eso es evidencia estructural específica de
 * producto — "recognize ≠ support" — y suma un puntaje decisivo a favor de
 * `banco-chile.tarjeta`, nunca a otro perfil (sólo éste declara
 * `unsupportedLayoutHeaders`).
 */

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

function topParser(file: SourceFile) {
  return detectAll(inputForFile(file))[0];
}

function prepare(file: SourceFile, parserId = 'banco-chile.tarjeta') {
  return prepareImport({
    file,
    accountId: 'acc-card',
    parserId,
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

// Branding mínimo real-shaped: sólo "Banco de Chile" + titular, sin ninguno
// de los rótulos de facturación que el marker complejo ya cubre.
const NACIONAL_ROWS = [
  ['Banco de Chile'],
  ['Titular', 'CLIENTE SINTETICO'],
  [],
  ['Movimientos Nacionales'],
  ['Categoría', 'Fecha', 'Descripción', 'Cuotas', 'Monto ($)'],
  ['SUPERMERCADO', '05/02/2026', 'SUPERMERCADO SINTETICO', '', '38.500'],
];

const INTERNACIONAL_ROWS = [
  ['Banco de Chile'],
  ['Titular', 'CLIENTE SINTETICO'],
  [],
  ['Movimientos Internacionales'],
  ['Categoría', 'Fecha', 'Descripción', 'País', 'Monto Moneda Origen', 'Monto (USD)'],
  ['VIAJES', '05/02/2026', 'HOTEL SINTETICO MIAMI', 'ESTADOS UNIDOS', '48,00', '52,30'],
];

describe('Internacional como única tabla (branding mínimo, sin vocabulario de facturación)', () => {
  const file = fromXlsxRows('mov-facturado-internacional-solo.xlsx', INTERNACIONAL_ROWS);

  it('detectAll elige banco-chile.tarjeta, no cuenta-corriente', () => {
    const detections = detectAll(inputForFile(file));
    const card = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    const checking = detections.find((d) => d.parser === 'banco-chile.cuenta-corriente');

    expect(card).toBeDefined();
    expect(checking).toBeDefined();
    expect(card!.score).toBeGreaterThan(checking!.score);
    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });

  it('prepareImport bloquea con foreign-currency-unsupported, no con un motivo de cuenta genérico', () => {
    const prepared = prepare(file);
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');

    expect(issue).toBeDefined();
    expect(issue?.level).toBe('error');
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('Multi-tabla invertido: Sheet A Nacional, Sheet B Internacional→Nacional', () => {
  const file = fromXlsxSheets('mixto-invertido-b.xlsx', [
    { name: 'Nacionales', rows: NACIONAL_ROWS },
    { name: 'Movimientos', rows: [...INTERNACIONAL_ROWS, [], ...NACIONAL_ROWS] },
  ]);

  it('detectAll elige banco-chile.tarjeta pese a que el primer header visible es Internacional', () => {
    const detections = detectAll(inputForFile(file));
    const card = detections.find((d) => d.parser === 'banco-chile.tarjeta');
    const checking = detections.find((d) => d.parser === 'banco-chile.cuenta-corriente');

    expect(card).toBeDefined();
    expect(checking).toBeDefined();
    expect(card!.score).toBeGreaterThan(checking!.score);
    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });

  it('prepareImport bloquea con foreign-currency-unsupported', () => {
    const prepared = prepare(file);
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');

    expect(issue).toBeDefined();
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('Multi-tabla normal (regresión): Sheet A Nacional, Sheet B Nacional→Internacional', () => {
  const file = fromXlsxSheets('mixto-normal-b.xlsx', [
    { name: 'Nacionales', rows: NACIONAL_ROWS },
    { name: 'Movimientos', rows: [...NACIONAL_ROWS, [], ...INTERNACIONAL_ROWS] },
  ]);

  it('sigue eligiendo banco-chile.tarjeta y bloqueando con foreign-currency-unsupported', () => {
    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');

    const prepared = prepare(file);
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(true);
    expect(prepared.statement.transactions).toHaveLength(0);
  });
});

describe('controles negativos', () => {
  it('cuenta corriente real-shaped (con branding Banco de Chile) sigue ganando cuenta-corriente, no tarjeta', () => {
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

  it('tarjeta genérica sin firma exacta de Banco de Chile no se promueve', () => {
    const file = fromXlsxRows('generic-card-no-signature.xlsx', [
      ['Resumen de Facturacion'],
      [],
      ['Fecha', 'Descripcion', 'Monto', 'Cuotas'],
      ['05/02/2026', 'COMPRA GENERICA', '10.000', ''],
    ]);

    expect(topParser(file)?.parser).not.toBe('banco-chile.tarjeta');
  });

  it('Nacional solo sigue detectando banco-chile.tarjeta (sin cambios)', () => {
    const file = fromXlsxRows('mov-facturado-nacional-solo.xlsx', NACIONAL_ROWS);
    expect(topParser(file)?.parser).toBe('banco-chile.tarjeta');
  });
});
