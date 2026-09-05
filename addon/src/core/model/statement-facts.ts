import type { IsoDate } from '../dates';
import type { Money } from '../money';

/**
 * What a credit-card statement says about itself.
 *
 * A cartola de cuenta corriente is a list of movements and a running balance;
 * a card statement is a list of movements *plus a set of assertions about a
 * debt* — what was billed, what is the minimum, when it is due, how much of the
 * cupo is left. Those assertions are the part a person actually acts on, and
 * the model had nowhere to put them.
 *
 * **Which fields exist is settled.** The CMF lists thirteen elements a card
 * statement must show, and article 26 of the reglamento that takes effect in
 * 2028 spells each one out, down to the wording ("TOTAL A PAGAR", "PAGAR
 * HASTA", "Pago Mínimo", "Cupo Disponible").
 *
 * **Where each one sits in a statement a Chilean bank issues today is not.**
 * The regime in force is the DS 44/2012, whose text no public source serves in
 * a readable form, and no bank publishes a sample. So this file defines the
 * contract and asserts nothing about any bank's layout. Having the contract
 * ready is what makes the first real cartola immediately useful; inventing the
 * extractor would be declaring support for a format nobody verified.
 *
 * Deliberately absent: holder name, RUT, card number, address. A statement
 * carries all four and the addon needs none of them — see `docs/PRIVACY.md`.
 * Also absent: CAE, CAEP, CTC and the minimum-payment formula. Those are the
 * issuer's calculations; the addon reads what a statement declares and does not
 * become a regulatory calculator.
 */

/**
 * Where a fact came from, which decides what it is allowed to prove.
 *
 * The same distinction `BalanceSource` makes, for the same reason and with
 * higher stakes. A billed amount the issuer printed is the debt the issuer
 * acknowledges. One the addon added up from the rows it managed to read is an
 * estimate that silently omits whatever it did not read. Showing them
 * identically is the failure this type exists to prevent.
 */
export type FactSource = 'declared' | 'derived';

/**
 * Roughly where in the document a fact was found.
 *
 * Enough to tell a summary box from a running total when two disagree, and
 * deliberately not enough to reconstruct the document: no cell reference, no
 * raw text, no coordinates. Provenance, not a copy.
 */
export type FactLocation = 'summary' | 'header' | 'footer';

export interface StatementFact<T> {
  value: T;
  source: FactSource;
  where?: FactLocation;
}

/** A fact the document stated in so many words. */
export function declared<T>(value: T, where?: FactLocation): StatementFact<T> {
  return where === undefined ? { value, source: 'declared' } : { value, source: 'declared', where };
}

/** A fact computed from the rows. Never allowed to look like a declared one. */
export function derived<T>(value: T, where?: FactLocation): StatementFact<T> {
  return where === undefined ? { value, source: 'derived' } : { value, source: 'derived', where };
}

/** The billing period a statement covers, as the reglamento prints it. */
export interface BillingPeriod {
  from: IsoDate;
  to: IsoDate;
}

/**
 * The assertions a card statement makes.
 *
 * Every field is optional and an absent one means *the document did not say*.
 * It never means zero: `minimumPayment: 0` would claim nothing has to be paid
 * this month, which is a different statement from "we could not read it" and a
 * far more expensive one to be wrong about.
 */
export interface CreditCardStatementFacts {
  /** "Fecha del Estado de Cuenta" — when the statement was issued. */
  statementDate?: StatementFact<IsoDate>;
  /** "Período de Facturación" — the cycle, which is not a calendar month. */
  billingPeriod?: StatementFact<BillingPeriod>;
  /** "PAGAR HASTA" — the due date. */
  dueDate?: StatementFact<IsoDate>;
  /** "TOTAL A PAGAR" — what this cycle billed. */
  billedAmount?: StatementFact<Money>;
  /**
   * "Pago Mínimo" — always as declared by the statement, never computed.
   *
   * The CMF's NCG 537 does give a formula (`PM ≥ 100%·MNF + 5%·MF`), and it is
   * still the wrong thing to implement: it phases in over five stages between
   * 2026-06-04 and 2028-06-04, the issuer may waive it for up to two
   * consecutive months at its own discretion, and splitting MNF from MF needs
   * to know, line by line, whether each cuota carries interest — which the
   * detail does not always say. A computed minimum that disagreed with the
   * printed one would be worse than no minimum at all.
   */
  minimumPayment?: StatementFact<Money>;
  /** "Saldo adeudado" — the whole debt, not just this cycle. */
  totalDebt?: StatementFact<Money>;
  /** "Cupo Total". */
  creditLimit?: StatementFact<Money>;
  /** "Cupo Disponible". */
  availableCredit?: StatementFact<Money>;
  /**
   * Debt in pesos and debt in foreign currency, which the reglamento requires
   * to be broken out separately — and which cannot be added together without an
   * exchange rate the SDK does not publish a historical series for.
   */
  domesticDebt?: StatementFact<Money>;
  foreignDebt?: StatementFact<Money>;
}

export type CardFactKey = keyof CreditCardStatementFacts;

/**
 * Every fact, in the order a statement presents them.
 *
 * Ordered rather than alphabetical because the calibration report is read by a
 * person holding the cartola: dates, then what is owed, then what is left.
 */
export const CARD_FACT_KEYS: readonly CardFactKey[] = [
  'statementDate',
  'billingPeriod',
  'dueDate',
  'billedAmount',
  'minimumPayment',
  'totalDebt',
  'domesticDebt',
  'foreignDebt',
  'creditLimit',
  'availableCredit',
];

/** How a fact is named on screen and in the calibration report. */
export function cardFactLabel(key: CardFactKey): string {
  switch (key) {
    case 'statementDate':
      return 'Fecha del estado de cuenta';
    case 'billingPeriod':
      return 'Período de facturación';
    case 'dueDate':
      return 'Fecha de vencimiento';
    case 'billedAmount':
      return 'Monto facturado';
    case 'minimumPayment':
      return 'Pago mínimo';
    case 'totalDebt':
      return 'Deuda total';
    case 'domesticDebt':
      return 'Deuda nacional';
    case 'foreignDebt':
      return 'Deuda en moneda extranjera';
    case 'creditLimit':
      return 'Cupo total';
    case 'availableCredit':
      return 'Cupo disponible';
  }
}

/** One fact's presence, with no value attached. */
export interface FactPresence {
  key: CardFactKey;
  found: boolean;
  /** Only meaningful when found. */
  source?: FactSource;
}

/**
 * Which facts a statement yielded — and nothing about what they said.
 *
 * This is what the calibration report prints. A calibration report is pasted
 * into an issue and read over someone's shoulder, and a minimum payment is a
 * figure about a person's debt, so the report carries the question ("did the
 * profile find the pago mínimo?") and never the answer.
 */
export function factPresence(facts: CreditCardStatementFacts): FactPresence[] {
  return CARD_FACT_KEYS.map((key) => {
    const fact = facts[key];
    return fact === undefined
      ? { key, found: false }
      : { key, found: true, source: fact.source };
  });
}
