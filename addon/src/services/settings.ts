import { defaultRules } from '../core/rules/builtin';
import type { Rule } from '../core/rules/engine';
import { readJson, StorageKeys, writeJson, type KeyValueStore } from './storage';

/**
 * Addon settings and the user's rule set.
 *
 * Built-in rules are merged in on every read rather than copied into storage
 * once: that way a new built-in rule shipped with an update reaches existing
 * users, while any rule the user has disabled or edited keeps their version.
 */

/**
 * Everything the addon lets a user change.
 *
 * Every field here is read by something. Three used to be here that were not:
 * `defaultCurrency` (the statement's own currency is evidence and overriding it
 * from a preference would be worse than useless), and
 * `autoApplyConfirmedTransfers`, which promised a feature that does not exist
 * and should not: applying a transfer match rewrites two activities and records
 * a counterpart in their metadata, and the matcher only just stopped choosing
 * between indistinguishable candidates. Deciding that automatically is not
 * something this addon has earned. The option is gone rather than defaulted to
 * off, because an option that is never safe to switch on is not an option.
 */
export interface ChileSettings {
  /** Emit extra diagnostics. Still redacted — see `core/privacy`. */
  verboseLogging: boolean;
  /** Days either side to search for the other leg of a transfer. */
  transferWindowDays: number;
  /** Ids of built-in rules the user has switched off. */
  disabledBuiltinRules: string[];
}

export const DEFAULT_SETTINGS: ChileSettings = {
  verboseLogging: false,
  transferWindowDays: 5,
  disabledBuiltinRules: [],
};

/**
 * Read the settings, keeping only fields this version knows.
 *
 * Spreading the stored blob over the defaults let a key written by an older
 * version survive into the object and travel onward, which is how a removed
 * option quietly stays alive.
 */
export async function loadSettings(store: KeyValueStore): Promise<ChileSettings> {
  const stored = await readJson<Partial<ChileSettings>>(store, StorageKeys.settings, {});
  return {
    verboseLogging: typeof stored.verboseLogging === 'boolean'
      ? stored.verboseLogging
      : DEFAULT_SETTINGS.verboseLogging,
    transferWindowDays:
      typeof stored.transferWindowDays === 'number' && stored.transferWindowDays > 0
        ? stored.transferWindowDays
        : DEFAULT_SETTINGS.transferWindowDays,
    disabledBuiltinRules: Array.isArray(stored.disabledBuiltinRules)
      ? stored.disabledBuiltinRules.filter((id): id is string => typeof id === 'string')
      : [...DEFAULT_SETTINGS.disabledBuiltinRules],
  };
}

export async function saveSettings(
  store: KeyValueStore,
  settings: ChileSettings,
): Promise<void> {
  await writeJson(store, StorageKeys.settings, settings);
}

/** User-authored rules only; built-ins are merged at read time. */
export async function loadUserRules(store: KeyValueStore): Promise<Rule[]> {
  return readJson<Rule[]>(store, StorageKeys.rules, []);
}

export async function saveUserRules(store: KeyValueStore, rules: Rule[]): Promise<void> {
  await writeJson(store, StorageKeys.rules, rules);
}

/**
 * The effective rule set: built-ins (minus the ones the user disabled) plus the
 * user's own, ordered by priority.
 */
export async function loadEffectiveRules(store: KeyValueStore): Promise<Rule[]> {
  const [settings, userRules] = await Promise.all([loadSettings(store), loadUserRules(store)]);
  const disabled = new Set(settings.disabledBuiltinRules);

  const builtins = defaultRules().map((rule) =>
    disabled.has(rule.id) ? { ...rule, enabled: false } : rule,
  );

  // A user rule with the same id as a built-in replaces it outright, which is
  // how "edit this built-in rule" is implemented without mutating the defaults.
  const overridden = new Set(userRules.map((rule) => rule.id));

  return [...builtins.filter((rule) => !overridden.has(rule.id)), ...userRules];
}
