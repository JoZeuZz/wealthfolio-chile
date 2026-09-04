import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  formatCLP,
  money,
  MoneyError,
  multiplyInt,
  negate,
  parseAmount,
  rescale,
  subtract,
  sum,
  toDecimalString,
  zero,
} from '../src/core/money';

describe('parseAmount — Chilean formats', () => {
  it('reads plain thousands grouping', () => {
    const { money: value } = parseAmount('1.234.567', { currency: 'CLP' });
    expect(value).toEqual({ minor: 1234567, scale: 0, currency: 'CLP' });
  });

  it('reads a decimal comma', () => {
    const { money: value } = parseAmount('1.234,56', { currency: 'CLP' });
    expect(toDecimalString(value)).toBe('1234.56');
    expect(value.scale).toBe(2);
  });

  it('reads a leading minus sign', () => {
    const { money: value } = parseAmount('-45.900', { currency: 'CLP' });
    expect(value.minor).toBe(-45900);
  });

  it('reads a trailing minus sign', () => {
    const { money: value } = parseAmount('45.900-', { currency: 'CLP' });
    expect(value.minor).toBe(-45900);
  });

  it('reads parenthesised negatives', () => {
    const { money: value } = parseAmount('(12.500)', { currency: 'CLP' });
    expect(value.minor).toBe(-12500);
  });

  it('strips currency symbols and non-breaking spaces', () => {
    const { money: value } = parseAmount('$ 1.500.000', { currency: 'CLP' });
    expect(value.minor).toBe(1500000);
  });

  it('reads US-style grouping when both separators are present', () => {
    const { money: value } = parseAmount('1,234.56', { currency: 'USD' });
    expect(toDecimalString(value)).toBe('1234.56');
  });

  it('treats a single dot with three digits as grouping under es-CL', () => {
    const { money: value, ambiguous } = parseAmount('1.500', { currency: 'CLP' });
    expect(value.minor).toBe(1500);
    expect(value.scale).toBe(0);
    expect(ambiguous).toBe(false);
  });

  it('treats a single comma with three digits as a decimal under es-CL', () => {
    const { money: value } = parseAmount('1,500', { currency: 'CLP', format: 'es-CL' });
    expect(toDecimalString(value)).toBe('1.500');
  });

  it('flags the ambiguous reading under auto and prefers grouping', () => {
    const { money: value, ambiguous } = parseAmount('1,500', { currency: 'CLP', format: 'auto' });
    expect(value.minor).toBe(1500);
    expect(ambiguous).toBe(true);
  });

  it('reads two-decimal amounts without grouping', () => {
    const { money: value } = parseAmount('45900,50', { currency: 'CLP' });
    expect(toDecimalString(value)).toBe('45900.50');
  });

  it('honours an explicit debit suffix', () => {
    const { money: value } = parseAmount('12.500 CARGO', {
      currency: 'CLP',
      allowDebitCreditSuffix: true,
    });
    expect(value.minor).toBe(-12500);
  });

  it('honours an explicit credit suffix', () => {
    const { money: value } = parseAmount('12.500 ABONO', {
      currency: 'CLP',
      allowDebitCreditSuffix: true,
    });
    expect(value.minor).toBe(12500);
  });

  it('rejects empty and non-numeric input', () => {
    expect(() => parseAmount('', { currency: 'CLP' })).toThrow(MoneyError);
    expect(() => parseAmount('sin monto', { currency: 'CLP' })).toThrow(MoneyError);
  });

  it('rejects amounts with more decimals than the model allows', () => {
    expect(() => parseAmount('1,1234567', { currency: 'CLP' })).toThrow(MoneyError);
  });
});

describe('exact arithmetic', () => {
  it('adds values of different scales without losing precision', () => {
    const a = money(1000, 0, 'CLP'); // $1.000
    const b = money(50, 2, 'CLP'); // $0,50
    expect(toDecimalString(add(a, b))).toBe('1000.50');
  });

  it('never introduces floating point error', () => {
    const tenCents = money(10, 2, 'USD');
    const total = sum(Array.from({ length: 3 }, () => tenCents), 'USD');
    expect(toDecimalString(total)).toBe('0.30');
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 0, 'CLP'), money(1, 0, 'USD'))).toThrow(MoneyError);
  });

  it('refuses a lossy rescale', () => {
    expect(() => rescale(money(1050, 2, 'CLP'), 0)).toThrow(MoneyError);
  });

  it('allows an exact narrowing rescale', () => {
    expect(rescale(money(1000, 2, 'CLP'), 0)).toEqual(money(10, 0, 'CLP'));
  });

  it('subtracts and compares consistently', () => {
    const a = money(45900, 0, 'CLP');
    const b = money(45900, 0, 'CLP');
    expect(subtract(a, b)).toEqual(zero('CLP'));
    expect(compare(a, b)).toBe(0);
    expect(compare(a, negate(b))).toBe(1);
  });

  it('multiplies by an installment count exactly', () => {
    const cuota = money(29990, 0, 'CLP');
    expect(multiplyInt(cuota, 6).minor).toBe(179940);
  });
});

describe('formatCLP', () => {
  it('formats whole pesos with dot grouping', () => {
    expect(formatCLP(money(1234567, 0, 'CLP'))).toBe('$1.234.567');
  });

  it('formats decimals with a comma', () => {
    expect(formatCLP(money(123456, 2, 'CLP'))).toBe('$1.234,56');
  });

  it('formats negatives with the sign before the symbol', () => {
    expect(formatCLP(money(-45900, 0, 'CLP'))).toBe('-$45.900');
  });

  it('prefixes other currencies with their code', () => {
    expect(formatCLP(money(1050, 2, 'USD'))).toBe('USD 10,50');
  });
});

/**
 * El marcador de signo tiene que llegar a quien decide el signo.
 *
 * `allowDebitCreditSuffix` reconocía `CR`/`ABONO` y luego no lo contaba: el
 * sufijo se recortaba, el valor quedaba positivo y `ParseAmountResult` no tenía
 * dónde decir que la fila venía marcada como abono. En un perfil
 * `debit-positive` —todas las tarjetas— `readAmount` negaba después todo lo que
 * recibía, así que un `PAGO RECIBIDO 80.000 CR` se guardaba como una compra de
 * 80.000: el mes se sobrestimaba en el doble del pago y la tarjeta nunca
 * aparecía pagada.
 */
describe('marcador explícito de cargo/abono', () => {
  it('un sufijo de abono se reporta como tal', () => {
    expect(
      parseAmount('80.000 CR', { currency: 'CLP', allowDebitCreditSuffix: true }).explicitSign,
    ).toBe('credit');
  });

  it('un sufijo de cargo se reporta como tal', () => {
    expect(
      parseAmount('12.500 CARGO', { currency: 'CLP', allowDebitCreditSuffix: true }).explicitSign,
    ).toBe('debit');
  });

  it('sin sufijo no hay marcador y el perfil sigue decidiendo', () => {
    expect(
      parseAmount('12.500', { currency: 'CLP', allowDebitCreditSuffix: true }).explicitSign,
    ).toBeUndefined();
  });

  it('el sufijo no se busca cuando el perfil no lo permite', () => {
    expect(() => parseAmount('80.000 CR', { currency: 'CLP' })).toThrow(MoneyError);
  });
});
