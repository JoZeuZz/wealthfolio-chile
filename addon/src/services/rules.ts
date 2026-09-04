import {
  applyRulesToBatch,
  type ConditionField,
  type ConditionOperator,
  type Rule,
  type RuleAction,
  type RuleActionType,
  type RuleCondition,
  type RuleContext,
} from '../core/rules/engine';
import type { NormalizedTransaction } from '../core/model/transaction';
import { readJson, writeJson, StorageError, StorageKeys, type KeyValueStore } from './storage';

/**
 * User-authored rules: what a screen may ask the engine to do, and what
 * survives a round trip through storage.
 *
 * The engine can do more than this module lets anyone ask for, and that is the
 * point. A rule rewrites how a movement is understood, and some rewrites are a
 * label while others are accounting.
 */

/**
 * How much a rule action can change about the money.
 *
 * - `safe` — changes a label. The amount, the direction, the kind and whether
 *   the row is imported all stay exactly as they were, so the worst outcome is
 *   a movement filed under the wrong heading.
 * - `review-required` — leaves a movement out of the import. Recoverable (the
 *   row is still in the file and re-importing brings it back) and visible in
 *   the preview before it happens, but it is an omission from the ledger.
 * - `dangerous` — changes the classification, and with it the Wealthfolio
 *   activity type: whether the host counts the movement as spending, as
 *   income, or as nothing at all. `set_kind` turns an expense into a transfer;
 *   `mark_transfer` does the same and adds a counterpart claim.
 *
 * The built-in rules use the dangerous ones, because each of those was written
 * against a specific Chilean wording, argued for in `core/classify` or
 * `docs/DECISIONS.md`, and covered by tests. A rule typed into a form has none
 * of that behind it.
 */
export type RuleRisk = 'safe' | 'review-required' | 'dangerous';

export function actionRisk(type: RuleActionType): RuleRisk {
  switch (type) {
    case 'set_category':
    case 'set_merchant':
    case 'add_tag':
      return 'safe';
    case 'ignore':
      return 'review-required';
    case 'set_kind':
    case 'mark_transfer':
      return 'dangerous';
  }
}

/** The actions a rule editor may offer. Everything that is not `dangerous`. */
export const EDITABLE_ACTIONS: readonly RuleActionType[] = [
  'set_category',
  'set_merchant',
  'add_tag',
  'ignore',
];

/**
 * Condition fields a rule editor may offer, in the order they read best.
 *
 * `product` and `operationType` are deliberately absent even though the engine
 * evaluates both. Neither survives into a movement rebuilt from a Wealthfolio
 * activity — the statement's product is not stored and the bank's own label is
 * not in the metadata — so the preview, which runs over exactly those rebuilt
 * movements, would answer "no cambiaría ninguno" for a rule that then fires on
 * every row of the next import. An unpreviewable condition is worse than a
 * missing one: it is the preview promising the opposite of what happens.
 *
 * The engine keeps both, because the built-in card rules need `product`.
 */
export const EDITABLE_FIELDS: readonly ConditionField[] = [
  'description',
  'merchant',
  'absAmount',
  'amount',
  'direction',
  'institution',
];

const TEXT_OPERATORS: readonly ConditionOperator[] = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'starts_with',
  'ends_with',
  'matches',
];

const NUMERIC_OPERATORS: readonly ConditionOperator[] = ['gt', 'gte', 'lt', 'lte', 'between'];

/** Operators that make sense for a field. Numeric fields take both kinds. */
export function operatorsFor(field: ConditionField): readonly ConditionOperator[] {
  return field === 'amount' || field === 'absAmount' ? NUMERIC_OPERATORS : TEXT_OPERATORS;
}

/** Schema version of the stored rule set. Bump when the shape changes. */
export const RULES_SCHEMA_VERSION = 1;

/**
 * The one priority a user rule may have: after every built-in.
 *
 * The built-ins occupy 10 to 110 and three of them cut the evaluation short.
 * That ordering is the safety model — parser, then the audited rules that
 * decide what a movement *is*, then the user's labels — so the priority is not
 * something a rule carries, it is something the tier is.
 */
export const USER_RULE_PRIORITY = 500;

/** Id namespace the shipped rules live in. Off limits to a user rule. */
const BUILTIN_ID_PREFIX = 'builtin.';

/**
 * Longest pattern a `matches` condition may hold.
 *
 * Not a security boundary — the pattern is the user's own — but the editor runs
 * it on every keystroke to compute the preview, so an unbounded one turns
 * typing into an unbounded amount of work in the same tab that is being typed
 * in. No Chilean glosa needs 200 characters of pattern to be recognised.
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * A quantifier applied to a group that already contains one.
 *
 * `(a+)+`, `(x*)*`, `(\d{2,}){3,}` — the classic catastrophic-backtracking
 * shapes. Against a description that *almost* matches, these take exponential
 * time, and the preview runs them synchronously while the user is still
 * typing: the tab stops responding halfway through writing the rule, with
 * nothing on screen to say why.
 *
 * A heuristic, not a decision procedure. It rejects some patterns that would
 * have been fine — `(FARMACIA|BOTICA)+` is deliberately not one of them, since
 * the group holds no quantifier — and that trade is right for a field whose
 * job is matching a bank's wording.
 *
 * The `?:` is matched rather than skipped. The first version excluded every
 * `(?…` group to leave lookarounds alone, and took non-capturing groups out
 * with them: `(?:[A-Z]+)+$` was accepted, and against a 37-character glosa it
 * does not finish. A lookaround still slips past, because `?=` and `?!` are not
 * `?:`.
 */
const NESTED_QUANTIFIER =
  /\((?:\?:)?[^()]*(?:[+*]|\{\d+,\d*\})[^()]*\)\s*(?:[+*]|\{\d+,\d*\})/;

interface StoredRules {
  v: number;
  rules: unknown[];
}

export interface RuleValidation {
  /** Empty when the rule is safe to store and to run. */
  errors: string[];
}

/**
 * Whether a rule may be stored as a user rule.
 *
 * Run on the way in *and* on the way out. Storage replicates across a user's
 * paired devices and can have been written by another version, so a rule this
 * screen could never produce must not become one this screen runs.
 */
export function validateUserRule(rule: Rule): RuleValidation {
  const errors: string[] = [];

  if (rule.name.trim() === '') errors.push('La regla necesita un nombre.');
  if (rule.id.startsWith(BUILTIN_ID_PREFIX)) {
    // `loadEffectiveRules` drops the built-in whose id a user rule repeats, to
    // implement "edit this built-in". No screen offers that, so an id in this
    // namespace can only *delete* an audited rule — while its switch still
    // reads as on.
    errors.push('El identificador de una regla predefinida no puede usarse para una regla propia.');
  }
  if (rule.conditions.length === 0) {
    errors.push('La regla necesita al menos una condición; si no, se aplicaría a todo.');
  }
  if (rule.actions.length === 0) {
    errors.push('La regla necesita al menos una acción; si no, no haría nada.');
  }

  for (const action of rule.actions) {
    if (actionRisk(action.type) === 'dangerous') {
      errors.push(
        `«${action.type}» cambia la interpretación financiera del movimiento y no se puede configurar desde aquí.`,
      );
      continue;
    }
    if (action.type !== 'ignore' && (action.value ?? '').trim() === '') {
      errors.push(`La acción «${action.type}» necesita un valor.`);
    }
  }

  for (const condition of rule.conditions) {
    errors.push(...conditionErrors(condition));
  }

  return { errors };
}

function conditionErrors(condition: RuleCondition): string[] {
  const { operator, value } = condition;

  if (operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      return ['Un rango necesita un mínimo y un máximo.'];
    }
    const [min, max] = value;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ['El rango tiene que ser numérico.'];
    return min > max ? ['El rango está invertido: el mínimo es mayor que el máximo.'] : [];
  }

  if (NUMERIC_OPERATORS.includes(operator)) {
    return Number.isFinite(Number(value)) ? [] : ['La comparación numérica necesita un número.'];
  }

  if (String(value).trim() === '') return ['La condición necesita un valor con el que comparar.'];

  if (operator === 'matches') {
    const pattern = String(value);
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return [`La expresión regular es demasiado larga (máximo ${MAX_PATTERN_LENGTH} caracteres).`];
    }
    if (NESTED_QUANTIFIER.test(pattern)) {
      return [
        'La expresión regular repite un grupo que ya se repite por dentro. Sobre una glosa larga puede tardar minutos, así que no se acepta; escribe el patrón sin cuantificadores anidados.',
      ];
    }
    try {
      // The engine swallows a bad pattern on purpose, so one broken rule cannot
      // take an import down with it. In an editor that is the opposite of
      // helpful: the rule would save, look fine and never fire.
      new RegExp(pattern, 'i');
    } catch {
      return ['La expresión regular no es válida.'];
    }
  }

  return [];
}

/**
 * The user's own rules.
 *
 * Reads both shapes: the versioned envelope this writes, and the bare array
 * `0.2.0-rc.1` declared (and, having shipped no editor, never actually wrote —
 * but a key nothing writes is exactly the one nobody checks).
 *
 * Anything unreadable is an empty rule set rather than a thrown error: losing
 * rules is recoverable, refusing to open the addon is not. Anything readable
 * is rebuilt field by field, so a key written by a newer version travels no
 * further than this function.
 */
export async function loadUserRules(store: KeyValueStore): Promise<Rule[]> {
  const raw = await readJson<unknown>(store, StorageKeys.rules, []);
  // A blob from a later version is not read with this version's rules. Its
  // actions may carry their operands somewhere this loader does not look, and
  // reading it here produced an empty rule set that looked like "you have no
  // rules" — one click away from writing that emptiness back over both devices.
  if (isStoredRules(raw) && storedVersion(raw) > RULES_SCHEMA_VERSION) return [];

  const list = Array.isArray(raw)
    ? raw
    : isStoredRules(raw)
      ? raw.rules
      : [];

  const out: Rule[] = [];
  for (const entry of list) {
    const rule = normalizeRule(entry);
    if (rule && validateUserRule(rule).errors.length === 0) out.push(rule);
  }
  return dedupeById(out);
}

/**
 * One rule per id, the last one winning.
 *
 * An id is how a rule is edited and how it is deleted, so two rules sharing one
 * make both operations a coin toss: `map(r => r.id === id ? next : r)` rewrites
 * both, and `filter(r => r.id !== id)` removes both. Saving is the write, so
 * the later entry is the more recent intent.
 */
function dedupeById(rules: readonly Rule[]): Rule[] {
  const byId = new Map<string, Rule>();
  for (const rule of rules) byId.set(rule.id, rule);
  // Insertion order of a Map follows first insertion, which keeps the order the
  // user arranged even when a later duplicate replaced the contents.
  return [...byId.values()];
}

/**
 * An id no existing rule is using.
 *
 * `Date.now()` alone collides: creating a rule, saving it and creating another
 * inside the same millisecond — which two clicks on a fast machine manage —
 * produced one id for both, and the second silently replaced the first.
 */
export function newRuleId(existing: readonly Rule[]): string {
  const taken = new Set(existing.map((rule) => rule.id));
  const stamp = Date.now().toString(36);
  for (let suffix = 0; ; suffix += 1) {
    const id = suffix === 0 ? `user.${stamp}` : `user.${stamp}-${suffix.toString(36)}`;
    if (!taken.has(id)) return id;
  }
}

export async function saveUserRules(store: KeyValueStore, rules: readonly Rule[]): Promise<void> {
  const existing = await readJson<unknown>(store, StorageKeys.rules, []);
  if (isStoredRules(existing) && storedVersion(existing) > RULES_SCHEMA_VERSION) {
    throw new StorageError(
      'Tus reglas las guardó una versión más reciente de Wealthfolio Chile. No se sobreescriben desde aquí; actualiza el addon en este dispositivo.',
    );
  }

  await writeJson(store, StorageKeys.rules, {
    v: RULES_SCHEMA_VERSION,
    rules: dedupeById(
      rules.map((rule) => normalizeRule(rule)).filter((rule): rule is Rule => rule !== undefined),
    ),
  } satisfies StoredRules);
}

/** Version an envelope declares. Absent means the first one, which had none. */
function storedVersion(value: StoredRules): number {
  return typeof value.v === 'number' && Number.isFinite(value.v) ? value.v : 1;
}

function isStoredRules(value: unknown): value is StoredRules {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as StoredRules).rules)
  );
}

/**
 * Rebuild a rule from whatever the store held, field by field.
 *
 * Spreading the stored object would carry a key from another version into the
 * running rule and onward into the next write — the same trap `loadSettings`
 * documents. `origin` is forced rather than read: a rule that lives in the
 * user's key is a user rule, whatever it claims, and letting it claim
 * `builtin` would let it pose as one of the audited ones in the UI.
 */
function normalizeRule(value: unknown): Rule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id === '') return undefined;

  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions.map(normalizeCondition).filter((c): c is RuleCondition => c !== undefined)
    : [];
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(normalizeAction).filter((a): a is RuleAction => a !== undefined)
    : [];

  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    enabled: raw.enabled !== false,
    // Forced, like `origin`, and for a sharper reason. These two fields are how
    // a rule made only of *safe* actions disarms a dangerous built-in: priority
    // 1 plus `stopProcessing` breaks the loop before
    // `builtin.transferencia-propia` runs, and a traspaso between the holder's
    // own accounts goes back to counting as spending. No risky action is
    // involved, so the action gate never sees it. The screen can only produce
    // `USER_RULE_PRIORITY` and no cut, so that is all that is read back.
    priority: USER_RULE_PRIORITY,
    match: raw.match === 'all' ? 'all' : 'any',
    conditions,
    actions,
    origin: 'user',
  };
}

function normalizeCondition(value: unknown): RuleCondition | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.field !== 'string' || typeof raw.operator !== 'string') return undefined;
  const operand = raw.value;
  const valid =
    typeof operand === 'string' ||
    typeof operand === 'number' ||
    (Array.isArray(operand) &&
      operand.length === 2 &&
      operand.every((n) => typeof n === 'number'));
  if (!valid) return undefined;

  return {
    field: raw.field as ConditionField,
    operator: raw.operator as ConditionOperator,
    value: operand as RuleCondition['value'],
  };
}

function normalizeAction(value: unknown): RuleAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== 'string') return undefined;
  return {
    type: raw.type as RuleActionType,
    ...(typeof raw.value === 'string' ? { value: raw.value } : {}),
  };
}

export interface RulePreviewSample {
  date: string;
  description: string;
  /** Signed minor units and scale, so the caller formats it as money. */
  amount: NormalizedTransaction['amount'];
  /** What changes about this row. One short phrase per change. */
  effects: string[];
}

export interface RulePreview {
  /** Movements the preview ran over. */
  evaluated: number;
  /** Movements the candidate rule actually fired on. */
  matched: number;
  /** Movements whose outcome is different because of it. */
  changed: number;
  /** Of those, movements that would be left out of an import entirely. */
  ignored: number;
  samples: RulePreviewSample[];
}

const MAX_SAMPLES = 5;

/**
 * What a rule would do, before it is saved.
 *
 * Counts *changes*, not matches. A rule can match a hundred rows and change
 * none of them, because a higher-priority rule already set the same category or
 * because one with `stopProcessing` never lets the evaluation get this far.
 * Reporting matches would promise an effect that is not going to happen, which
 * is precisely the surprise the preview exists to prevent.
 *
 * Runs the whole rule set twice — without the candidate and with it — rather
 * than testing the candidate alone, because that interaction is the thing worth
 * seeing. Deterministic and local: it reads movements already in memory and
 * writes nothing.
 */
export function previewRuleImpact(
  candidate: Rule,
  existing: readonly Rule[],
  transactions: readonly NormalizedTransaction[],
  context: RuleContext,
): RulePreview {
  // Editing a rule means saving another with the same id, so the candidate
  // replaces its previous self. Otherwise the "after" set holds both versions
  // and the comparison never moves.
  const before = existing.filter((rule) => rule.id !== candidate.id);
  const after = [...before, candidate];

  const outcomesBefore = applyRulesToBatch(transactions, before, context);
  const outcomesAfter = applyRulesToBatch(transactions, after, context);

  let matched = 0;
  let changed = 0;
  let ignored = 0;
  const samples: RulePreviewSample[] = [];

  for (let index = 0; index < transactions.length; index += 1) {
    const previous = outcomesBefore[index];
    const next = outcomesAfter[index];
    if (!previous || !next) continue;

    if (!next.transaction.appliedRules.includes(candidate.id)) continue;
    matched += 1;

    const effects = describeEffects(previous, next);
    if (effects.length === 0) continue;

    changed += 1;
    if (next.ignored && !previous.ignored) ignored += 1;

    if (samples.length < MAX_SAMPLES) {
      const transaction = transactions[index] as NormalizedTransaction;
      samples.push({
        date: transaction.date,
        description: transaction.description,
        amount: transaction.amount,
        effects,
      });
    }
  }

  return { evaluated: transactions.length, matched, changed, ignored, samples };
}

type Outcome = ReturnType<typeof applyRulesToBatch>[number];

function describeEffects(previous: Outcome, next: Outcome): string[] {
  const effects: string[] = [];
  const a = previous.transaction;
  const b = next.transaction;

  if (a.category !== b.category) {
    effects.push(`categoría ${a.category ?? 'sin asignar'} → ${b.category ?? 'sin asignar'}`);
  }
  if (a.merchant !== b.merchant) {
    effects.push(`comercio ${a.merchant ?? 'sin asignar'} → ${b.merchant ?? 'sin asignar'}`);
  }
  const newTags = b.tags.filter((tag) => !a.tags.includes(tag));
  if (newTags.length > 0) effects.push(`etiqueta ${newTags.join(', ')}`);
  if (next.ignored && !previous.ignored) effects.push('queda fuera de la importación');

  return effects;
}
