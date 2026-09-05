/**
 * Payment processors as they appear in Chilean statements.
 *
 * The research this comes from found one thing that changes the design and one
 * thing that rules a design out.
 *
 * What changes it: **whether a processor lets the merchant through is a
 * property of the processor, and it is knowable**. Flow's own help page says a
 * charge reading `FLOW` means "un pago para alguno de los comercios adheridos"
 * — it will not say which. Banco Falabella publishes a glosario telling its own
 * customers that `MERCADO PAGO` "puede ser cualquier comercio que acepte
 * Mercado Pago". Google, on the other hand, documents `GOOGLE *{Company}` and
 * the same bank glosario shows it on a real statement. So this file is a
 * catalogue of processors with that property declared, not a parser.
 *
 * What it rules out: **a grammar built on the asterisk**. The same Falabella
 * document shows `GOOGLE GARENA` and `GOOGLE *GARENA` for what looks like the
 * same charge — the separator does not survive the trip from the card network
 * to the statement reliably. The asterisk is used where a processor documents
 * it, and never assumed anywhere else.
 *
 * Nothing here is universal across Chilean banks. Every bank receives the same
 * network data and prints it its own way, and only one bank publishes what it
 * prints. Extrapolating a format from Falabella to BancoEstado is a hypothesis,
 * which is why `evidence` is recorded per processor and why nothing downstream
 * treats a match as proof of anything but a name.
 */

/**
 * Whether the merchant behind a processor can be read off the glosa.
 *
 * - `hidden` — the charge names the processor and nothing else. The merchant is
 *   unknown, and saying so is the correct answer.
 * - `self` — the processor is billing on its own behalf; the money is going to
 *   it. It is the merchant, unless it publishes a grammar that reveals a
 *   sub-merchant.
 * - `passthrough` — the descriptor normally carries the name the merchant
 *   configured with the acquirer, so whatever is left after the processor name
 *   is a merchant candidate.
 */
export type MerchantVisibility = 'hidden' | 'self' | 'passthrough';

/** How well the visibility claim is supported. Never upgraded by convenience. */
export type ProcessorEvidence =
  /** Documented by the processor, the bank, or a regulator. */
  | 'official'
  /** Observed in a document a bank published for its own customers. */
  | 'observed'
  /** Reasoned from what the product does, with no source that says so. */
  | 'assumed';

export interface ProcessorProfile {
  id: string;
  /** Display name. Never used as a merchant name unless visibility is `self`. */
  name: string;
  /** Matched against the normalised description, as whole words. */
  patterns: readonly RegExp[];
  /**
   * The name is also an ordinary word a Chilean business can be called.
   *
   * `FLOW`, `TOKU` and `KLAP` all fit inside a razón social — `SUSHI FLOW`,
   * `TOKU SUSHI`, `TIENDA KLAP LTDA` are shops, not gateways. Matched anywhere
   * they erased the merchant the bank *had* reported, and then the panel blamed
   * the money on a processor that never touched it. It is the mistake RC3 had
   * to fix with `TAG` inside `PATAGONIA`, one layer up.
   *
   * So these are only read where a processor actually sits: at the head of the
   * glosa, right after the bank's verb, or immediately followed by its own
   * separator. Elsewhere the word is part of a name.
   */
  ambiguousName?: true;
  visibility: MerchantVisibility;
  evidence: ProcessorEvidence;
  /**
   * Grammar that reveals a sub-merchant, where the processor documents one.
   *
   * Capture group 1 is the merchant. Only Google publishes one for Chile.
   */
  submerchant?: RegExp;
}

/**
 * Order matters only for overlapping names; the first match wins.
 *
 * `MERCADO PAGO` before `MERCADO LIBRE` is not needed — the second is a brand,
 * not a processor — but `WEBPAY PLUS` before `WEBPAY` is, so the longer form
 * does not leave `PLUS` behind in the residue.
 */
export const PROCESSORS: readonly ProcessorProfile[] = [
  {
    id: 'mercado-pago',
    name: 'Mercado Pago',
    // The `4 TCOM` / `5 TCOM` of the Falabella glosario is a routing suffix and
    // it is *not* handled here: it rides on any merchant, not only this one, so
    // it belongs to the general noise stripping in `merchants/normalize`.
    patterns: [/\bMERCADO\s*PAGO\b/, /\bMERPAGO\b/, /\bMPAGO\b/],
    visibility: 'hidden',
    evidence: 'observed',
  },
  {
    id: 'flow',
    name: 'Flow',
    patterns: [/\bPAGOS?\.FLOW\.CL\b/, /\bFLOW\b/],
    visibility: 'hidden',
    evidence: 'official',
    ambiguousName: true,
  },
  {
    id: 'servipag',
    name: 'Servipag',
    // A collector: the money is on its way to whoever issued the bill.
    patterns: [/\bSERVIPAG\b/],
    visibility: 'hidden',
    evidence: 'observed',
  },
  {
    id: 'fpay',
    name: 'Fpay',
    // Falabella's own wallet. Its charges arrive without a merchant, except
    // inside the group — and a brand alias in the residue covers that case
    // without needing the processor to change its policy.
    patterns: [/\bFPAY\b/],
    visibility: 'hidden',
    evidence: 'observed',
  },
  {
    id: 'khipu',
    name: 'Khipu',
    // A payment initiator: what the payer sees is whatever the merchant put in
    // the transfer's subject, or Khipu's own account. Nothing documents it.
    patterns: [/\bKHIPU\b/],
    visibility: 'hidden',
    evidence: 'assumed',
  },
  {
    id: 'fintoc',
    name: 'Fintoc',
    patterns: [/\bFINTOC\b/],
    visibility: 'hidden',
    evidence: 'assumed',
  },
  {
    id: 'google',
    name: 'Google',
    patterns: [/\bGOOGLE\b/],
    visibility: 'self',
    evidence: 'official',
    submerchant: /\bGOOGLE\s*\*\s*([A-Z0-9][A-Z0-9 .-]*)/,
  },
  {
    id: 'apple',
    name: 'Apple',
    // Billing for someone else's app, but on its own account: the charge is
    // Apple's, and the glosa never says which app.
    patterns: [/\bAPPLE\.?COM(?:\s*\/?\s*BILL)?\b/, /\bITUNES\b/],
    visibility: 'self',
    evidence: 'observed',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    patterns: [/\bPAY\s*PAL\b/],
    visibility: 'passthrough',
    evidence: 'official',
  },
  {
    id: 'webpay',
    name: 'Webpay',
    patterns: [/\bWEBPAY\s*PLUS\b/, /\bWEBPAY\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'transbank',
    name: 'Transbank',
    patterns: [/\bTRANSBANK\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'redcompra',
    name: 'Redcompra',
    // The debit network, not an intermediary: a card-present sale normally
    // carries the merchant's own name.
    patterns: [/\bRED\s*COMPRA\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'payu',
    name: 'PayU',
    // No source describes PayU's descriptor for Chile, not even a third party.
    // Recognising the name is still worth it: unrecognised, it ended up inside
    // the merchant name.
    patterns: [/\bPAYU\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'klap',
    name: 'Klap',
    patterns: [/\bKLAP\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
    ambiguousName: true,
  },
  {
    id: 'getnet',
    name: 'Getnet',
    patterns: [/\bGETNET\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'sumup',
    name: 'SumUp',
    patterns: [/\bSUMUP\b/, /\bCOMPRAQUI\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'toku',
    name: 'Toku',
    patterns: [/\bTOKU\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
    ambiguousName: true,
  },
  {
    id: 'etpay',
    name: 'ETpay',
    patterns: [/\bETPAY\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
  {
    id: 'kushki',
    name: 'Kushki',
    patterns: [/\bKUSHKI\b/],
    visibility: 'passthrough',
    evidence: 'assumed',
  },
];

/**
 * Glosas that name no merchant, because there is none to name.
 *
 * Two kinds, and both were being read as shops.
 *
 * The bank's own placeholders: Banco Falabella documents `PAGO ONLINE` as what
 * it shows for "comercios que no tenemos registrados" — the bank saying, in as
 * many words, that it cannot name the merchant. Reading it as a merchant called
 * "Online" invents an answer out of an explicit non-answer.
 *
 * And the bank's own operations: a `GIRO CAJERO AUTOMATICO` is cash coming out
 * of a machine. Peeled of its leading verb it leaves "Cajero Automatico", which
 * then competes in the merchant ranking against real shops and fuses every
 * withdrawal of the month into one row.
 *
 * The anchored patterns are whole glosas; the rest match anywhere, because the
 * Falabella glosario shows the same operation as `GIRO CAJERO AUTOM. RED`.
 */
export const BANK_PLACEHOLDERS: readonly RegExp[] = [
  /^PAGO\s+ONLINE$/,
  /^COMPRA\s+(?:POR\s+)?INTERNET$/,
  /^COMPRA\s+EN\s+LINEA$/,
  /^CARGO\s+NO\s+IDENTIFICADO$/,
  /\bCAJERO\s*AUTOM/,
  /\bRETIRO\s+(?:DE\s+)?EFECTIVO\b/,
];

/**
 * Verbs a bank prints before the processor's name.
 *
 * Short list on purpose: it exists so `PAGO FLOW` counts as the processor
 * leading the glosa, not to peel verbs — `merchants/normalize` does that.
 */
const LEADING_VERBS = /^(?:COMPRA|PAGO|CARGO|ABONO|GIRO|TRANSFERENCIA)(?:\s+\w+)?\s+/;

/**
 * Every processor the glosa names, in the order they appear in it.
 *
 * Order in the glosa, not order in this file. `COMPRA WEBPAY PAYU TIENDA X`
 * names two, and the array order used to decide the winner: Webpay won because
 * it is listed earlier here, only Webpay was peeled, and `Payu` stayed glued to
 * the shop's name — the exact failure this layer exists to prevent.
 */
export function findProcessors(normalized: string): ProcessorProfile[] {
  const hits: Array<{ processor: ProcessorProfile; at: number }> = [];

  for (const processor of PROCESSORS) {
    let at = -1;
    for (const pattern of processor.patterns) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      if (processor.ambiguousName && !isProcessorPosition(normalized, match)) continue;
      if (at < 0 || match.index < at) at = match.index;
    }
    if (at >= 0) hits.push({ processor, at });
  }

  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.processor);
}

/** The processor a normalised description names first, if any. */
export function findProcessor(normalized: string): ProcessorProfile | undefined {
  return findProcessors(normalized)[0];
}

/**
 * Whether an ambiguous name sits where a processor sits rather than where a
 * merchant's name does.
 */
function isProcessorPosition(normalized: string, match: RegExpExecArray): boolean {
  // The whole glosa is the name: `FLOW`, which is the form Flow documents.
  if (match[0] === normalized) return true;
  // Carrying its own separator: `FLOW*BIP`, `KLAP.CL`, `TOKU-1234`.
  const after = normalized.slice(match.index + match[0].length);
  if (/^[*.\-/]/.test(after)) return true;
  // Straight after the bank's verb: `PAGO FLOW`.
  const before = normalized.slice(0, match.index);
  return LEADING_VERBS.test(before) && before.trim().split(/\s+/).length <= 2;
}

/** True when the glosa is the bank declaring it cannot name the merchant. */
export function isBankPlaceholder(normalized: string): boolean {
  return BANK_PLACEHOLDERS.some((pattern) => pattern.test(normalized));
}
