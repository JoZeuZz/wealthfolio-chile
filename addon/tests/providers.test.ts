import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { toDecimalString } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll, getParser, listInstitutions, PARSERS } from '../src/core/providers/registry';
import type { ParserInput } from '../src/core/providers/parser';
import { fromText, loadFixture } from './fixtures';

function inputFor(name: string): ParserInput {
  const file = loadFixture(name);
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

describe('registry', () => {
  it('exposes unique parser ids', () => {
    const ids = PARSERS.map((parser) => parser.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups parsers by institution for the picker', () => {
    const institutions = listInstitutions().map((entry) => entry.id);
    expect(institutions).toContain('banco-chile');
    expect(institutions).toContain('banco-estado');
    expect(institutions).toContain('banco-falabella');
    expect(institutions).toContain('generico');
  });
});

describe('detection', () => {
  it('ranks Banco de Chile first for its own cartola', () => {
    const detections = detectAll(inputFor('banco-chile-cuenta-corriente.csv'));
    expect(detections[0]!.institution).toBe('banco-chile');
    expect(detections[0]!.score).toBeGreaterThan(0.7);
  });

  it('ranks BancoEstado first for a CuentaRUT export', () => {
    const detections = detectAll(inputFor('banco-estado-cuentarut.csv'));
    expect(detections[0]!.institution).toBe('banco-estado');
  });

  it('ranks Falabella first for a CMR statement', () => {
    const detections = detectAll(inputFor('falabella-cmr.csv'));
    expect(detections[0]!.institution).toBe('banco-falabella');
  });

  it('still offers the generic parser for an unbranded file', () => {
    const file = fromText(
      'export.csv',
      ['Fecha;Descripcion;Cargo;Abono;Saldo', '03/02/2026;COMPRA ALGO;1.000;;9.000'].join('\n'),
    );
    const detections = detectAll({
      file,
      sheets: loadWorkbook(file).sheets,
      fileHash: computeFileHash(file.bytes),
    });
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.institution === 'generico')).toBe(true);
  });

  it('does not mistake a cartola for a card statement because a row mentions a card', () => {
    // Regression: marker scanning used to read the movement rows, so the single
    // `PAGO TARJETA DE CREDITO CMR` line made the card parser outrank the
    // current-account one — and every purchase came back classified as a
    // credit-card charge.
    const detections = detectAll(inputFor('banco-chile-cuenta-corriente.csv'));
    expect(detections[0]!.parser).toBe('banco-chile.cuenta-corriente');
  });

  it('prefers a card parser when the file has cuotas and no balance column', () => {
    const detections = detectAll(inputFor('falabella-cmr.csv'));
    expect(detections[0]!.parser).toBe('banco-falabella.cmr');
  });

  it('reports zero for a file with no usable header', () => {
    const file = fromText('ruido.csv', 'hola;mundo\notra;fila');
    const detections = detectAll({
      file,
      sheets: loadWorkbook(file).sheets,
      fileHash: computeFileHash(file.bytes),
    });
    expect(detections).toHaveLength(0);
  });
});

describe('Banco de Chile parser', () => {
  const parser = getParser('banco-chile.cuenta-corriente')!;
  const statement = parser.parse(inputFor('banco-chile-cuenta-corriente.csv'));

  it('reads every movement row and skips the totals line', () => {
    expect(statement.transactions).toHaveLength(12);
  });

  it('signs cargos negative and abonos positive', () => {
    const sueldo = statement.transactions[0]!;
    expect(sueldo.direction).toBe(Direction.in);
    expect(toDecimalString(sueldo.amount)).toBe('1850000');

    const compra = statement.transactions[1]!;
    expect(compra.direction).toBe(Direction.out);
    expect(toDecimalString(compra.amount)).toBe('-85400');
  });

  it('recovers the account number and period from the preamble', () => {
    expect(statement.account.number).toBe('00-123-45678-90');
    expect(statement.period).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('carries the running balance', () => {
    expect(toDecimalString(statement.transactions[0]!.balanceAfter!)).toBe('2010500');
  });

  it('flags the profile as awaiting a real sample', () => {
    expect(statement.issues.some((issue) => issue.code === 'profile-unverified')).toBe(true);
  });

  it('validates the balance walk', () => {
    const result = parser.validate(statement);
    expect(result.summary.balanceReconciles).toBe(true);
  });
});

describe('BancoEstado parser', () => {
  const parser = getParser('banco-estado.cuenta')!;
  const statement = parser.parse(inputFor('banco-estado-cuentarut.csv'));

  it('skips the SALDO ANTERIOR row', () => {
    expect(statement.transactions).toHaveLength(8);
    expect(statement.transactions.some((t) => /SALDO ANTERIOR/i.test(t.description))).toBe(false);
  });

  it('reads the transfer that arrives from the other bank', () => {
    const abono = statement.transactions.find((t) => /ABONO TRANSFERENCIA/.test(t.description))!;
    expect(abono.direction).toBe(Direction.in);
    expect(toDecimalString(abono.amount)).toBe('200000');
  });

  it('walks the declared balances without a mismatch', () => {
    expect(parser.validate(statement).summary.balanceReconciles).toBe(true);
  });
});

describe('Falabella CMR parser', () => {
  const parser = getParser('banco-falabella.cmr')!;
  const statement = parser.parse(inputFor('falabella-cmr.csv'));

  it('treats card charges as purchases, not generic expenses', () => {
    const purchase = statement.transactions[0]!;
    expect(purchase.kind).toBe(TransactionKind.credit_card_purchase);
    expect(purchase.direction).toBe(Direction.out);
  });

  it('inverts the sign so a positive charge is an outflow', () => {
    expect(toDecimalString(statement.transactions[0]!.amount)).toBe('-49990');
  });

  it('treats a negative charge as money coming back to the card', () => {
    const payment = statement.transactions.find((t) => /PAGO RECIBIDO/.test(t.description))!;
    expect(payment.direction).toBe(Direction.in);
    expect(toDecimalString(payment.amount)).toBe('120000');
  });

  it('reads the installment counter from the dedicated column', () => {
    const cuota = statement.transactions[0]!;
    expect(cuota.installment).toMatchObject({ current: 2, total: 6, confidence: 'confirmed' });
  });

  it('reads a bare counter from the description as a suggestion only', () => {
    const ripley = statement.transactions.find((t) => /RIPLEY/.test(t.description))!;
    expect(ripley.installment).toMatchObject({ current: 1, total: 3 });
  });
});
