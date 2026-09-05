import { Confidence, Direction } from '../model/kinds';
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
 * Order is specific before generic, and it is load-bearing twice:
 *
 * - `COMISION AVANCE EXTRANJERO` is a cash-advance fee that also contains the
 *   idea of "abroad"; the advance reading has to win.
 * - `COMISION` alone is last, so it only fires when no apellido was found.
 */
const PATTERNS: readonly Pattern[] = [
  // ── Intereses ──────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.late_interest,
    pattern: /\bINTERES(?:ES)?\s+(?:POR\s+)?MORA\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.late_interest,
    pattern: /\bINTERES(?:ES)?\s+MORATORIOS?\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.installment_interest,
    pattern: /\bINTERES(?:ES)?\s+(?:POR\s+)?(?:COMPRAS?\s+EN\s+)?CUOTAS?\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.revolving_interest,
    pattern: /\bINTERES(?:ES)?\s+(?:ROTATIVOS?|ADICIONALES?|ADICIONAL|REFUNDIDOS?)\b/,
    confidence: Confidence.confirmed,
  },

  // ── Comisiones ─────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.cash_advance_fee,
    pattern: /\bCOMISION(?:ES)?\s+(?:DE\s+|POR\s+)?AVANCE\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.international_purchase,
    pattern:
      /\bCOMISION(?:ES)?\s+(?:DE\s+|POR\s+)?(?:COMPRAS?\s+)?(?:INTERNACIONAL(?:ES)?|EN\s+EL\s+EXTRANJERO|MONEDA\s+EXTRANJERA)\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.maintenance,
    pattern:
      /\bCOMISION(?:ES)?\s+(?:DE\s+|POR\s+)?(?:MANTENCION|MANTENIMIENTO|ADMINISTRACION)\b/,
    confidence: Confidence.confirmed,
  },
  {
    // The other way round: some statements name the product, not the comisión.
    kind: FinancialCostKind.maintenance,
    pattern: /\b(?:MANTENCION|MANTENIMIENTO)\s+(?:DE\s+)?(?:TARJETA|CUENTA|LINEA)\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.collection,
    pattern: /\bGASTOS?\s+(?:DE\s+)?COBRANZA\b/,
    confidence: Confidence.confirmed,
  },

  // ── Impuesto ───────────────────────────────────────────────────────────
  {
    kind: FinancialCostKind.credit_tax,
    pattern: /\bIMPUESTO\s+(?:AL?\s+)?CREDITO\b/,
    confidence: Confidence.confirmed,
  },
  {
    kind: FinancialCostKind.credit_tax,
    pattern: /\bTIMBRES\b/,
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

  const mayCorrect =
    reading.confidence === Confidence.confirmed &&
    transaction.direction === Direction.out &&
    transaction.kindConfidence !== Confidence.confirmed;

  if (!mayCorrect) return { ...transaction, financialCost };

  return {
    ...transaction,
    financialCost,
    kind: transactionKindForCost(reading.kind),
    kindConfidence: Confidence.confirmed,
  };
}
