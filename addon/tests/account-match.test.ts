import { describe, expect, it } from 'vitest';
import { matchStatementToAccount } from '../src/core/accounts/match';
import { StatementProduct } from '../src/core/model/statement';

/**
 * Importar una cartola correcta a la cuenta equivocada.
 *
 * Es el error más caro que puede cometer este addon: los movimientos son
 * válidos, la vista previa se ve perfecta, el dedupe no tiene con qué
 * detectarlo (las huellas van scoped por cuenta, así que en la cuenta errada
 * *son* nuevos) y el resultado es una cuenta contaminada y otra vacía.
 *
 * Hasta 0.1.1 nada comparaba la cartola con la cuenta elegida.
 */

const cartola = (overrides: Partial<Parameters<typeof matchStatementToAccount>[0]> = {}) => ({
  number: '001234567890',
  product: StatementProduct.checking,
  currency: 'CLP',
  ...overrides,
});

const cuenta = (overrides: Partial<Parameters<typeof matchStatementToAccount>[1]> = {}) => ({
  accountNumber: '001234567890',
  accountType: 'CASH' as const,
  currency: 'CLP',
  ...overrides,
});

describe('coincidencia confirmada', () => {
  it('mismo número y misma moneda', () => {
    const match = matchStatementToAccount(cartola(), cuenta());
    expect(match.verdict).toBe('confirmed');
    expect(match.blocking).toBe(false);
  });

  it('acepta formatos distintos del mismo número', () => {
    const match = matchStatementToAccount(
      cartola({ number: '00-123-456789-0' }),
      cuenta({ accountNumber: '001234567890' }),
    );
    expect(match.verdict).toBe('confirmed');
  });

  it('acepta un número enmascarado cuando los últimos cuatro coinciden', () => {
    // Los estados de cuenta de tarjeta imprimen `XXXX-XXXX-XXXX-7788`.
    const match = matchStatementToAccount(
      cartola({ number: 'XXXXXXXXXXXX7788', product: StatementProduct.credit_card }),
      cuenta({ accountNumber: '4051223344557788', accountType: 'CREDIT_CARD' }),
    );
    expect(match.verdict).toBe('confirmed');
  });
});

describe('mismatch que bloquea', () => {
  it('números claramente distintos', () => {
    const match = matchStatementToAccount(
      cartola({ number: '001234567890' }),
      cuenta({ accountNumber: '009876543210' }),
    );
    expect(match.verdict).toBe('mismatch');
    expect(match.blocking).toBe(true);
    expect(match.reasons.join(' ')).toMatch(/número/i);
  });

  it('monedas distintas', () => {
    // Escribir movimientos en CLP en una cuenta en USD no es un detalle
    // cosmético: los montos quedan en la moneda equivocada.
    const match = matchStatementToAccount(
      cartola({ currency: 'CLP' }),
      cuenta({ currency: 'USD' }),
    );
    expect(match.verdict).toBe('mismatch');
    expect(match.blocking).toBe(true);
  });

  it('una cartola bancaria en una cuenta de instrumentos', () => {
    const match = matchStatementToAccount(cartola(), cuenta({ accountType: 'SECURITIES' }));
    expect(match.verdict).toBe('mismatch');
    expect(match.blocking).toBe(true);
  });

  it('no enmascara el número en el mensaje más de lo necesario', () => {
    const match = matchStatementToAccount(
      cartola({ number: '001234567890' }),
      cuenta({ accountNumber: '009876543210' }),
    );
    // Ni el número de la cartola ni el de la cuenta aparecen completos.
    expect(match.reasons.join(' ')).not.toContain('001234567890');
    expect(match.reasons.join(' ')).not.toContain('009876543210');
  });
});

describe('compatible pero no verificable', () => {
  it('la cartola no trae número', () => {
    const match = matchStatementToAccount(
      { product: StatementProduct.checking, currency: 'CLP' },
      cuenta(),
    );
    expect(match.verdict).toBe('compatible');
    expect(match.blocking).toBe(false);
    expect(match.unverified).toContain('numero-cuenta');
  });

  it('la cuenta de Wealthfolio no tiene número registrado', () => {
    const match = matchStatementToAccount(cartola(), {
      accountType: 'CASH',
      currency: 'CLP',
    });
    expect(match.verdict).toBe('compatible');
    expect(match.blocking).toBe(false);
    expect(match.unverified).toContain('numero-cuenta');
  });

  it('un estado de cuenta de tarjeta en una cuenta CASH avisa pero no bloquea', () => {
    // Mucha gente modela su tarjeta como cuenta de efectivo. Avisar sí;
    // impedirlo sería decidir por ellos cómo llevar su contabilidad.
    const match = matchStatementToAccount(
      { product: StatementProduct.credit_card, currency: 'CLP' },
      { accountType: 'CASH', currency: 'CLP' },
    );
    expect(match.blocking).toBe(false);
    expect(match.reasons.join(' ')).toMatch(/tarjeta/i);
  });

  it('con menos de cuatro dígitos comparables no declara coincidencia', () => {
    const match = matchStatementToAccount(
      cartola({ number: '12' }),
      cuenta({ accountNumber: '34' }),
    );
    expect(match.verdict).toBe('compatible');
    expect(match.unverified).toContain('numero-cuenta');
  });
});
