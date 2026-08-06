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

/** Chilean national ID: 12.345.678-9 / 12345678-K. */
const RUT_PATTERN = /\b(\d{1,2})[.]?(\d{3})[.]?(\d{3})\s*-?\s*([\dkK])\b/g;

/** 13-19 digit card numbers, with or without separators. */
const CARD_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Long digit runs that are plausibly account numbers. */
const ACCOUNT_PATTERN = /\b\d{8,}\b/g;

/** Anything shaped like a bearer token or key. */
const TOKEN_PATTERN = /\b(?:sk|pk|tok|key|bearer)[_-][A-Za-z0-9_-]{8,}\b/gi;

const EMAIL_PATTERN = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Show only the last `visible` characters of an account number.
 * `000123456789` -> `••••6789`
 */
export function maskAccountNumber(value: string | null | undefined, visible = 4): string {
  const text = String(value ?? '').replace(/\s/g, '');
  if (text === '') return '';
  if (text.length <= visible) return '•'.repeat(text.length);
  return `${'•'.repeat(Math.min(4, text.length - visible))}${text.slice(-visible)}`;
}

/** `12.345.678-9` -> `••.•••.678-9`; keeps just enough to recognise your own. */
export function maskRut(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2})[.]?(\d{3})[.]?(\d{3})\s*-?\s*([\dkK])$/.exec(text);
  if (!match) return maskAccountNumber(text.replace(/\D/g, ''), 4);
  return `••.•••.${match[3]}-${match[4]}`;
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
    .replace(CARD_PATTERN, '[CARD]')
    .replace(TOKEN_PATTERN, '[TOKEN]')
    .replace(EMAIL_PATTERN, '[EMAIL]')
    .replace(ACCOUNT_PATTERN, '[NUM]');
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
