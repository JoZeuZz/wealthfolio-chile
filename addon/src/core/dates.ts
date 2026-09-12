/**
 * Civil-date handling for statement parsing.
 *
 * Statement dates are calendar dates, not instants: a purchase on 03/02/2026 is
 * that day in Chile regardless of where the app runs. Everything here works on
 * `YYYY-MM-DD` strings and integer components, never on `Date`, so a machine in
 * UTC+13 can never shift a transaction into the previous month.
 */

/** A calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string;

/** Which of the six readings rejected the cell — never *what* was in it. */
export type DateParseErrorKind =
  | 'empty'
  | 'unrecognised-format'
  | 'invalid-calendar-date'
  | 'unknown-month-name'
  | 'missing-year'
  | 'outside-declared-period';

/**
 * Coarse character shape of an unrecognised date cell — digit-run length
 * bucketed, never the digits. A calibration report can say "this file's date
 * column is 5-6 raw digits with no separator", which is what a spreadsheet
 * date serial read as plain text looks like, without ever printing the serial
 * or the date it represents.
 */
export type DateTextShape =
  | 'solo-digitos-corto'
  | 'solo-digitos-mediano'
  | 'solo-digitos-largo'
  | 'con-letras'
  | 'separadores-con-espacios'
  | 'dos-segmentos'
  | 'cuatro-segmentos'
  | 'cinco-o-mas-segmentos'
  | 'segmento-fuera-de-rango'
  | 'otro';

const NUMERIC_DATE_SHAPE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

/**
 * The segment *count* a date-like cell splits into is a structural fact, not
 * content — this report already prints row and column counts freely. What it
 * must not do is echo the digits in any segment, so this stops at "how many"
 * and "how long", never "what".
 */
export function describeDateShape(text: string): DateTextShape {
  if (/^\d+$/.test(text)) {
    if (text.length <= 4) return 'solo-digitos-corto';
    if (text.length <= 6) return 'solo-digitos-mediano';
    return 'solo-digitos-largo';
  }
  if (/[a-zA-Zà-ÿ]/.test(text)) return 'con-letras';
  if (/[-/.]/.test(text)) {
    if (NUMERIC_DATE_SHAPE.test(text.replace(/\s+/g, ''))) return 'separadores-con-espacios';
    const segments = text.split(/[-/.]+/).filter((segment) => segment !== '');
    if (segments.length === 2) return 'dos-segmentos';
    if (segments.length === 4) return 'cuatro-segmentos';
    if (segments.length >= 5) return 'cinco-o-mas-segmentos';
    return 'segmento-fuera-de-rango';
  }
  return 'otro';
}

export class DateParseError extends Error {
  readonly kind: DateParseErrorKind;
  /** Only set for `kind: 'unrecognised-format'`. See {@link DateTextShape}. */
  readonly shape?: DateTextShape;

  constructor(message: string, kind: DateParseErrorKind, shape?: DateTextShape) {
    super(message);
    this.name = 'DateParseError';
    this.kind = kind;
    if (shape !== undefined) this.shape = shape;
  }
}

/** Order of the day/month fields when a numeric date is ambiguous. */
export type DateFieldOrder = 'DMY' | 'MDY' | 'YMD';

/**
 * What a statement declares about the period it covers, for resolving a date
 * cell that names a day and a month but never a year.
 *
 * Both boundaries are required: a year-less date is only safe when the
 * complete declared period settles it — see {@link resolveYearForMonth}.
 */
export interface DateYearHint {
  from?: IsoDate;
  to?: IsoDate;
}

export interface ParseDateOptions {
  /** Field order for ambiguous numeric dates. Chilean statements are DMY. */
  order?: DateFieldOrder;
  /** Pivot for two-digit years: values below map to 2000+, at or above to 1900+. */
  twoDigitYearPivot?: number;
  /**
   * Supplies the year for a cell that names only a day and a month, such as
   * BancoEstado's CuentaRUT export. Absent, a year-less date is refused rather
   * than guessed.
   */
  yearHint?: DateYearHint;
}

/**
 * The calendar year a day-and-month-only date belongs to, given the period
 * the statement declares.
 *
 * A statement confined to one calendar year settles it outright. One that
 * crosses the turn of the year — a cartola running 15 Dec to 10 Jan — cannot:
 * `28 dic` and `05 ene` are both inside it but four months apart on the
 * calendar, so the month decides which boundary's year applies. A month at or
 * after the period's start month reads as the earlier year (it's the `dic`
 * side); anything earlier reads as the later year (the `ene` side).
 */
export function resolveYearForMonth(month: number, hint: DateYearHint): number | undefined {
  const { from, to } = hint;
  if (!from || !to || !isIsoDate(from) || !isIsoDate(to) || from > to) return undefined;

  const candidates: number[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    const monthStart = toIsoDate(year, month, 1);
    const monthEnd = toIsoDate(year, month, daysInMonth(year, month));
    if (monthStart <= to && monthEnd >= from) candidates.push(year);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface ParseDateResult {
  date: IsoDate;
  /** True when both day-first and month-first readings were valid and distinct. */
  ambiguous: boolean;
}

const MONTHS_ES: Record<string, number> = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  if (!isValidYmd(year, month, day)) {
    throw new DateParseError(`invalid calendar date ${year}-${month}-${day}`, 'invalid-calendar-date');
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function isIsoDate(value: string): value is IsoDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return isValidYmd(y, m, d);
}

/**
 * Parse a raw date cell into an ISO calendar date.
 *
 * Accepts `dd/mm/yyyy`, `dd-mm-yyyy`, `dd.mm.yyyy`, `yyyy-mm-dd`, two-digit
 * years, `dd/mmm/yyyy` with Spanish month names, and values carrying a time
 * component (the time is discarded — statements settle on a day, not a second).
 */
export function parseStatementDate(raw: string, options: ParseDateOptions = {}): ParseDateResult {
  const { order = 'DMY', twoDigitYearPivot = 70, yearHint } = options;
  const text = String(raw ?? '').trim();
  if (text === '') throw new DateParseError('empty date', 'empty');

  // Drop a time-of-day suffix: "03/02/2026 14:35:00" -> "03/02/2026". Matching
  // the clock shape rather than splitting on whitespace keeps written-out dates
  // such as "03 ene 2026" intact.
  const dateOnly = text.replace(/[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?.*$/i, '').trim();

  // ISO / yyyy-first, always unambiguous.
  const iso = dateOnly.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso as unknown as [string, string, string, string];
    return { date: toIsoDate(Number(y), Number(m), Number(d)), ambiguous: false };
  }

  // Spanish month names: "03 ene 2026", "3-ENE-2026", "03 de enero de 2026"
  const named = dateOnly
    .toLowerCase()
    .replace(/\bde\b/g, ' ')
    .match(/^(\d{1,2})[\s\-/.]+([a-z\u00e0-\u00ff]+)[\s\-/.]+(\d{2,4})$/);
  if (named) {
    const [, d, name, y] = named as unknown as [string, string, string, string];
    const month = MONTHS_ES[stripAccents(name)];
    if (month === undefined) throw new DateParseError(`unknown month name: ${name}`, 'unknown-month-name');
    return {
      date: toIsoDate(expandYear(Number(y), twoDigitYearPivot), month, Number(d)),
      ambiguous: false,
    };
  }

  // Day + Spanish month name, no year: BancoEstado's CuentaRUT export writes
  // "03/sep" and leaves the year to be inferred from the period the statement
  // itself declares \u2014 see `resolveYearForMonth`. Without a `yearHint` this is
  // refused rather than guessed.
  const namedNoYear = dateOnly
    .toLowerCase()
    .match(/^(\d{1,2})[\s\-/.]+([a-z\u00e0-\u00ff]+)$/);
  if (namedNoYear) {
    const [, d, name] = namedNoYear as unknown as [string, string, string];
    const month = MONTHS_ES[stripAccents(name)];
    if (month === undefined) throw new DateParseError(`unknown month name: ${name}`, 'unknown-month-name');
    const year = yearHint && resolveYearForMonth(month, yearHint);
    if (year === undefined) {
      throw new DateParseError(
        `date has no year and no period to infer one from: ${text}`,
        'missing-year',
      );
    }
    const date = toIsoDate(year, month, Number(d));
    if (!yearHint?.from || !yearHint.to || date < yearHint.from || date > yearHint.to) {
      throw new DateParseError(`date falls outside declared period: ${text}`, 'outside-declared-period');
    }
    return { date, ambiguous: false };
  }

  // Day + numeric month, no year: the numeric twin of the Spanish-month case
  // above. Banco de Chile's cuenta corriente export writes "03/09" and, like
  // BancoEstado's "03/sep", never repeats the year on the row — only the
  // profile's declared period says which one it is. Checked after the named
  // no-year case so "03/sep" (which also has two `[\s\-/.]`-joined parts) is
  // never mistaken for it; checked before the three-part numeric case below so
  // a genuine `dd/mm/yyyy` never loses its year to this.
  const numericNoYear = dateOnly.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (numericNoYear) {
    const [, aStr, bStr] = numericNoYear as unknown as [string, string, string];
    const { day, month } = splitDayMonth(Number(aStr), Number(bStr), order);
    if (month < 1 || month > 12) {
      throw new DateParseError(`invalid date: ${text}`, 'invalid-calendar-date');
    }
    const year = yearHint && resolveYearForMonth(month, yearHint);
    if (year === undefined) {
      throw new DateParseError(
        `date has no year and no period to infer one from: ${text}`,
        'missing-year',
      );
    }
    const date = toIsoDate(year, month, day);
    if (!yearHint?.from || !yearHint.to || date < yearHint.from || date > yearHint.to) {
      throw new DateParseError(`date falls outside declared period: ${text}`, 'outside-declared-period');
    }
    return { date, ambiguous: false };
  }

  const numeric = dateOnly.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!numeric) {
    throw new DateParseError(
      `unrecognised date format: ${text}`,
      'unrecognised-format',
      describeDateShape(dateOnly),
    );
  }

  const [, aStr, bStr, yStr] = numeric as unknown as [string, string, string, string];
  const a = Number(aStr);
  const b = Number(bStr);
  const year = expandYear(Number(yStr), twoDigitYearPivot);

  const dayFirstValid = isValidYmd(year, b, a);
  const monthFirstValid = isValidYmd(year, a, b);

  if (order === 'MDY') {
    if (!monthFirstValid) {
      if (dayFirstValid) return { date: toIsoDate(year, b, a), ambiguous: false };
      throw new DateParseError(`invalid date: ${text}`, 'invalid-calendar-date');
    }
    return { date: toIsoDate(year, a, b), ambiguous: dayFirstValid && a !== b };
  }

  // DMY (and YMD, which never reaches here) — the Chilean default.
  if (!dayFirstValid) {
    if (monthFirstValid) return { date: toIsoDate(year, a, b), ambiguous: false };
    throw new DateParseError(`invalid date: ${text}`, 'invalid-calendar-date');
  }
  return { date: toIsoDate(year, b, a), ambiguous: monthFirstValid && a !== b };
}

/**
 * Which of two numeric fields is the day and which is the month, per a
 * declared field order — the one decision a `dd/mm` cell needs made before it
 * can even ask for a year. Shared by the no-year branch above and by any
 * profile-specific period derivation that reads the same shape off a
 * structural row (see `core/providers/profile-parser.ts`), so the two never
 * disagree about which field is which.
 */
export function splitDayMonth(a: number, b: number, order: DateFieldOrder): { day: number; month: number } {
  return order === 'MDY' ? { day: b, month: a } : { day: a, month: b };
}

function expandYear(year: number, pivot: number): number {
  if (year >= 100) return year;
  return year < pivot ? 2000 + year : 1900 + year;
}

/** Whole days between two ISO dates (`b - a`). Negative when `b` precedes `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return dayNumber(b) - dayNumber(a);
}

/** Days since 1970-01-01 for an ISO date, computed without `Date`. */
export function dayNumber(iso: IsoDate): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  // Howard Hinnant's days_from_civil algorithm.
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link dayNumber}. */
export function fromDayNumber(days: number): IsoDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return toIsoDate(m <= 2 ? y + 1 : y, m, d);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(iso) + days);
}

/** Add whole months, clamping to the last valid day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return toIsoDate(year, month, Math.min(d, daysInMonth(year, month)));
}

/** `YYYY-MM` bucket key used by every monthly aggregate. */
/**
 * Today, in the calendar the user lives in.
 *
 * `new Date().toISOString().slice(0, 10)` is not anybody's civil date — it is
 * the UTC one. In Chile that is three or four hours ahead of the wall clock,
 * so from ten at night the UTC day has already turned: on the 31st of January
 * at 22:30 in Santiago a screen opening "this month" opened February.
 *
 * A civil date computed from a wall clock has to be read on that wall clock.
 * What must *not* change is reading a date that came from the host:
 * Wealthfolio stores a bare `YYYY-MM-DD` as UTC midnight
 * (`storage-sqlite/src/activities/model.rs`, v3.7.0), so re-reading that
 * instant in UTC gives the same civil day back and re-reading it locally would
 * move it by one.
 *
 * @param offsetMinutes Minutes to add to UTC, i.e. the negation of
 *   `Date.prototype.getTimezoneOffset`. Defaults to the running environment's,
 *   and is a parameter so the boundaries can be tested without a fake clock.
 */
export function civilToday(
  now: Date = new Date(),
  offsetMinutes: number = -now.getTimezoneOffset(),
): IsoDate {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  return toIsoDate(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
}

export type MonthKey = string;

export function monthKey(iso: IsoDate): MonthKey {
  return iso.slice(0, 7);
}

export function monthKeyOf(year: number, month: number): MonthKey {
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

/** Shift a `YYYY-MM` bucket by whole months. */
export function addMonthsToKey(key: MonthKey, months: number): MonthKey {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  return monthKeyOf(Math.floor(total / 12), (total % 12) + 1);
}

/** First calendar day of a `YYYY-MM` bucket. */
export function monthStart(key: MonthKey): IsoDate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return toIsoDate(y, m, 1);
}

/** Last calendar day of a `YYYY-MM` bucket, leap years included. */
export function monthEnd(key: MonthKey): IsoDate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return toIsoDate(y, m, daysInMonth(y, m));
}

export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  let cursor = from;
  // Guard against inverted ranges producing an unbounded loop.
  for (let i = 0; i < 600 && cursor <= to; i += 1) {
    out.push(cursor);
    cursor = addMonthsToKey(cursor, 1);
  }
  return out;
}

const MONTH_LABELS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Human label for a month bucket, e.g. `2026-02` -> `febrero 2026`. */
export function formatMonthKey(key: MonthKey): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${MONTH_LABELS_ES[m - 1] ?? key} ${y}`;
}

/** es-CL day presentation, e.g. `2026-02-03` -> `03-02-2026`. */
export function formatIsoDate(iso: IsoDate): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${d}-${m}-${y}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
