import { parseStatementDate, type DateFieldOrder, type IsoDate } from '../dates';
import { abs, parseAmount, type Money, type NumberFormatHint } from '../money';
import {
  declared,
  type BillingPeriod,
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
 * So the label is searched for across the whole preamble and no profile ever
 * says "the pago mínimo is in row 4, column C". The label comes from the
 * regulation; the position would have to come from a real cartola, and there
 * is not one yet. A profile that found nothing is not a broken profile — it is
 * a profile whose labels have not been checked against a real file, which is
 * exactly what `pnpm calibrate` reports.
 *
 * Everything produced here is `declared`. Nothing in this file computes a
 * figure from the rows: a billed amount added up from what we managed to parse
 * would carry the authority of something the issuer printed while silently
 * omitting whatever we did not read.
 *
 * What is deliberately not read: holder name, RUT, card number, address. A
 * statement carries all four, the addon needs none, and not modelling them is
 * the cheapest way not to leak them.
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
 * Between a label and its figure: a colon, spaces, currency sign, filler.
 *
 * Bounded at 40 characters so a label cannot reach across a whole line and
 * claim a number that belongs to the next field — the same bound
 * `readDeclaredBalances` uses, for the same reason.
 */
const GAP = String.raw`[^\d(+-]{0,40}`;
// The currency sign can sit inside the parenthesis — `($1.087.100)` — so it is
// part of what the pattern accepts rather than something the gap has to skip.
const AMOUNT = String.raw`([(+-]?\s*\$?\s*[\d.,]+\s*\)?-?)`;
const DATE = String.raw`(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})`;

/**
 * Amount labels, most specific first.
 *
 * Specificity matters where one label contains another: `CUPO DISPONIBLE` and
 * `CUPO TOTAL` share a word, and `TOTAL A PAGAR` sits near `PAGO MINIMO` on
 * every layout the reglamento describes. Each key is searched independently, so
 * the order inside a key is between synonyms, not between fields.
 */
const AMOUNT_LABELS: Array<[keyof CreditCardStatementFacts, RegExp[]]> = [
  [
    'minimumPayment',
    [
      new RegExp(String.raw`\bPAGO\s+MINIMO\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\bMONTO\s+MINIMO(?:\s+A\s+PAGAR)?\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'billedAmount',
    [
      new RegExp(String.raw`\bTOTAL\s+A\s+PAGAR\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\bMONTO\s+(?:TOTAL\s+)?FACTURADO\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'totalDebt',
    [
      new RegExp(String.raw`\bSALDO\s+ADEUDADO\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\bDEUDA\s+TOTAL\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'domesticDebt',
    [
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+NACIONAL\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+EN\s+PESOS\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'foreignDebt',
    [
      new RegExp(
        String.raw`\b(?:DEUDA|SALDO)\s+(?:EN\s+)?MONEDA\s+EXTRANJERA\b${GAP}${AMOUNT}`,
        'i',
      ),
      new RegExp(String.raw`\b(?:DEUDA|SALDO)\s+INTERNACIONAL\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'creditLimit',
    [
      new RegExp(String.raw`\bCUPO\s+TOTAL\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\bLINEA\s+DE\s+CREDITO\s+AUTORIZADA\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
  [
    'availableCredit',
    [
      new RegExp(String.raw`\bCUPO\s+DISPONIBLE\b${GAP}${AMOUNT}`, 'i'),
      new RegExp(String.raw`\bMONTO\s+DISPONIBLE\b${GAP}${AMOUNT}`, 'i'),
    ],
  ],
];

const DATE_LABELS: Array<[keyof CreditCardStatementFacts, RegExp[]]> = [
  [
    'statementDate',
    [
      new RegExp(String.raw`\bFECHA\s+(?:DEL\s+)?ESTADO\s+DE\s+CUENTA\b${GAP}${DATE}`, 'i'),
      new RegExp(String.raw`\bFECHA\s+DE\s+EMISION\b${GAP}${DATE}`, 'i'),
    ],
  ],
  [
    'dueDate',
    [
      new RegExp(String.raw`\bPAGAR\s+HASTA\b${GAP}${DATE}`, 'i'),
      new RegExp(String.raw`\bFECHA\s+(?:DE\s+)?VENCIMIENTO\b${GAP}${DATE}`, 'i'),
      new RegExp(String.raw`\bFECHA\s+(?:DE\s+)?PAGO\b${GAP}${DATE}`, 'i'),
    ],
  ],
];

const PERIOD_LABELS: RegExp[] = [
  new RegExp(
    String.raw`\bPERIODO\s+DE\s+FACTURACION\b${GAP}${DATE}[^\d]{1,10}${DATE}`,
    'i',
  ),
  new RegExp(String.raw`\bPERIODO\s+FACTURADO\b${GAP}${DATE}[^\d]{1,10}${DATE}`, 'i'),
];

export function readCardFacts(input: ReadCardFactsInput): CreditCardStatementFacts {
  const text = foldForLabels(input.preamble);
  const facts: CreditCardStatementFacts = {};

  for (const [key, patterns] of AMOUNT_LABELS) {
    const amount = firstAmount(patterns, text, input);
    if (amount) {
      // `where` is left off: the preamble is one region, and claiming to know
      // which part of it a figure came from would be provenance we do not have.
      Object.assign(facts, { [key]: declared(amount) });
    }
  }

  for (const [key, patterns] of DATE_LABELS) {
    const date = firstDate(patterns, text, input.dateOrder);
    if (date) Object.assign(facts, { [key]: declared(date) });
  }

  const period = firstPeriod(text, input.dateOrder);
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

function firstAmount(
  patterns: readonly RegExp[],
  text: string,
  input: ReadCardFactsInput,
): Money | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    try {
      const parsed = parseAmount(match[1], {
        currency: input.currency,
        ...(input.numberFormat ? { format: input.numberFormat } : {}),
      }).money;
      // A magnitude, not a signed balance. Unlike `SALDO ANTERIOR $450.000` on
      // a card — which may be debt or credit, and which the parser refuses to
      // read for exactly that reason — a pago mínimo or a cupo means the same
      // thing whichever sign the issuer printed beside it.
      return abs(parsed);
    } catch {
      // A label with something unreadable next to it is not an error worth
      // raising: the preamble is where stray text next to a figure is routine.
      continue;
    }
  }
  return undefined;
}

function firstDate(
  patterns: readonly RegExp[],
  text: string,
  order: DateFieldOrder | undefined,
): IsoDate | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = readDate(match[1], order);
    if (parsed) return parsed;
  }
  return undefined;
}

function firstPeriod(
  text: string,
  order: DateFieldOrder | undefined,
): BillingPeriod | undefined {
  for (const pattern of PERIOD_LABELS) {
    const match = pattern.exec(text);
    if (!match?.[1] || !match[2]) continue;
    const from = readDate(match[1], order);
    const to = readDate(match[2], order);
    // Both halves or neither: a period with one end is not a period, and
    // guessing the other from a cycle length would be inventing the cycle.
    if (from && to && from <= to) return { from, to };
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
