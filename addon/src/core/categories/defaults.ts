/**
 * The starting category tree.
 *
 * Seeded once into addon storage and editable from there — nothing in the
 * engine hardcodes a category id beyond these defaults, so renaming, adding or
 * deleting categories never requires a code change. The `system` flag only
 * marks the ones the built-in rules reference by id.
 */

export interface Category {
  id: string;
  label: string;
  /** Parent id, for the two-level tree the UI renders. */
  parent?: string;
  /** Roll-up bucket used by cash-flow reports. */
  group: CategoryGroup;
  /** Set on categories referenced by the built-in rules; blocks deletion. */
  system?: boolean;
}

export const CategoryGroup = {
  income: 'income',
  /** Recurring, hard to cut: rent, utilities, insurance, debt service. */
  fixed: 'fixed',
  /** Discretionary day-to-day spending. */
  variable: 'variable',
  savings: 'savings',
  /** Movements that must never reach an income/expense total. */
  neutral: 'neutral',
} as const;

export type CategoryGroup = (typeof CategoryGroup)[keyof typeof CategoryGroup];

export const DEFAULT_CATEGORIES: readonly Category[] = [
  // ── Ingresos ────────────────────────────────────────────────────────
  { id: 'ingresos', label: 'Ingresos', group: CategoryGroup.income, system: true },
  { id: 'ingresos.sueldo', label: 'Sueldo', parent: 'ingresos', group: CategoryGroup.income, system: true },
  { id: 'ingresos.honorarios', label: 'Honorarios', parent: 'ingresos', group: CategoryGroup.income },
  { id: 'ingresos.arriendo', label: 'Arriendos recibidos', parent: 'ingresos', group: CategoryGroup.income },
  { id: 'ingresos.reembolso', label: 'Reembolsos', parent: 'ingresos', group: CategoryGroup.income, system: true },
  { id: 'ingresos.otros', label: 'Otros ingresos', parent: 'ingresos', group: CategoryGroup.income },

  // ── Vivienda y servicios ────────────────────────────────────────────
  { id: 'vivienda', label: 'Vivienda', group: CategoryGroup.fixed, system: true },
  { id: 'vivienda.arriendo', label: 'Arriendo / dividendo', parent: 'vivienda', group: CategoryGroup.fixed },
  { id: 'vivienda.gastos-comunes', label: 'Gastos comunes', parent: 'vivienda', group: CategoryGroup.fixed },
  { id: 'servicios', label: 'Servicios básicos', group: CategoryGroup.fixed, system: true },
  { id: 'servicios.electricidad', label: 'Electricidad', parent: 'servicios', group: CategoryGroup.fixed },
  { id: 'servicios.agua', label: 'Agua', parent: 'servicios', group: CategoryGroup.fixed },
  { id: 'servicios.gas', label: 'Gas', parent: 'servicios', group: CategoryGroup.fixed },
  { id: 'servicios.internet', label: 'Internet y telefonía', parent: 'servicios', group: CategoryGroup.fixed },

  // ── Alimentación ────────────────────────────────────────────────────
  { id: 'alimentacion', label: 'Alimentación', group: CategoryGroup.variable, system: true },
  { id: 'alimentacion.supermercado', label: 'Supermercado', parent: 'alimentacion', group: CategoryGroup.variable, system: true },
  { id: 'alimentacion.restaurantes', label: 'Restaurantes y cafés', parent: 'alimentacion', group: CategoryGroup.variable, system: true },
  { id: 'alimentacion.delivery', label: 'Delivery', parent: 'alimentacion', group: CategoryGroup.variable, system: true },

  // ── Transporte ──────────────────────────────────────────────────────
  { id: 'transporte', label: 'Transporte', group: CategoryGroup.variable, system: true },
  { id: 'transporte.combustible', label: 'Combustible', parent: 'transporte', group: CategoryGroup.variable, system: true },
  { id: 'transporte.publico', label: 'Transporte público', parent: 'transporte', group: CategoryGroup.variable, system: true },
  { id: 'transporte.apps', label: 'Apps de transporte', parent: 'transporte', group: CategoryGroup.variable, system: true },
  { id: 'transporte.estacionamiento', label: 'Estacionamiento y TAG', parent: 'transporte', group: CategoryGroup.variable },

  // ── Salud, educación, personal ──────────────────────────────────────
  { id: 'salud', label: 'Salud', group: CategoryGroup.fixed, system: true },
  { id: 'salud.farmacia', label: 'Farmacia', parent: 'salud', group: CategoryGroup.variable, system: true },
  { id: 'salud.prevision', label: 'Isapre / Fonasa', parent: 'salud', group: CategoryGroup.fixed, system: true },
  { id: 'educacion', label: 'Educación', group: CategoryGroup.fixed },
  { id: 'cuidado-personal', label: 'Cuidado personal', group: CategoryGroup.variable },

  // ── Discrecional ────────────────────────────────────────────────────
  { id: 'compras', label: 'Compras', group: CategoryGroup.variable, system: true },
  { id: 'entretenimiento', label: 'Entretenimiento', group: CategoryGroup.variable, system: true },
  { id: 'suscripciones', label: 'Suscripciones', group: CategoryGroup.fixed, system: true },
  { id: 'viajes', label: 'Viajes', group: CategoryGroup.variable },
  { id: 'mascotas', label: 'Mascotas', group: CategoryGroup.variable },
  { id: 'regalos', label: 'Regalos y donaciones', group: CategoryGroup.variable },

  // ── Financiero ──────────────────────────────────────────────────────
  { id: 'deudas', label: 'Deudas y créditos', group: CategoryGroup.fixed, system: true },
  { id: 'deudas.cuotas', label: 'Compras en cuotas', parent: 'deudas', group: CategoryGroup.fixed, system: true },
  { id: 'deudas.intereses', label: 'Intereses', parent: 'deudas', group: CategoryGroup.fixed, system: true },
  { id: 'comisiones', label: 'Comisiones bancarias', group: CategoryGroup.fixed, system: true },
  { id: 'impuestos', label: 'Impuestos', group: CategoryGroup.fixed, system: true },
  { id: 'seguros', label: 'Seguros', group: CategoryGroup.fixed, system: true },

  // ── Neutro / ahorro ─────────────────────────────────────────────────
  { id: 'ahorro', label: 'Ahorro', group: CategoryGroup.savings, system: true },
  { id: 'inversiones', label: 'Inversiones', group: CategoryGroup.savings, system: true },
  { id: 'transferencias', label: 'Transferencias entre cuentas', group: CategoryGroup.neutral, system: true },
  { id: 'pago-tarjeta', label: 'Pago de tarjeta', group: CategoryGroup.neutral, system: true },
  { id: 'sin-categoria', label: 'Sin categoría', group: CategoryGroup.variable, system: true },
];

const BY_ID = new Map(DEFAULT_CATEGORIES.map((category) => [category.id, category]));

export function findCategory(id: string): Category | undefined {
  return BY_ID.get(id);
}

export function categoryLabel(id: string | undefined): string {
  if (!id) return 'Sin categoría';
  return BY_ID.get(id)?.label ?? id;
}

/** Full label path, e.g. `Alimentación › Supermercado`. */
export function categoryPath(id: string | undefined): string {
  const category = id ? BY_ID.get(id) : undefined;
  if (!category) return categoryLabel(id);
  if (!category.parent) return category.label;
  return `${categoryLabel(category.parent)} › ${category.label}`;
}

export function categoryGroup(id: string | undefined): CategoryGroup {
  const category = id ? BY_ID.get(id) : undefined;
  return category?.group ?? CategoryGroup.variable;
}

/** Top-level categories, for the picker. */
export function rootCategories(): Category[] {
  return DEFAULT_CATEGORIES.filter((category) => !category.parent);
}

export function childCategories(parentId: string): Category[] {
  return DEFAULT_CATEGORIES.filter((category) => category.parent === parentId);
}
