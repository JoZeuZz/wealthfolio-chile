import { parseStatementDate, type DateFieldOrder, type IsoDate } from '../dates';
import { abs, parseAmount, type Money, type NumberFormatHint } from '../money';
import {
  declared,
  type BillingPeriod,
  type CardFactKey,
  type CreditCardStatementFacts,
} from '../model/statement-facts';

/**
 * Read a card statement's own assertions out of its preamble.
 *
 * **By label, never by position.** What is documented is what each figure is
 * *called*: article 26 of the reglamento fixes the wording — "TOTAL A PAGAR",
 * "PAGAR HASTA", "Pago Mínimo", "Cupo Disponible", "Período de Facturación" —
 * and the CMF's own page lists the same concepts for the regime in force. What
 * is not documented anywhere public is where any of them sits in a statement a
 * Chilean bank issues today.
 *
 * So the label is what is searched for, and no profile ever says "the pago
 * mínimo is in row 4, column C". The label comes from the regulation; the
 * position would have to come from a real cartola, and there is not one yet. A
 * profile that finds nothing is not broken — it is a profile whose labels have
 * not met a real file, and that is what `pnpm calibrate` reports.
 *
 * ## Why this file is stricter than a parser normally is
 *
 * These figures are the ones a person acts on: what is owed, what the minimum
 * is, when it is due, how much cupo is left. A wrong one is not a cosmetic
 * defect — it is a number that looks right and is not. So the trade is made
 * explicitly and always in the same direction:
 *
 *     a missing fact  <  a wrong fact
 *
 * `minimumPayment: undefined` costs the user a line in the preview.
 * `minimumPayment: $12.345` read off their RUT costs them a decision.
 *
 * Four rules follow from that, each one written after a case that got through.
 *
 * **One line at a time.** A label reaches only across its own line. Searching
 * the whole preamble let a label alone on its line reach the first number of
 * the next one, which on a cartola is the holder's RUT; and on a statement
 * exported to Excel — labels in one row, values in the next — every label
 * claimed the first value, so the cupo total was reported as the cupo
 * disponible and the user believed three million were free. Neither is fixable
 * with a better pattern: nothing this parser can see connects those two rows,
 * and a real cartola is what would say how they line up.
 *
 * **A number is not a figure.** The day of a date and a count of cuotas are
 * both numbers next to a label, and both produced a `declared` fact of `$5` and
 * `$12`. Worse, a `[\d.,]+` pattern matched a lone full stop and `parseAmount`
 * reads that as zero, so the warning every Chilean card statement must print —
 * "Si usted paga solo el pago mínimo, su deuda tardará más en extinguirse." —
 * yielded a pago mínimo of $0. Zero and `declared` were the two things this
 * model most promised never to invent.
 *
 * **An identifier is never money.** A RUT, a card tail, an account number and a
 * phone number are all runs of digits. A line carrying one is not read.
 *
 * **Agreement or nothing.** A label can appear twice — the previous cycle's
 * minimum payment is a standard line, and the tear-off stub repeats the total —
 * and taking the first match reported last month's figure as this month's. Two
 * readings that disagree mean the labels are not specific enough for this
 * statement, which is a thing to fix against a real cartola, not to resolve by
 * picking one.
 *
 * Everything produced here is `declared`. Nothing computes a figure from the
 * rows: a billed amount added up from what we managed to parse would carry the
 * authority of something the issuer printed while omitting what we did not
 * read.
 *
 * Not read at all: holder name, RUT, card number, address. The addon needs
 * none of the four, and not modelling them is the cheapest way not to leak
 * them.
 */

export interface ReadCardFactsInput {
  /** Text of the rows above the movement header, newline-joined. */
  preamble: string;
  currency: string;
  numberFormat?: NumberFormatHint;
  /** Field order for ambiguous numeric dates. Chilean statements are DMY. */
  dateOrder?: DateFieldOrder;
}

/**
 * Between a label and its figure: a colon, spaces, a currency sign, filler.
 *
 * No newline, and short. The bound is what stops a label reaching across a
 * sentence to a number that belongs to something else.
 */
const GAP = String.raw`[^\d\n(+-]{0,24}`;

/**
 * What a figure looks like on a statement.
 *
 * Deliberately demanding, and validated again in {@link parseFigure}: a bare
 * `5` or `12` beside a label is the day of a date or a count of cuotas far more
 * often than it is money.
 */
const AMOUNT = String.raw`(\(?\s*-?\s*\$?\s*\d[\d.,]*)\s*\)?`;
const DATE = String.raw`(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})`;

/**
 * Lines that carry an identifier, and are therefore not read for money.
 *
 * A RUT is the one that mattered — it sat one line below a bare `Cupo Total`
 * and was read as a cupo of twelve million — but a card tail and a long account
 * number are the same shape of mistake waiting to happen.
 */
const IDENTIFIER_LINE = [
  // RUT, with or without the dots: 12.345.678-9, 12345678-9.
  /\b\d{1,3}(?:\.\d{3})+\s*-\s*[\dkK]\b|\b\d{7,8}\s*-\s*[\dkK]\b/,
  /\bRUT\b|\bR\.U\.T\b/i,
  // Card number, masked or not.
  /\b(?:\d{4}[\s-]?){3}\d{4}\b|[*xX]{4}[\s-]?[*xX]{4}/,
  /\bTARJETA\s+N|\bN[°º]?\s*(?:DE\s+)?TARJETA\b/i,
  // Account number and phone.
  /\bCUENTA\s+N|\bN[°º]?\s*(?:DE\s+)?CUENTA\b/i,
  /\b\+?56\s?9\s?\d{4}\s?\d{4}\b/,
];

/** Currency markers that say a figure is not in the statement's own currency. */
const FOREIGN_CURRENCY: Array<[RegExp, string]> = [
  [/\bUS\s*\$|\bUSD\b|\bD[OÓ]LARES?\b/i, 'USD'],
  [/\bEUR\b|\bEUROS?\b|€/i, 'EUR'],
];

interface AmountSpec {
  key: CardFactKey;
  patterns: RegExp[];
  /**
   * Whether the sign carries no meaning for this field.
   *
   * A pago mínimo and a cupo total mean the same thing whichever sign the
   * issuer printed beside them, so those are stored as magnitudes. The other
   * three do not: a negative cupo disponible is a cupo that has been exceeded,
   * and a negative total a pagar is money in the holder's favour after
   * overpaying. Erasing those signs reported an overdraft as headroom and a
   * credit as a debt.
   */
  magnitude?: true;
  /** The fact exists only if the line says which currency it is in. */
  requiresForeignCurrency?: true;
}

/**
 * The labels, and what each one is allowed to mean.
 *
 * Synonyms only where the reglamento or the CMF uses both wordings for the same
 * concept. `TOTAL A PAGAR` and `SALDO ADEUDADO` are not synonyms — one is this
 * cycle, the other is the whole debt — and convenience is not a reason to merge
 * them. Where we do not know, the fact is simply absent.
 */
const AMOUNT_LABELS: readonly AmountSpec[] = [
  {
    key: 'minimumPayment',
    magnitude: true,
    patterns: [
      // `PAGO MINIMO PERIODO ANTERIOR` is last month's, a standard line.
      new RegExp(String.raw`\bPAGO\s+MINIMO\b(?!\s+(?:PERIODO|ANTERIOR))${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\bMONTO\s+MINIMO(?:\s+A\s+PAGAR)?\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'billedAmount',
    patterns: [
      new RegExp(String.raw`\bTOTAL\s+A\s+PAGAR\b${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\bMONTO\s+(?:TOTAL\s+)?FACTURADO\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'totalDebt',
    patterns: [
      new RegExp(String.raw`\bSALDO\s+ADEUDADO\b${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\bDEUDA\s+TOTAL\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'domesticDebt',
    patterns: [
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+NACIONAL\b${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+EN\s+PESOS\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'foreignDebt',
    requiresForeignCurrency: true,
    patterns: [
      new RegExp(
        String.raw`\b(?:DEUDA|SALDO)\s+(?:EN\s+)?MONEDA\s+EXTRANJERA\b${GAP}${AMOUNT}`,
        'gi',
      ),
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+INTERNACIONAL\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'creditLimit',
    magnitude: true,
    patterns: [
      new RegExp(String.raw`\bCUPO\s+TOTAL\b${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\bLINEA\s+DE\s+CREDITO\s+AUTORIZADA\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
  {
    key: 'availableCredit',
    patterns: [
      new RegExp(String.raw`\bCUPO\s+DISPONIBLE\b${GAP}${AMOUNT}`, 'gi'),
      new RegExp(String.raw`\bMONTO\s+DISPONIBLE\b${GAP}${AMOUNT}`, 'gi'),
    ],
  },
];

/**
 * Date labels.
 *
 * `FECHA DE PAGO` is gone: on a card statement it names the payment already
 * received as readily as the one due, and a past date presented as the due date
 * is worse than no due date at all. `FECHA DE VENCIMIENTO` stays, minus the
 * ones that belong to something else — the desgravamen policy is a routine line
 * on a Chilean card statement and has a vencimiento of its own.
 */
const DATE_LABELS: ReadonlyArray<[CardFactKey, RegExp[]]> = [
  [
    'statementDate',
    [
      new RegExp(String.raw`\bFECHA\s+(?:DEL\s+)?ESTADO\s+DE\s+CUENTA\b${GAP}${DATE}`, 'gi'),
      new RegExp(String.raw`\bFECHA\s+DE\s+EMISION\b${GAP}${DATE}`, 'gi'),
    ],
  ],
  [
    'dueDate',
    [
      new RegExp(String.raw`\bPAGAR\s+HASTA\b${GAP}${DATE}`, 'gi'),
      new RegExp(
        String.raw`\bFECHA\s+(?:DE\s+)?VENCIMIENTO\b(?!\s*(?:DE\s+)?(?:POLIZA|SEGURO|CUOTA))${GAP}${DATE}`,
        'gi',
      ),
    ],
  ],
];

/** Lines whose date is one that already happened. */
const PAST_EVENT = /\b(?:ULTIMO|RECIBIDO|EFECTUADO|PAGADO|ANTERIOR)\b/i;

const PERIOD_LABELS: readonly RegExp[] = [
  new RegExp(String.raw`\bPERIODO\s+DE\s+FACTURACION\b${GAP}${DATE}[^\d\n]{1,10}${DATE}`, 'gi'),
  new RegExp(String.raw`\bPERIODO\s+FACTURADO\b${GAP}${DATE}[^\d\n]{1,10}${DATE}`, 'gi'),
];

export function readCardFacts(input: ReadCardFactsInput): CreditCardStatementFacts {
  const lines = foldForLabels(input.preamble).split('\n');
  const facts: CreditCardStatementFacts = {};

  for (const spec of AMOUNT_LABELS) {
    const amount = readAmountFact(spec, lines, input);
    // `where` is left off: the preamble is one region, and claiming to know
    // which part of it a figure came from would be provenance we do not have.
    if (amount) Object.assign(facts, { [spec.key]: declared(amount) });
  }

  for (const [key, patterns] of DATE_LABELS) {
    const date = readDateFact(patterns, lines, input.dateOrder);
    if (date) Object.assign(facts, { [key]: declared(date) });
  }

  const period = readPeriodFact(lines, input.dateOrder);
  if (period) facts.billingPeriod = declared(period);

  return facts;
}

/**
 * Accent-fold, so `Período de Facturación` matches the same pattern as
 * `PERIODO DE FACTURACION`. Case is handled by the `i` flag; nothing else about
 * the text is touched, because the figures still have to parse.
 */
function foldForLabels(text: string): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Every reading of a label across the preamble, and an answer only if they agree. */
function readAmountFact(
  spec: AmountSpec,
  lines: readonly string[],
  input: ReadCardFactsInput,
): Money | undefined {
  const found: Money[] = [];

  for (const line of lines) {
    if (IDENTIFIER_LINE.some((pattern) => pattern.test(line))) continue;

    const currency = lineCurrency(line, input.currency);
    // A foreign-currency debt whose line names no currency is not recorded: it
    // would be filed under the statement's own, and a US$450 debt written down
    // as $450 pesos is addable to the domestic one without any rate at all.
    if (spec.requiresForeignCurrency && currency === input.currency) continue;

    for (const pattern of spec.patterns) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        const money = parseFigure(match, line, currency, input.numberFormat);
        // A label whose figure will not parse does not send us looking further
        // along the line for a better one: the next number belongs to something
        // else. The label simply yielded nothing.
        if (money) found.push(spec.magnitude ? abs(money) : money);
      }
    }
  }

  const first = found[0];
  if (!first) return undefined;
  return found.every((m) => m.minor === first.minor && m.currency === first.currency)
    ? first
    : undefined;
}

/** The currency a line names, when it names one other than the statement's. */
function lineCurrency(line: string, fallback: string): string {
  for (const [pattern, code] of FOREIGN_CURRENCY) {
    if (pattern.test(line)) return code;
  }
  return fallback;
}

function parseFigure(
  match: RegExpExecArray,
  line: string,
  currency: string,
  format: NumberFormatHint | undefined,
): Money | undefined {
  const raw = match[1];
  if (!raw) return undefined;

  const digits = raw.replace(/\D/g, '');
  if (digits === '') return undefined;

  // The head of a date: `05/10/2026` after `CUPO DISPONIBLE al`.
  const rest = line.slice(match.index + match[0].length);
  if (/^\s*[/\-.]\s*\d/.test(rest)) return undefined;

  // A short bare run is a counter, not money: `EN 12 CUOTAS`, `al 05/10`. With
  // a thousands separator, a decimal comma or a currency sign it is a figure.
  const hasSeparator = /[.,]/.test(raw);
  const hasCurrencySign = raw.includes('$');
  if (digits.length < 4 && !hasSeparator && !hasCurrencySign) return undefined;

  // The pattern captures the opening parenthesis but not the closing one, so
  // the accounting negative is applied here rather than left to `parseAmount`.
  const negative = raw.includes('(') || raw.includes('-');
  const body = raw.replace(/[($\s-]/g, '');

  try {
    const parsed = parseAmount(body, {
      currency,
      ...(format ? { format } : {}),
    }).money;
    return negative ? { ...parsed, minor: -parsed.minor } : parsed;
  } catch {
    // A label with something unreadable beside it is not an issue worth
    // raising: the preamble is where stray text next to a number is routine.
    return undefined;
  }
}

function readDateFact(
  patterns: readonly RegExp[],
  lines: readonly string[],
  order: DateFieldOrder | undefined,
): IsoDate | undefined {
  const found: IsoDate[] = [];

  for (const line of lines) {
    if (PAST_EVENT.test(line)) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        const date = match[1] ? readDate(match[1], order) : undefined;
        if (date) found.push(date);
      }
    }
  }

  const first = found[0];
  if (!first) return undefined;
  return found.every((date) => date === first) ? first : undefined;
}

function readPeriodFact(
  lines: readonly string[],
  order: DateFieldOrder | undefined,
): BillingPeriod | undefined {
  for (const line of lines) {
    for (const pattern of PERIOD_LABELS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match?.[1] || !match[2]) continue;
      const from = readDate(match[1], order);
      const to = readDate(match[2], order);
      // Both halves or neither: a period with one end is not a period, and
      // deriving the other from a cycle length would be inventing the cycle.
      if (from && to && from <= to) return { from, to };
    }
  }
  return undefined;
}

function readDate(raw: string, order: DateFieldOrder | undefined): IsoDate | undefined {
  try {
    return parseStatementDate(raw, { order: order ?? 'DMY' }).date;
  } catch {
    return undefined;
  }
}
