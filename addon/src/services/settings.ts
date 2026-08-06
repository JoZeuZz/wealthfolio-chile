import type { AddonContext } from '@wealthfolio/addon-sdk';
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

export interface ChileSettings {
  /** Default currency proposed in the wizard. */
  defaultCurrency: string;
  /** Emit extra diagnostics. Still redacted — see `core/privacy`. */
  verboseLogging: boolean;
  /** Auto-apply transfer matches the engine is confident about. */
  autoApplyConfirmedTransfers: boolean;
  /** Days either side to search for the other leg of a transfer. */
  transferWindowDays: number;
  /** Ids of built-in rules the user has switched off. */
  disabledBuiltinRules: string[];
}

export const DEFAULT_SETTINGS: ChileSettings = {
  defaultCurrency: 'CLP',
  verboseLogging: false,
  autoApplyConfirmedTransfers: false,
  transferWindowDays: 5,
  disabledBuiltinRules: [],
};

export async function loadSettings(store: KeyValueStore): Promise<ChileSettings> {
  const stored = await readJson<Partial<ChileSettings>>(store, StorageKeys.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
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

export function settingsStore(ctx: AddonContext): KeyValueStore {
  return ctx.api.storage;
}
