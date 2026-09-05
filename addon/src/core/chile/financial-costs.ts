import { Confidence, Direction, NON_SPENDING_KINDS } from '../model/kinds';
import { FinancialCostKind, transactionKindForCost } from '../model/financial-cost';
import type { FinancialCostInfo, NormalizedTransaction } from '../model/transaction';

/**
 * Which financial cost a description names, if any.
 *
 * Takes the *normalised* description (`core/text::normalizeDescription`), the
 * same form every other matcher compares against, so a rule and this agree
 * about what the text says.
 *
 * Two rules govern every pattern below, and both come from the same mistake
 * RC3 had to fix in `core/rules/builtin.ts`:
 *
 * 1. **Never a bare substring for a short word.** `MORA` sits inside `MORANDE`,
 *    a street full of restaurants in downtown Santiago, and inside a bakery
 *    called `LA MORA`. Every marker here is matched with word boundaries.
 * 2. **A family word alone is not a cost.** `MANTENCION` on its own is as
 *    likely to be a lift-maintenance company as the card's monthly comisión,
 *    and `INTERESES` on its own is interest *earned* as often as charged. Those
 *    need a second word before they mean anything — the noun that says whose
 *    cost it is.
 *
 * The one deliberate exception is `COMISION` standing alone, which returns
 * `other`. A comisión is always a charge for the instrument: unlike interés it
 * has no earned direction, so the family word alone already carries the fact
 * that this is a cost. Which cost it is stays unanswered rather than guessed.
 */
export interface FinancialCostReading {
  kind: FinancialCostKind;
  /**
   * `confirmed` when the glosa named the specific cost; `suggested` when it
   * only named the family. Only the first is allowed to override a
   * classification the pipeline already made.
   */
  confidence: Confidence;
  /** The exact text that named it, so the review UI can show the evidence. */
  matchedText: string;
}

interface Pattern {
  kind: FinancialCostKind;
  pattern: RegExp;
  confidence: Confidence;
}

/**
 * Word separator, matching what `normalizeDescription` actually leaves behind.
 *
 * The normaliser keeps `.`, `-`, `/` and `*` on purpose — they carry cuota
 * counters and card tails — so a pattern that only accepts whitespace does not
 * see `COMISION-MANTENCION` or `IMPUESTO.AL.CREDITO`, which is how a statement
 * derived from a fixed-width export comes out. Those rows fell through to the
 * bare `COMISION` arm, or to nothing at all.
 */
const S = String.raw`[\s./-]+`;

/** Build a pattern from words, joined by whatever separator the glosa used. */
function phrase(...words: string[]): RegExp {
  return new RegExp(String.raw`\b${words.join(S)}\b`);
}

/**
 * Order is specific before generic, and it is load-bearing twice:
 *
 * - `COMISION AVANCE EXTRANJERO` is a cash-advance fee that also contains the
 *   idea of "abroad"; the advance reading has to win.
 * - `COMISION` alone is last, so it only fires when no apellido was found.
 *
 * Several arms require a noun naming the product. `ADMINISTRACION` on its own
 * is the fee of a fondo mutuo, an APV or a building as often as a card's; the
 * comisión de administración of the reglamento is the one that says which.
 */
const PATTERNS: readonly Pattern[] = [
  // ── Intereses ──────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.late_interest,
    pattern: phrase('INTERES(?:ES)?', '(?:POR' + S + ')?MORA'),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.late_interest,
    pattern: phrase('INTERES(?:ES)?', 'MORATORIOS?'),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.installment_interest,
    pattern: phrase(
      'INTERES(?:ES)?',
      '(?:POR' + S + ')?(?:COMPRAS?' + S + 'EN' + S + ')?CUOTAS?',
    ),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.revolving_interest,
    pattern: phrase('INTERES(?:ES)?', '(?:ROTATIVOS?|ADICIONALES?|ADICIONAL|REFUNDIDOS?)'),
    confidence: Confidence.confirmed,
  },

  // ── Comisiones ─────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.cash_advance_fee,
    pattern: phrase('COMISION(?:ES)?', '(?:(?:DE|POR)' + S + ')?AVANCE'),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.international_purchase,
    pattern: phrase(
      'COMISION(?:ES)?',
      '(?:(?:DE|POR)' + S + ')?(?:COMPRAS?' + S + ')?(?:INTERNACIONAL(?:ES)?|EN' +
        S +
        'EL' +
        S +
        'EXTRANJERO|MONEDA' +
        S +
        'EXTRANJERA)',
    ),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.maintenance,
    pattern: phrase('COMISION(?:ES)?', '(?:(?:DE|POR)' + S + ')?(?:MANTENCION|MANTENIMIENTO)'),
    confidence: Confidence.confirmed,
  },
  {
    // `ADMINISTRACION` needs the product named. Without it, the arm caught the
    // management fee of a fondo mutuo and reported it as the card's mantención.
    kind: FinancialCostKind.maintenance,
    pattern: phrase(
      'COMISION(?:ES)?',
      '(?:(?:DE|POR)' + S + ')?ADMINISTRACION',
      '(?:DE' + S + ')?(?:TARJETA|CUENTA|LINEA' + S + 'DE' + S + 'CREDITO)',
    ),
    confidence: Confidence.confirmed,
  },
  {
    // The other way round: some statements name the product, not the comisión.
    // `LINEA` has to be `LINEA DE CREDITO` — a `MANTENCION LINEA TELEFONICA` is
    // a phone bill.
    kind: FinancialCostKind.maintenance,
    pattern: phrase(
      '(?:MANTENCION|MANTENIMIENTO)',
      '(?:DE' + S + ')?(?:TARJETA|CUENTA|LINEA' + S + 'DE' + S + 'CREDITO)',
    ),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.collection,
    pattern: phrase('GASTOS?', '(?:DE' + S + ')?COBRANZA'),
    confidence: Confidence.confirmed,
  },

  // ── Impuesto ───────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.credit_tax,
    pattern: phrase('IMPUESTO', '(?:AL?' + S + ')?CREDITO'),
    confidence: Confidence.confirmed,
  },
  {
    // Never `TIMBRES` alone: rubber-stamp printers are a real Chilean trade,
    // and `TIMBRES Y GOMAS` is a shop, not the DL 3.475.
    kind: FinancialCostKind.credit_tax,
    pattern: phrase('TIMBRES', 'Y', 'ESTAMPILLAS'),
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.credit_tax,
    pattern: phrase('(?:IMPUESTO|LEY)', '(?:DE' + S + ')?TIMBRES'),
    confidence: Confidence.confirmed,
  },

  // ── Familia sin apellido ───────────────────────────────────────────────
  {
    kind: FinancialCostKind.other,
    pattern: /\bCOMISION(?:ES)?\b/,
    confidence: Confidence.suggested,
  },
];

export function detectFinancialCost(
  normalizedDescription: string,
): FinancialCostReading | undefined {
  if (normalizedDescription === '') return undefined;

  for (const { kind, pattern, confidence } of PATTERNS) {
    const match = pattern.exec(normalizedDescription);
    if (match) {
      return { kind, confidence, matchedText: match[0] };
    }
  }
  return undefined;
}

/**
 * Annotate one movement with the financial cost its glosa names.
 *
 * Runs after the rule engine, and its authority is deliberately narrow:
 *
 * - it always records **what** the cost is, because that is new information
 *   nothing else in the pipeline produces;
 * - it corrects `kind` only when the glosa named the specific cost, the money
 *   is going out, and the classification the row arrived with was not
 *   confirmed. That last condition is what keeps a user's own rule — or a
 *   reading the glosa itself confirmed — from being quietly overruled by a
 *   pattern in this file.
 *
 * The case that made the correction worth having is `GASTOS DE COBRANZA`: no
 * built-in rule recognised it, so on a card statement it fell through to the
 * product default and was reported as a purchase, next to the supermarket.
 */
export function withFinancialCost<T extends NormalizedTransaction>(transaction: T): T {
  const reading = detectFinancialCost(transaction.normalizedDescription);
  if (!reading) return transaction;

  const financialCost: FinancialCostInfo = {
    kind: reading.kind,
    confidence: reading.confidence,
    matchedText: reading.matchedText,
  };

  // `mark_transfer` leaves `internal_transfer` at `suggested`, not `confirmed`,
  // so confidence alone did not protect it: a cost reading rewrote the row to
  // `fee` and pulled the amount into gross spending, which is the exact
  // double-count the transfer mark exists to prevent.
  const mayCorrect =
    reading.confidence === Confidence.confirmed &&
    transaction.direction === Direction.out &&
    transaction.kindConfidence !== Confidence.confirmed &&
    !NON_SPENDING_KINDS.has(transaction.kind) &&
    transaction.transferCandidate === undefined;

  if (!mayCorrect) return { ...transaction, financialCost };

  return {
    ...transaction,
    financialCost,
    kind: transactionKindForCost(reading.kind),
    kindConfidence: Confidence.confirmed,
  };
}
