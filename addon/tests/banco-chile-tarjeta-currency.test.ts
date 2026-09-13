import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { matchStatementToAccount } from '../src/core/accounts/match';
import { defaultRules } from '../src/core/rules/builtin';
import { fromXlsxRows, loadFixture } from './fixtures';

/**
 * Banco de Chile — tarjeta trae dos layouts reales confirmados (ver
 * `banco-chile.ts`): "Movimientos Nacionales" (CLP, se mapea normal) y
 * "Movimientos Internacionales" (única columna de monto utilizable en USD).
 *
 * La tubería actual asume una sola moneda por statement en todo su recorrido
 * — `matchStatementToAccount` compara `statement.account.currency` contra la
 * cuenta real, y `computeTotals` suma todo en esa misma moneda — así que no
 * hay forma honesta de importar la tabla internacional sin: (a) etiquetar un
 * monto USD como CLP, o (b) declarar el statement entero en USD y dejar que
 * `matchStatementToAccount`/`computeTotals` fallen de un modo que no explica
 * el problema real. `unsupportedLayoutHeaders` reconoce el layout por su
 * encabezado exacto y lo rechaza antes de mapear ninguna fila.
 *
 * Ningún archivo real fue leído para escribir esto — el layout de columnas es
 * texto estructural que el usuario confirmó a mano.
 */

function internationalFile() {
  return fromXlsxRows('mov-facturado-internacional.xlsx', [
    ['Banco de Chile'],
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Internacionales'],
    ['', 'Categoría', '', 'Fecha', 'Descripción', '', 'País', 'Monto Moneda Origen', 'Monto (USD)'],
    ['', 'VIAJES', '', '05/02/2026', 'HOTEL SINTETICO MIAMI', '', 'ESTADOS UNIDOS', '48,00', '52,30'],
  ]);
}

function prepareInternational() {
  return prepareImport({
    file: internationalFile(),
    accountId: 'acc-card',
    parserId: 'banco-chile.tarjeta',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('Internacional: reconocido y rechazado, no importado', () => {
  const prepared = prepareInternational();

  it('1. reconoce el layout: reporta foreign-currency-unsupported', () => {
    const issue = prepared.statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue).toBeDefined();
    expect(issue?.level).toBe('error');
  });

  it('2. validation.ok es false', () => {
    expect(prepared.validation.ok).toBe(false);
  });

  it('3. el statement no cambia su account.currency a USD', () => {
    expect(prepared.statement.account.currency).toBe('CLP');
  });

  it('4. no existe ninguna transacción — ni real ni falsamente en CLP', () => {
    expect(prepared.statement.transactions).toHaveLength(0);
    expect(prepared.rows).toHaveLength(0);
  });

  it('5. prepareImport no lanza (nada de MoneyError)', () => {
    expect(() => prepareInternational()).not.toThrow();
  });

  it('6. no llega a un account-mismatch causado por cambiar la moneda de la cuenta', () => {
    // La cuenta real es CLP y el statement también quedó en CLP: comparar
    // contra la cuenta real no debe fallar por moneda. El bloqueo real ya
    // ocurrió antes, en el parsing/validation (statement-invalid), no aquí.
    const match = matchStatementToAccount(prepared.statement.account, {
      accountType: 'CREDIT_CARD',
      currency: 'CLP',
    });
    expect(match.reasons.some((r) => /moneda equivocada/.test(r))).toBe(false);
  });

  it('7. no reporta no-transactions además de foreign-currency-unsupported', () => {
    expect(prepared.statement.issues.some((i) => i.code === 'no-transactions')).toBe(false);
  });

  it('8. ningún monto llega a las filas de preview (nada que pudiera llegar a saveMany)', () => {
    expect(prepared.rows.every((r) => !r.willImport)).toBe(true);
    expect(prepared.rows).toHaveLength(0);
  });
});

describe('Nacional: sigue funcionando en CLP', () => {
  const prepared = prepareImport({
    file: loadFixture('banco-chile-tarjeta.csv'),
    accountId: 'acc-card',
    parserId: 'banco-chile.tarjeta',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });

  it('moneda CLP', () => {
    expect(prepared.statement.account.currency).toBe('CLP');
    expect(prepared.rows[0]?.transaction.amount.currency).toBe('CLP');
  });

  it('monto y signo correctos (cargo positivo del banco = salida de dinero)', () => {
    const compra = prepared.rows.find((r) =>
      r.transaction.description.includes('SUPERMERCADO SINTETICO PROVIDENCIA'),
    );
    expect(compra?.transaction.amount.minor).toBe(-38500);
  });

  it('el parser funciona: filas mapeadas, ninguna fallida', () => {
    expect(prepared.statement.rowStats).toMatchObject({ mapped: 7, failed: 0 });
  });

  it('no aparece foreign-currency-unsupported', () => {
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });
});

describe('Regresión: unsupportedLayoutHeaders no toca otros perfiles', () => {
  it('BancoEstado CuentaRUT sigue igual', () => {
    const prepared = prepareImport({
      file: loadFixture('banco-estado-cuentarut.csv'),
      accountId: 'acc-rut',
      parserId: 'banco-estado.cuenta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.statement.account.currency).toBe('CLP');
    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });

  it('Banco Falabella CMR sigue igual', () => {
    const prepared = prepareImport({
      file: loadFixture('falabella-cmr.csv'),
      accountId: 'acc-cmr',
      parserId: 'banco-falabella.cmr',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.statement.account.currency).toBe('CLP');
    expect(prepared.rows.length).toBeGreaterThan(0);
    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });

  it('genérico de tarjeta sigue igual', () => {
    const prepared = prepareImport({
      file: loadFixture('banco-chile-tarjeta.csv'),
      accountId: 'acc-generic',
      parserId: 'generico.tarjeta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.statement.issues.some((i) => i.code === 'foreign-currency-unsupported')).toBe(
      false,
    );
  });
});
