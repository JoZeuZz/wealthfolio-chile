/**
 * The deterministic financial engine.
 *
 * Everything under `core/` is pure TypeScript: no React, no DOM, no Wealthfolio
 * SDK calls (only type imports at the mapping boundary). That is deliberate —
 * it makes the engine unit-testable in Node, reusable from a future importer
 * service, and impossible to accidentally couple to a UI detail.
 */

export * from './money';
export * from './dates';
export * from './text';
export * from './hash';
export * from './privacy';

export * from './model';

export * from './parsing/tabular';
export * from './parsing/columns';
export * from './parsing/profile';
export * from './parsing/workbook';

export * from './providers/registry';

export * from './dedupe/fingerprint';
export * from './dedupe/classify';

export * from './reconcile/transfers';
export * from './reconcile/credit-card';

export * from './merchants/normalize';
export * from './categories/defaults';
export * from './rules/engine';
export * from './rules/builtin';

export * from './installments/detect';
export * from './installments/plans';

export * from './metrics/monthly';
export * from './insights/rules';

export * from './mapping/activities';

export * from './pipeline';
