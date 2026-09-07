import { TransactionKind } from '../model/kinds';
import { StatementProduct } from '../model/statement';
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

/**
 * A marker that has to stand on its own.
 *
 * `matches` compiles case-insensitively against the same normalised
 * description `contains` reads, so the only difference is the word boundary.
 *
 * Every short marker below has a Chilean glosa that contains it by accident:
 * `PATAGONIA` holds `TAG`, `PARAGUAS` holds `AGUAS`, `DENOMINACION` holds
 * `NOMINA`, `BIPOLAR` holds `BIP` and `INTERESANTE` holds `INTERES`. Searched
 * as substrings they filed a clothing shop under highway tolls. A marker the
 * bank prints as a token of its own is matched as a token of its own — the
 * same rule `core/chile/mandates.ts` follows for PAT and PAC.
 */
const word = (value: string): Rule['conditions'][number] => ({
  field: 'description',
  operator: 'matches',
  value: `\\b${value}\\b`,
});

const merchantIs = (value: string): Rule['conditions'][number] => ({
  field: 'merchant',
  operator: 'equals',
  value,
});

export const BUILTIN_RULES: readonly Rule[] = [
  // ── Movements that must never count as spending (highest priority) ───
  // Keyed on the classification, not on the glosa. `core/classify/card-semantics`
  // already decided this — with the direction and the product in view, which a
  // flat `match: 'any'` list of words does not have. Repeating the markers here
  // gave the rule a far wider reach than the classifier: it fired on
  // `PAGO PAT ENEL`, filed the electricity bill as a card payment, and
  // `stopProcessing` then hid the row from every rule below it.
  rule(
    'builtin.pago-tarjeta',
    'Pago de tarjeta de crédito',
    10,
    [{ field: 'kind', operator: 'equals', value: TransactionKind.credit_card_payment }],
    [{ type: 'set_category', value: 'pago-tarjeta' }],
    { stopProcessing: true },
  ),
  rule(
    'builtin.devolucion-confirmada',
    'Devolución confirmada',
    11,
    [{ field: 'kind', operator: 'equals', value: TransactionKind.refund }],
    [],
    { stopProcessing: true },
  ),

  // Split in two on purpose. The wording is only unambiguous on an account
  // statement: on a tarjeta, `TRASPASO` is refinancing — `TRASPASO A 12
  // CUOTAS`, `TRASPASO DE DEUDA` — and `mark_transfer` there resolves to
  // `TRANSFER_OUT`, which a Wealthfolio credit-card account refuses, so it is
  // substituted for `WITHDRAWAL`, which the host's spending report counts as
  // card spending. The rule that exists to keep a movement out of the spending
  // total was putting it in. `CUENTA PROPIA` and `ENTRE CUENTAS` say what they
  // mean on any document, so they keep their reach.
  rule(
    'builtin.transferencia-propia',
    'Traspaso entre cuentas propias',
    20,
    [contains('CUENTA PROPIA'), contains('ENTRE CUENTAS')],
    [{ type: 'mark_transfer' }, { type: 'set_category', value: 'transferencias' }],
    { stopProcessing: true },
  ),
  rule(
    'builtin.traspaso-cuenta',
    'Traspaso (solo en cuentas, no en tarjetas)',
    21,
    [
      { field: 'description', operator: 'contains', value: 'TRASPASO' },
      { field: 'product', operator: 'not_equals', value: StatementProduct.credit_card },
      { field: 'product', operator: 'not_equals', value: StatementProduct.credit_line },
    ],
    [{ type: 'mark_transfer' }, { type: 'set_category', value: 'transferencias' }],
    { match: 'all', stopProcessing: true },
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
    [word('INTERES'), word('INTERESES')],
    [
      { type: 'set_kind', value: TransactionKind.interest },
      { type: 'set_category', value: 'deudas.intereses' },
    ],
  ),
  rule(
    'builtin.impuestos',
    'Impuestos',
    32,
    // `IVA` as a whole word. As a substring it made `CLINICA PRIVADA`,
    // `CONSULTA PRIVADA` and `UNIVERSIDAD` into taxes: the totals survive —
    // tax is spending either way — but the category does not, and a wrong
    // category is a panel that misreports where the money went.
    [contains('IMPUESTO'), word('IVA'), contains('TIMBRES')],
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
    [contains('SUELDO'), contains('REMUNERACION'), contains('LIQUIDACION'), word('NOMINA')],
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
    [merchantIs('Metro de Santiago'), word('BIP'), contains('TRANSANTIAGO')],
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
    [contains('AUTOPISTA'), contains('COSTANERA NORTE'), contains('VESPUCIO'), word('TAG')],
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
    [merchantIs('Aguas Andinas'), contains('ESVAL'), word('AGUAS')],
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
