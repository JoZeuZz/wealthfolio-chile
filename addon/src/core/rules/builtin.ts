import {
  CARD_SIDE_PAYMENT_MARKERS,
  CASH_SIDE_CARD_PAYMENT_MARKERS,
} from '../classify/card-semantics';
import { TransactionKind } from '../model/kinds';
import type { Rule } from './engine';

/**
 * Rules shipped with the addon.
 *
 * These encode Chilean statement vocabulary that is stable enough to be worth
 * hardcoding — `PAGO TARJETA`, `COMISION MANTENCION`, the big retail and
 * utility brands. They are ordinary rules: the user can disable or override any
 * of them, and user rules run after these by priority.
 *
 * Priorities are spaced by 10 so a user rule can always be slotted between two
 * built-ins without renumbering.
 */

function rule(
  id: string,
  name: string,
  priority: number,
  conditions: Rule['conditions'],
  actions: Rule['actions'],
  options: { match?: Rule['match']; stopProcessing?: boolean } = {},
): Rule {
  return {
    id,
    name,
    enabled: true,
    priority,
    match: options.match ?? 'any',
    conditions,
    actions,
    ...(options.stopProcessing ? { stopProcessing: true } : {}),
    origin: 'builtin',
  };
}

const contains = (value: string): Rule['conditions'][number] => ({
  field: 'description',
  operator: 'contains',
  value,
});

const merchantIs = (value: string): Rule['conditions'][number] => ({
  field: 'merchant',
  operator: 'equals',
  value,
});

export const BUILTIN_RULES: readonly Rule[] = [
  // ── Movements that must never count as spending (highest priority) ───
  // Categorises only. *Classifying* a card payment is
  // `core/classify/card-semantics`, which sees the direction and the product
  // and this rule does not: a flat `match: 'any'` list cannot say "one of these
  // markers AND an outflow", so the rule used to call `PAGO RECIBIDO` on a
  // current account a card payment. The markers come from the same constants
  // the classifier reads, so the two cannot drift apart.
  rule(
    'builtin.pago-tarjeta',
    'Pago de tarjeta de crédito',
    10,
    [...CASH_SIDE_CARD_PAYMENT_MARKERS, ...CARD_SIDE_PAYMENT_MARKERS].map(contains),
    [{ type: 'set_category', value: 'pago-tarjeta' }],
    { stopProcessing: true },
  ),

  rule(
    'builtin.transferencia-propia',
    'Traspaso entre cuentas propias',
    20,
    [contains('CUENTA PROPIA'), contains('ENTRE CUENTAS'), contains('TRASPASO')],
    [{ type: 'mark_transfer' }, { type: 'set_category', value: 'transferencias' }],
    { stopProcessing: true },
  ),

  // ── Bank charges ─────────────────────────────────────────────────────
  rule(
    'builtin.comisiones',
    'Comisiones y mantención',
    30,
    [
      contains('COMISION'),
      contains('MANTENCION'),
      contains('MANTENIMIENTO CUENTA'),
      contains('CARGO POR ADMINISTRACION'),
    ],
    [
      { type: 'set_kind', value: TransactionKind.fee },
      { type: 'set_category', value: 'comisiones' },
    ],
  ),
  rule(
    'builtin.intereses',
    'Intereses',
    31,
    [contains('INTERES'), contains('INTERESES')],
    [
      { type: 'set_kind', value: TransactionKind.interest },
      { type: 'set_category', value: 'deudas.intereses' },
    ],
  ),
  rule(
    'builtin.impuestos',
    'Impuestos',
    32,
    [contains('IMPUESTO'), contains('IVA'), contains('TIMBRES')],
    [
      { type: 'set_kind', value: TransactionKind.tax },
      { type: 'set_category', value: 'impuestos' },
    ],
  ),

  // ── Income ───────────────────────────────────────────────────────────
  rule(
    'builtin.sueldo',
    'Sueldo',
    40,
    [contains('SUELDO'), contains('REMUNERACION'), contains('LIQUIDACION'), contains('NOMINA')],
    [
      { type: 'set_kind', value: TransactionKind.income },
      { type: 'set_category', value: 'ingresos.sueldo' },
    ],
  ),

  // ── Supermarkets ─────────────────────────────────────────────────────
  rule(
    'builtin.supermercado',
    'Supermercados',
    50,
    [
      merchantIs('Lider'),
      merchantIs('Jumbo'),
      merchantIs('Santa Isabel'),
      merchantIs('Tottus'),
      merchantIs('Unimarc'),
    ],
    [{ type: 'set_category', value: 'alimentacion.supermercado' }],
  ),

  // ── Delivery and transport apps ──────────────────────────────────────
  rule(
    'builtin.delivery',
    'Delivery',
    51,
    [merchantIs('Rappi'), merchantIs('PedidosYa'), merchantIs('Uber Eats')],
    [{ type: 'set_category', value: 'alimentacion.delivery' }],
  ),
  rule(
    'builtin.transporte-apps',
    'Apps de transporte',
    52,
    [merchantIs('Uber'), merchantIs('Cabify'), merchantIs('DiDi')],
    [{ type: 'set_category', value: 'transporte.apps' }],
  ),
  rule(
    'builtin.transporte-publico',
    'Transporte público',
    53,
    [merchantIs('Metro de Santiago'), contains('BIP'), contains('TRANSANTIAGO')],
    [{ type: 'set_category', value: 'transporte.publico' }],
  ),
  rule(
    'builtin.combustible',
    'Combustible',
    54,
    [merchantIs('Copec'), merchantIs('Shell'), merchantIs('Petrobras'), contains('BENCINA')],
    [{ type: 'set_category', value: 'transporte.combustible' }],
  ),
  rule(
    'builtin.tag',
    'TAG y autopistas',
    55,
    [contains('AUTOPISTA'), contains('COSTANERA NORTE'), contains('VESPUCIO'), contains('TAG')],
    [{ type: 'set_category', value: 'transporte.estacionamiento' }],
  ),

  // ── Health ───────────────────────────────────────────────────────────
  rule(
    'builtin.farmacia',
    'Farmacias',
    60,
    [merchantIs('Cruz Verde'), merchantIs('Salcobrand'), merchantIs('Farmacias Ahumada')],
    [{ type: 'set_category', value: 'salud.farmacia' }],
  ),
  rule(
    'builtin.prevision-salud',
    'Isapre / Fonasa',
    61,
    [merchantIs('Salud'), contains('ISAPRE'), contains('FONASA')],
    [{ type: 'set_category', value: 'salud.prevision' }],
  ),

  // ── Utilities ────────────────────────────────────────────────────────
  rule(
    'builtin.electricidad',
    'Electricidad',
    70,
    [merchantIs('Enel'), contains('CHILECTRA'), contains('CGE')],
    [{ type: 'set_category', value: 'servicios.electricidad' }],
  ),
  rule(
    'builtin.agua',
    'Agua',
    71,
    [merchantIs('Aguas Andinas'), contains('ESVAL'), contains('AGUAS ')],
    [{ type: 'set_category', value: 'servicios.agua' }],
  ),
  rule(
    'builtin.gas',
    'Gas',
    72,
    [merchantIs('Gas'), merchantIs('Metrogas'), contains('LIPIGAS'), contains('ABASTIBLE')],
    [{ type: 'set_category', value: 'servicios.gas' }],
  ),
  rule(
    'builtin.telecom',
    'Internet y telefonía',
    73,
    [merchantIs('Entel'), merchantIs('Movistar'), merchantIs('Claro'), merchantIs('WOM'), merchantIs('VTR')],
    [{ type: 'set_category', value: 'servicios.internet' }],
  ),

  // ── Subscriptions ────────────────────────────────────────────────────
  rule(
    'builtin.suscripciones',
    'Suscripciones digitales',
    80,
    [
      merchantIs('Netflix'),
      merchantIs('Spotify'),
      merchantIs('Disney+'),
      merchantIs('HBO Max'),
      merchantIs('Amazon Prime'),
      merchantIs('OpenAI'),
      merchantIs('Apple'),
      merchantIs('Google'),
      merchantIs('Microsoft'),
    ],
    [
      { type: 'set_category', value: 'suscripciones' },
      { type: 'add_tag', value: 'suscripcion' },
    ],
  ),

  // ── Retail ───────────────────────────────────────────────────────────
  rule(
    'builtin.retail',
    'Tiendas por departamento',
    90,
    [
      merchantIs('Falabella'),
      merchantIs('Paris'),
      merchantIs('Ripley'),
      merchantIs('Mercado Libre'),
      merchantIs('AliExpress'),
      merchantIs('Amazon'),
    ],
    [{ type: 'set_category', value: 'compras' }],
  ),
  rule(
    'builtin.hogar',
    'Mejoramiento del hogar',
    91,
    [merchantIs('Sodimac'), merchantIs('Easy')],
    [{ type: 'set_category', value: 'compras' }],
  ),

  // ── Insurance ────────────────────────────────────────────────────────
  rule(
    'builtin.seguros',
    'Seguros',
    100,
    [contains('SEGURO'), contains('POLIZA')],
    [{ type: 'set_category', value: 'seguros' }],
  ),

  // ── Cash withdrawals ─────────────────────────────────────────────────
  rule(
    'builtin.giro-efectivo',
    'Giro de efectivo',
    110,
    [contains('GIRO CAJERO'), contains('RETIRO EFECTIVO'), contains('AVANCE EN EFECTIVO')],
    [{ type: 'add_tag', value: 'efectivo' }],
  ),
];

/** Fresh copies, so callers can edit priorities without mutating the module. */
export function defaultRules(): Rule[] {
  return BUILTIN_RULES.map((rule) => ({
    ...rule,
    conditions: rule.conditions.map((condition) => ({ ...condition })),
    actions: rule.actions.map((action) => ({ ...action })),
  }));
}
