import { toNumber, type Money } from '../money';
import { Confidence, TransactionKind, type Direction } from '../model/kinds';
import type { EnrichedTransaction, NormalizedTransaction } from '../model/transaction';
import { normalizeMerchant } from '../merchants/normalize';
import { foldCase } from '../text';

/**
 * The rule engine.
 *
 * Conceptually the same shape as Actual Budget's and Firefly III's rules —
 * conditions plus actions, evaluated in a fixed order — because that model has
 * proven itself and because a user who has used either will already know how to
 * think about it. The implementation is our own.
 *
 * Two properties are non-negotiable:
 *
 * 1. **Deterministic.** Same transactions plus same rules always produce the
 *    same output, so the preview the user approved is exactly what gets
 *    imported.
 * 2. **Auditable.** Every transaction records which rules fired, so "why is
 *    this a restaurant?" always has an answer.
 */

export type ConditionField =
  | 'description'
  | 'merchant'
  | 'amount'
  | 'absAmount'
  | 'account'
  | 'institution'
  | 'kind'
  | 'direction'
  | 'category'
  | 'operationType';

export type ConditionOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between';

export interface RuleCondition {
  field: ConditionField;
  operator: ConditionOperator;
  /** Comparison operand. `between` uses `[min, max]`. */
  value: string | number | [number, number];
}

export type RuleActionType =
  | 'set_category'
  | 'set_merchant'
  | 'set_kind'
  | 'add_tag'
  | 'mark_transfer'
  | 'ignore';

export interface RuleAction {
  type: RuleActionType;
  value?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** Lower runs first. Ties broken by id, so ordering is total and stable. */
  priority: number;
  /** All conditions must hold (`and`) or any of them (`or`). */
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  /**
   * Stop evaluating further rules once this one fires. Lets a specific rule
   * shield a transaction from a broader one without reordering everything.
   */
  stopProcessing?: boolean;
  /** `builtin` rules ship with the addon; `user` rules are editable. */
  origin: 'builtin' | 'user';
}

/** Context a rule is evaluated against. */
export interface RuleContext {
  accountId: string;
  accountName?: string;
}

export interface RuleOutcome {
  transaction: EnrichedTransaction;
  /** True when a rule asked for the row to be excluded from the import. */
  ignored: boolean;
}

/**
 * Apply the rule set to one transaction.
 *
 * Merchant normalisation runs first so rules can match on the cleaned name
 * rather than on raw acquirer noise.
 */
export function applyRules(
  transaction: NormalizedTransaction,
  rules: readonly Rule[],
  context: RuleContext,
): RuleOutcome {
  const merchantResult = normalizeMerchant(transaction.description);

  let current: EnrichedTransaction = {
    ...transaction,
    ...(merchantResult.merchant !== undefined ? { merchant: merchantResult.merchant } : {}),
    ...(merchantResult.processor !== undefined
      ? { paymentProcessor: merchantResult.processor }
      : {}),
    tags: [...transaction.tags],
    appliedRules: [],
  };

  let ignored = false;

  for (const rule of sortRules(rules)) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, current, context)) continue;

    current = { ...current, appliedRules: [...current.appliedRules, rule.id] };

    for (const action of rule.actions) {
      switch (action.type) {
        case 'set_category':
          if (action.value) current = { ...current, category: action.value };
          break;
        case 'set_merchant':
          if (action.value) current = { ...current, merchant: action.value };
          break;
        case 'set_kind':
          if (action.value && isTransactionKind(action.value)) {
            current = {
              ...current,
              kind: action.value,
              kindConfidence: Confidence.confirmed,
            };
          }
          break;
        case 'add_tag':
          if (action.value && !current.tags.includes(action.value)) {
            current = { ...current, tags: [...current.tags, action.value] };
          }
          break;
        case 'mark_transfer':
          current = {
            ...current,
            kind: TransactionKind.internal_transfer,
            kindConfidence: Confidence.suggested,
            transferCandidate: {
              confidence: Confidence.suggested,
              reason: `Marcada por la regla "${rule.name}".`,
            },
          };
          break;
        case 'ignore':
          ignored = true;
          break;
      }
    }

    if (rule.stopProcessing) break;
  }

  return { transaction: current, ignored };
}

/** Apply the rule set to a batch, preserving order. */
export function applyRulesToBatch(
  transactions: readonly NormalizedTransaction[],
  rules: readonly Rule[],
  context: RuleContext,
): RuleOutcome[] {
  const sorted = sortRules(rules);
  return transactions.map((transaction) => applyRules(transaction, sorted, context));
}

/** Total, stable ordering: priority, then id. */
export function sortRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function ruleMatches(
  rule: Rule,
  transaction: EnrichedTransaction,
  context: RuleContext,
): boolean {
  if (rule.conditions.length === 0) return false;
  const results = rule.conditions.map((condition) =>
    conditionMatches(condition, transaction, context),
  );
  return rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

function conditionMatches(
  condition: RuleCondition,
  transaction: EnrichedTransaction,
  context: RuleContext,
): boolean {
  const { field, operator, value } = condition;

  if (isNumericOperator(operator)) {
    const actual = numericField(field, transaction);
    if (actual === undefined) return false;
    return compareNumeric(actual, operator, value);
  }

  const actual = textField(field, transaction, context);
  if (actual === undefined) return false;
  return compareText(actual, operator, value);
}

function isNumericOperator(operator: ConditionOperator): boolean {
  return (
    operator === 'gt' ||
    operator === 'gte' ||
    operator === 'lt' ||
    operator === 'lte' ||
    operator === 'between'
  );
}

function numericField(field: ConditionField, transaction: EnrichedTransaction): number | undefined {
  if (field === 'amount') return toNumber(transaction.amount);
  if (field === 'absAmount') return Math.abs(toNumber(transaction.amount));
  return undefined;
}

function compareNumeric(
  actual: number,
  operator: ConditionOperator,
  value: RuleCondition['value'],
): boolean {
  if (operator === 'between') {
    if (!Array.isArray(value)) return false;
    const [min, max] = value;
    return actual >= min && actual <= max;
  }
  const operand = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(operand)) return false;
  switch (operator) {
    case 'gt':
      return actual > operand;
    case 'gte':
      return actual >= operand;
    case 'lt':
      return actual < operand;
    case 'lte':
      return actual <= operand;
    default:
      return false;
  }
}

function textField(
  field: ConditionField,
  transaction: EnrichedTransaction,
  context: RuleContext,
): string | undefined {
  switch (field) {
    case 'description':
      return transaction.normalizedDescription;
    case 'merchant':
      return transaction.merchant ?? '';
    case 'account':
      return context.accountName ?? context.accountId;
    case 'institution':
      return transaction.sourceInstitution;
    case 'kind':
      return transaction.kind;
    case 'direction':
      return transaction.direction satisfies Direction;
    case 'category':
      return transaction.category ?? '';
    case 'operationType':
      return transaction.operationType ?? '';
    default:
      return undefined;
  }
}

function compareText(
  actual: string,
  operator: ConditionOperator,
  value: RuleCondition['value'],
): boolean {
  const needle = foldCase(String(value));
  const haystack = foldCase(actual);

  switch (operator) {
    case 'contains':
      return haystack.includes(needle);
    case 'not_contains':
      return !haystack.includes(needle);
    case 'equals':
      return haystack === needle;
    case 'not_equals':
      return haystack !== needle;
    case 'starts_with':
      return haystack.startsWith(needle);
    case 'ends_with':
      return haystack.endsWith(needle);
    case 'matches':
      return safeRegexTest(String(value), actual);
    default:
      return false;
  }
}

/**
 * User-supplied patterns are compiled defensively: a bad regex disables its own
 * rule instead of breaking the whole import.
 */
function safeRegexTest(pattern: string, actual: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(actual);
  } catch {
    return false;
  }
}

function isTransactionKind(value: string): value is TransactionKind {
  return Object.values(TransactionKind).includes(value as TransactionKind);
}

/** Amount helper used by rule builders in the UI. */
export function amountToNumber(amount: Money): number {
  return toNumber(amount);
}
