/**
 * Exact money arithmetic for the import pipeline.
 *
 * Financial amounts are never held as floating point decimals. A `Money` is an
 * integer count of minor units plus the scale that count is expressed in, so
 * `{ minor: 123456, scale: 2, currency: 'CLP' }` is exactly $1.234,56 and
 * `{ minor: 1234, scale: 0, currency: 'CLP' }` is exactly $1.234.
 *
 * Scale is carried per-value rather than per-currency because Chilean bank
 * files are inconsistent: the same CLP account exports "1.234" in one report
 * and "1.234,00" in another. Keeping the observed scale means a round trip
 * through the parser never invents or discards precision.
 */

export interface Money {
  /** Signed integer count of minor units at `scale`. */
  readonly minor: number;
  /** Number of decimal places `minor` is expressed in (0..MAX_SCALE). */
  readonly scale: number;
  /** ISO 4217 code, or a Chilean pseudo-currency such as `UF` (Unidad de Fomento). */
  readonly currency: string;
}

export const MAX_SCALE = 6;

/** Largest integer that still round-trips exactly through a JS number. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** How to read `.` and `,` when both meanings are possible. */
export type NumberFormatHint =
  /** Chilean/European convention: `.` groups thousands, `,` is the decimal mark. */
  | 'es-CL'
  /** US convention: `,` groups thousands, `.` is the decimal mark. */
  | 'en-US'
  /** Infer per value; the right-most separator is treated as the decimal mark. */
  | 'auto';

export interface ParseAmountOptions {
  currency: string;
  format?: NumberFormatHint;
  /**
   * Treat a trailing `CR`/`ABONO` (or `D`/`CARGO`) marker as the sign carrier.
   * Some statements express direction in a separate column instead.
   */
  allowDebitCreditSuffix?: boolean;
}

export interface ParseAmountResult {
  money: Money;
  /**
   * True when the separator layout admitted more than one reading and the
   * format hint had to break the tie (e.g. "1,500" under `auto`). Callers
   * should surface this as an import warning rather than silently trusting it.
   */
  ambiguous: boolean;
  /**
   * The cell carried its own direction marker, so the profile's `amountSign`
   * must not be applied on top of it.
   *
   * Without this the credit half of the feature did nothing: `80.000 CR` had
   * its marker stripped, stayed positive, and was then negated by every
   * `debit-positive` profile — every card statement — turning a payment into a
   * purchase of the same size. Only the debit markers were ever reaching the
   * sign, which is why the gap went unnoticed: on those profiles the marker and
   * the default happened to agree.
   */
  explicitSign?: 'debit' | 'credit';
}

export function money(minor: number, scale: number, currency: string): Money {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`minor must be an integer, got ${minor}`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new MoneyError(`scale must be an integer in 0..${MAX_SCALE}, got ${scale}`);
  }
  if (!currency) throw new MoneyError('currency is required');
  return { minor, scale, currency: currency.toUpperCase() };
}

export function zero(currency: string, scale = 0): Money {
  return money(0, scale, currency);
}

export function isZero(m: Money): boolean {
  return m.minor === 0;
}

export function negate(m: Money): Money {
  return { minor: -m.minor, scale: m.scale, currency: m.currency };
}

export function abs(m: Money): Money {
  return m.minor < 0 ? negate(m) : m;
}

/** Sign of the amount: -1, 0 or 1. */
export function sign(m: Money): -1 | 0 | 1 {
  return m.minor === 0 ? 0 : m.minor < 0 ? -1 : 1;
}

/** Re-express `m` at `scale`. Widening is exact; narrowing is refused if lossy. */
export function rescale(m: Money, scale: number): Money {
  if (scale === m.scale) return m;
  if (scale > MAX_SCALE || scale < 0) {
    throw new MoneyError(`cannot rescale to ${scale}`);
  }
  if (scale > m.scale) {
    const factor = 10 ** (scale - m.scale);
    const next = m.minor * factor;
    if (!Number.isSafeInteger(next)) {
      throw new MoneyError(`rescaling ${m.minor} to scale ${scale} overflows`);
    }
    return money(next, scale, m.currency);
  }
  const factor = 10 ** (m.scale - scale);
  if (m.minor % factor !== 0) {
    throw new MoneyError(`rescaling ${toDecimalString(m)} to scale ${scale} would lose precision`);
  }
  return money(m.minor / factor, scale, m.currency);
}

function alignedPair(a: Money, b: Money): [Money, Money] {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  const scale = Math.max(a.scale, b.scale);
  return [rescale(a, scale), rescale(b, scale)];
}

export function add(a: Money, b: Money): Money {
  const [x, y] = alignedPair(a, b);
  const total = x.minor + y.minor;
  if (!Number.isSafeInteger(total)) throw new MoneyError('addition overflows');
  return money(total, x.scale, x.currency);
}

export function subtract(a: Money, b: Money): Money {
  return add(a, negate(b));
}

export function sum(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

/** Compare two amounts of the same currency. Returns -1, 0 or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const [x, y] = alignedPair(a, b);
  return x.minor === y.minor ? 0 : x.minor < y.minor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && compare(a, b) === 0;
}

/**
 * Multiply by an integer count. Used for installment plans (`cuota × n`), never
 * for rates — rate arithmetic belongs to the FX layer, which is out of scope
 * for the deterministic import engine.
 */
export function multiplyInt(m: Money, factor: number): Money {
  if (!Number.isInteger(factor)) throw new MoneyError(`factor must be an integer, got ${factor}`);
  const next = m.minor * factor;
  if (!Number.isSafeInteger(next)) throw new MoneyError('multiplication overflows');
  return money(next, m.scale, m.currency);
}

/** Plain decimal string with `.` as the decimal mark — the wire format. */
/**
 * The one spelling of an amount that two exports of the same movement share.
 *
 * `toDecimalString` encodes the scale, and the scale is a property of how the
 * bank formatted the cell, not of the money: `1.234` and `1.234,00` parse to
 * different scales and print as `1234` and `1234.00`. Anything that uses the
 * decimal text as an *identity* — a fingerprint, a bucket key, a projection
 * hash — has to strip that difference or the same movement gets two identities.
 *
 * Only trailing zeros go; a real fraction is real value and stays.
 */
export function canonicalAmountString(amount: Money): string {
  const text = toDecimalString(amount);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function toDecimalString(m: Money): string {
  const negative = m.minor < 0;
  const digits = Math.abs(m.minor).toString().padStart(m.scale + 1, '0');
  const cut = digits.length - m.scale;
  const whole = digits.slice(0, cut);
  const frac = digits.slice(cut);
  const body = m.scale === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

/** Approximate float value. For display and charting only — never for equality. */
export function toNumber(m: Money): number {
  return m.minor / 10 ** m.scale;
}

/** es-CL presentation, e.g. `$1.234.567` or `$1.234,56`. */
export function formatCLP(m: Money, opts: { withSymbol?: boolean } = {}): string {
  const { withSymbol = true } = opts;
  const negative = m.minor < 0;
  const digits = Math.abs(m.minor).toString().padStart(m.scale + 1, '0');
  const cut = digits.length - m.scale;
  const whole = digits.slice(0, cut).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = digits.slice(cut);
  const body = m.scale === 0 ? whole : `${whole},${frac}`;
  const symbol = withSymbol ? (m.currency === 'CLP' ? '$' : `${m.currency} `) : '';
  return `${negative ? '-' : ''}${symbol}${body}`;
}

const CURRENCY_NOISE = /(?:CLP|CLF|USD|EUR|UF|UTM|\$|US\$|€)/gi;

/**
 * Parse a raw amount cell into exact `Money`.
 *
 * Handles the shapes actually seen in Chilean statement exports: `1.234.567`,
 * `-1.234,56`, `$ 1.234`, `(1.234)` for negatives, `1.234,56 CR`, and US-style
 * `1,234.56` from tools that re-export with an English locale.
 */
export function parseAmount(raw: string, options: ParseAmountOptions): ParseAmountResult {
  const { currency, format = 'es-CL', allowDebitCreditSuffix = false } = options;
  let text = String(raw ?? '')
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .trim();
  if (text === '') throw new MoneyError('empty amount');

  let negative = false;

  // Parenthesised negatives: (1.234) === -1.234
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  let explicitSign: 'debit' | 'credit' | undefined;
  if (allowDebitCreditSuffix) {
    const suffix = text.match(/\b(CR|CREDITO|CRÉDITO|ABONO|D|DB|DEBITO|DÉBITO|CARGO)\s*$/i);
    if (suffix?.[1]) {
      const marker = suffix[1].toUpperCase();
      const debit =
        marker === 'D' ||
        marker === 'DB' ||
        marker.startsWith('DEB') ||
        marker.startsWith('DÉB') ||
        marker === 'CARGO';
      explicitSign = debit ? 'debit' : 'credit';
      if (debit) negative = true;
      text = text.slice(0, suffix.index).trim();
    }
  }

  text = text.replace(CURRENCY_NOISE, '').trim();

  // Sign can lead or trail: "-1.234" and "1.234-" both appear in the wild.
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }

  text = text.replace(/\s/g, '');
  if (text === '') throw new MoneyError(`amount has no digits: ${String(raw)}`);
  if (!/^[\d.,]+$/.test(text)) {
    throw new MoneyError(`amount contains unexpected characters: ${String(raw)}`);
  }

  const { integerPart, fractionPart, ambiguous } = splitDecimal(text, format);

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionPart)) {
    throw new MoneyError(`malformed amount: ${String(raw)}`);
  }
  if (fractionPart.length > MAX_SCALE) {
    throw new MoneyError(`amount has more than ${MAX_SCALE} decimals: ${String(raw)}`);
  }

  const digits = `${integerPart || '0'}${fractionPart}`;
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude) || magnitude > MAX_SAFE) {
    throw new MoneyError(`amount is too large to represent exactly: ${String(raw)}`);
  }

  return {
    money: money(negative ? -magnitude : magnitude, fractionPart.length, currency),
    ambiguous,
    ...(explicitSign ? { explicitSign } : {}),
  };
}

interface DecimalSplit {
  integerPart: string;
  fractionPart: string;
  ambiguous: boolean;
}

function splitDecimal(text: string, format: NumberFormatHint): DecimalSplit {
  const dots = countOf(text, '.');
  const commas = countOf(text, ',');

  if (dots === 0 && commas === 0) {
    return { integerPart: text, fractionPart: '', ambiguous: false };
  }

  // Both separators present: the right-most one is the decimal mark, the other
  // groups thousands. This reading is unambiguous regardless of locale.
  if (dots > 0 && commas > 0) {
    const decimalMark = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    return splitAt(text, decimalMark, false);
  }

  const mark = dots > 0 ? '.' : ',';
  const occurrences = dots > 0 ? dots : commas;
  const tail = text.slice(text.lastIndexOf(mark) + 1);

  // Repeated separators can only be thousands grouping: 1.234.567. But that is
  // a claim about the *shape*, and it was never checked — `12.345.6` came back
  // as `123456`, ten times the number, with `ambiguous: false` and no throw. A
  // truncated or malformed cell became a plausible figure instead of a failed
  // row, which is the one thing the import gate needs it not to do.
  if (occurrences > 1) {
    const groups = text.split(mark);
    const wellFormed =
      (groups[0] ?? '').length >= 1 &&
      (groups[0] ?? '').length <= 3 &&
      groups.slice(1).every((group) => group.length === 3);
    if (!wellFormed) {
      throw new MoneyError(`amount has malformed thousands grouping: ${text}`);
    }
    return { integerPart: groups.join(''), fractionPart: '', ambiguous: false };
  }

  // A single separator with a group of exactly three digits after it is the
  // genuinely ambiguous case: "1.500" is 1500 in es-CL and 1.5 in en-US.
  if (tail.length === 3) {
    if (format === 'es-CL') {
      return mark === '.'
        ? { integerPart: text.split('.').join(''), fractionPart: '', ambiguous: false }
        : splitAt(text, ',', true);
    }
    if (format === 'en-US') {
      return mark === ','
        ? { integerPart: text.split(',').join(''), fractionPart: '', ambiguous: false }
        : splitAt(text, '.', true);
    }
    // 'auto' has no locale to lean on; grouping is the safer default because
    // treating 1.500 as 1.5 understates an amount by three orders of magnitude.
    return { integerPart: text.split(mark).join(''), fractionPart: '', ambiguous: true };
  }

  // Any other tail length (1, 2, 4+ digits) can only be a decimal fraction.
  return splitAt(text, mark, false);
}

function splitAt(text: string, mark: string, ambiguous: boolean): DecimalSplit {
  const at = text.lastIndexOf(mark);
  const head = text.slice(0, at);
  const tail = text.slice(at + 1);
  const other = mark === '.' ? ',' : '.';
  return {
    integerPart: head.split(other).join('').split(mark).join(''),
    fractionPart: tail,
    ambiguous,
  };
}

function countOf(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}
