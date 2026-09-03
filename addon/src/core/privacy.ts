/**
 * Redaction helpers.
 *
 * The rule for this project: a log line, an error message or a bug report must
 * never be able to identify a person or an account. Anything that reaches a log
 * goes through {@link redactSensitive} first, and anything shown next to a
 * statement goes through the maskers.
 *
 * This is defence in depth, not a substitute for not logging financial data —
 * see docs/PRIVACY.md.
 */

/**
 * Chilean national ID.
 *
 * Written every way people actually write it: `12.345.678-9`, `12345678-K`,
 * `12 345 678 9`, and the six-digit bodies older RUTs still have. The original
 * pattern demanded exactly a 1-2 / 3 / 3 grouping with dots or nothing, so
 * `123.456-7` — a real RUT belonging to a real generation of people — passed
 * through a redactor untouched and into the addon's storage.
 */
const RUT_PATTERN = /\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}[\s-]{0,3}[\dkK]\b/g;
const SHORT_RUT_PATTERN = /\b\d{3}[.\s]?\d{3}[\s-]{1,3}[\dkK]\b/g;

/**
 * 13-19 digit card numbers, however they are grouped.
 *
 * `\d[ -]?` allowed exactly one space or dash between digits, so a statement
 * grouping with `/`, `.` or two spaces defeated it entirely.
 */
const CARD_PATTERN = /\b(?:\d[ ./-]{0,2}){12,18}\d\b/g;

/**
 * Digit groups long enough to be an account number.
 *
 * `\b\d{8,}\b` missed everything grouped — `001.234.567.890`,
 * `0012-3456-7890` — and everything under eight digits, which includes plenty
 * of real Chilean account numbers. The separators are counted out and the
 * decision is made on how many digits are actually there.
 */
const ACCOUNT_PATTERN = /\b\d[\d.\-\s]{4,}\d\b/g;
const MIN_ACCOUNT_DIGITS = 7;

/** Anything shaped like a bearer token or key. */
const TOKEN_PATTERN = /\b(?:sk|pk|tok|key|bearer)[_-][A-Za-z0-9_-]{8,}\b/gi;

/**
 * Email, with letters from any alphabet.
 *
 * `\w` is ASCII-only without the `u` flag, so `josé@correo.cl` was not an
 * email as far as the redactor was concerned.
 */
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;

/**
 * Show only the last `visible` characters of an account number.
 * `000123456789` -> `••••6789`
 */
export function maskAccountNumber(value: string | null | undefined, visible = 4): string {
  const text = String(value ?? '').replace(/\s/g, '');
  if (text === '') return '';
  if (text.length <= visible) return '•'.repeat(text.length);
  // Never show more than half of a short value: `12345` used to come back as
  // `•2345`, four digits of five, which masks nothing.
  const shown = Math.min(visible, Math.floor(text.length / 2));
  return `${'•'.repeat(Math.min(4, text.length - shown))}${text.slice(-shown)}`;
}

/** `12.345.678-9` -> `••.•••.678-9`; keeps just enough to recognise your own. */
export function maskRut(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  const long = /^(\d{1,2})[.\s]?(\d{3})[.\s]?(\d{3})\s*-?\s*([\dkK])$/.exec(text);
  if (long) return `••.•••.${long[3]}-${long[4]}`;
  // Six-digit bodies are real RUTs too. They used to fall through to the
  // generic masker, which showed the last four characters — the whole tail plus
  // the check digit.
  const short = /^(\d{3})[.\s]?(\d{3})\s*-?\s*([\dkK])$/.exec(text);
  if (short) return `•••.${short[2]}-${short[3]}`;
  return maskAccountNumber(text.replace(/\D/g, ''), 4);
}

/** `4051 2233 4455 6677` -> `•••• •••• •••• 6677` */
export function maskCardNumber(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• •••• •••• ${digits.slice(-4)}`;
}

/**
 * Strip every identifier that could tie a log line to a person or an account.
 *
 * Order matters: RUTs and cards are matched before the generic long-digit rule
 * so they get their specific, more readable placeholder.
 */
export function redactSensitive(input: string): string {
  return String(input ?? '')
    .replace(RUT_PATTERN, '[RUT]')
    .replace(SHORT_RUT_PATTERN, '[RUT]')
    .replace(CARD_PATTERN, '[CARD]')
    .replace(TOKEN_PATTERN, '[TOKEN]')
    .replace(EMAIL_PATTERN, '[EMAIL]')
    .replace(ACCOUNT_PATTERN, (match) =>
      match.replace(/\D/g, '').length >= MIN_ACCOUNT_DIGITS ? '[NUM]' : match,
    );
}

/**
 * A file name safe to keep.
 *
 * Chilean banks name their downloads after the thing that identifies the
 * account: `CartolaCuentaRut_12345678-9_202602.csv`,
 * `Movimientos_001234567890.xlsx`. The import history stored that verbatim, in
 * a store that replicates across the user's paired devices, while
 * `docs/PRIVACY.md` said the file's hash was the only thing kept from it.
 *
 * Every run of four or more digits goes, and so does anything shaped like a
 * RUT. What is left — the bank's own word for the document, the period, the
 * extension — is what makes the entry recognisable, and none of it identifies
 * anybody.
 */
export function sanitizeFileName(name: string, maxLength = 60): string {
  const cleaned = String(name ?? '')
    .replace(RUT_PATTERN, '…')
    .replace(SHORT_RUT_PATTERN, '…')
    .replace(/\d{4,}/g, '…')
    .replace(/…(?:[\s._-]*…)+/g, '…')
    .trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

/**
 * A statement description, safe to log.
 *
 * Descriptions frequently embed counterparty names and card tails, so only the
 * leading merchant-ish part survives and identifiers inside it are redacted.
 */
export function redactDescription(description: string, keep = 24): string {
  const redacted = redactSensitive(String(description ?? '').trim());
  return redacted.length <= keep ? redacted : `${redacted.slice(0, keep)}…`;
}

/**
 * Amounts must not appear in logs at full precision — an exact figure plus a
 * date identifies a transaction as well as an ID does. This reports only the
 * order of magnitude, which is what debugging actually needs.
 */
export function redactAmount(minor: number): string {
  const magnitude = Math.abs(minor);
  if (magnitude === 0) return '0';
  const digits = Math.floor(Math.log10(magnitude)) + 1;
  return `${minor < 0 ? '-' : '+'}1e${digits - 1}..1e${digits}`;
}

/**
 * Wrap a host logger so nothing reaches it unredacted.
 *
 * The addon never calls `ctx.api.logger` directly; it calls this. That keeps
 * "did we leak anything?" a one-file question.
 */
export interface RedactingLoggerSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface RedactingLogger extends RedactingLoggerSink {
  /** Emitted only when the user has explicitly enabled verbose diagnostics. */
  verbose(message: string): void;
}

export function createRedactingLogger(
  sink: RedactingLoggerSink,
  options: { verboseEnabled?: boolean } = {},
): RedactingLogger {
  const { verboseEnabled = false } = options;
  const clean = (message: string) => redactSensitive(String(message ?? ''));
  return {
    error: (m) => sink.error(clean(m)),
    warn: (m) => sink.warn(clean(m)),
    info: (m) => sink.info(clean(m)),
    debug: (m) => sink.debug(clean(m)),
    verbose: (m) => {
      if (verboseEnabled) sink.debug(clean(m));
    },
  };
}
