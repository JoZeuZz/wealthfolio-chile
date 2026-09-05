/**
 * Automatic-payment mandates, as Chilean banks print them.
 *
 * This is the piece of a cartola that a generic personal-finance tool cannot
 * infer: when a Chilean statement says `PAC AGUAS ANDINAS`, the bank is not
 * describing a purchase, it is naming a standing instruction the account holder
 * signed. That is direct evidence of recurrence, and it is evidence the data
 * carries rather than something a heuristic guessed from three coincidences.
 *
 *   PAC — pago automático de cuentas, charged against a bank account.
 *   PAT — pago automático con tarjeta, charged against a credit card.
 *
 * The generic forms (`PAGO AUTOMATICO`, `DEBITO AUTOMATICO`, `SUSCRIPCION`)
 * say the same thing without saying which rail, so they map to `automatico`.
 *
 * What this does *not* do is declare support for any bank's format. It reads
 * words out of a description; no `validationStatus` depends on it, and a
 * profile is still `pending-real-sample` whether or not this fires.
 *
 * What is and is not established, from a public-source review (2026-09-04, see
 * `.ai/reports/post-rc2-development.md`):
 *
 * - the meanings are documented by the banks themselves — Banco de Chile,
 *   BancoEstado, Santander and BCI all publish PAC as pago automático de
 *   cuentas against an account, PAT as the same against a credit card;
 * - **the layout of the glosa is not documented anywhere public**. No bank or
 *   biller publishes a real statement line, so nothing here assumes the token
 *   sits at the start, at the end, or after a verb. Matching is
 *   position-independent for that reason, not by accident;
 * - `P.A.C.`, `PAC/PAT`, `DEBITO AUTOMATICO` and `CARGO AUTOMATICO` are
 *   plausible and unverified. They are accepted because the cost of a miss is
 *   an unreported mandate; the combined `PAC/PAT` form cannot identify a rail
 *   and is therefore reported only as generic automatic payment;
 * - the residual false positive is a merchant whose own name is the token —
 *   there are real Chilean companies called "PAT ...". A mandate never creates
 *   a pattern on its own; `core/recurring` only lets it surface two charges as
 *   possible, and only inside the tight cadence window.
 */

export type AutomaticMandate = 'pac' | 'pat' | 'automatico';

/**
 * The three-letter forms are matched as whole tokens, never as substrings.
 *
 * `SEGUROS PACIFICO`, `PACK FAMILIAR`, `PATIO OUTLET` and `PATRONATO` all
 * contain the letters and none of them is a mandate. A regular expression with
 * `\b` would already exclude those, but tokenising says so in a way that cannot
 * be weakened by a later edit to the pattern.
 */
const PAC_TOKENS = new Set(['PAC', 'P.A.C.']);
const PAT_TOKENS = new Set(['PAT', 'P.A.T.']);
const GENERIC_TOKENS = new Set(['SUSCRIPCION', 'SUBSCRIPCION', 'PAC/PAT']);

/** Written-out forms. Run against the normalised text, which is accent-folded. */
const PAC_PHRASES = [/\bPAGO AUTOMATICO DE CUENTAS\b/, /\bCUENTAS? AUTOMATICAS?\b/];
const PAT_PHRASES = [/\bPAGO AUTOMATICO (?:CON )?TARJETA\b/];
const GENERIC_PHRASES = [
  /\bPAGO AUTOMATICO\b/,
  /\bPAGO AUT\b/,
  /\bDEBITO AUTOMATICO\b/,
  /\bCARGO AUTOMATICO\b/,
];

/**
 * Which mandate a description declares, if any.
 *
 * Takes the *normalised* description (`core/text::normalizeDescription`), the
 * same form every other matcher in the pipeline compares against, so a rule and
 * this agree about what the text says.
 *
 * The order is specific-before-generic: `PAGO AUTOMATICO DE CUENTAS` is a PAC
 * and reporting it as `automatico` would throw away the rail the bank named.
 */
export function detectAutomaticMandate(
  normalizedDescription: string,
): AutomaticMandate | undefined {
  const text = normalizedDescription;
  if (text === '') return undefined;
  const tokens = text.split(' ');

  // A legal name can itself be PAT/PAC. Prefix plus legal suffix is narrow
  // evidence of a company name and avoids guessing where bank tokens sit.
  if (
    tokens[0] === 'EMPRESA' &&
    tokens.some((token) => token === 'PAC' || token === 'PAT') &&
    ['SPA', 'S.A.', 'SA', 'LTDA'].includes(tokens[tokens.length - 1] as string)
  ) {
    return undefined;
  }

  if (PAC_PHRASES.some((pattern) => pattern.test(text))) return 'pac';
  if (PAT_PHRASES.some((pattern) => pattern.test(text))) return 'pat';
  if (GENERIC_PHRASES.some((pattern) => pattern.test(text))) return 'automatico';
  if (tokens.some((token) => GENERIC_TOKENS.has(token))) return 'automatico';
  if (tokens.some((token) => PAC_TOKENS.has(token))) return 'pac';
  if (tokens.some((token) => PAT_TOKENS.has(token))) return 'pat';
  return undefined;
}

/** How a mandate is named on screen. */
export function mandateLabel(mandate: AutomaticMandate): string {
  switch (mandate) {
    case 'pac':
      return 'PAC — pago automático de cuentas';
    case 'pat':
      return 'PAT — pago automático con tarjeta';
    case 'automatico':
      return 'pago automático';
  }
}
