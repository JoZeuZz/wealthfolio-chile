import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addMonthsToKey,
  DateParseError,
  dayNumber,
  daysBetween,
  formatMonthKey,
  fromDayNumber,
  isIsoDate,
  monthKey,
  monthRange,
  parseStatementDate,
} from '../src/core/dates';

describe('parseStatementDate', () => {
  it('reads dd/mm/yyyy as day-first', () => {
    expect(parseStatementDate('03/02/2026').date).toBe('2026-02-03');
  });

  it('reads dd-mm-yyyy and dd.mm.yyyy', () => {
    expect(parseStatementDate('03-02-2026').date).toBe('2026-02-03');
    expect(parseStatementDate('03.02.2026').date).toBe('2026-02-03');
  });

  it('reads ISO dates unchanged', () => {
    expect(parseStatementDate('2026-02-03').date).toBe('2026-02-03');
  });

  it('expands two-digit years', () => {
    expect(parseStatementDate('03/02/26').date).toBe('2026-02-03');
    expect(parseStatementDate('03/02/98').date).toBe('1998-02-03');
  });

  it('discards a time component', () => {
    expect(parseStatementDate('03/02/2026 14:35:00').date).toBe('2026-02-03');
  });

  it('reads Spanish month names', () => {
    expect(parseStatementDate('03 ene 2026').date).toBe('2026-01-03');
    expect(parseStatementDate('3 de septiembre de 2026').date).toBe('2026-09-03');
  });

  it('flags a date that reads validly both ways', () => {
    const result = parseStatementDate('03/02/2026');
    expect(result.ambiguous).toBe(true);
  });

  it('does not flag a date only one reading accepts', () => {
    const result = parseStatementDate('23/02/2026');
    expect(result.date).toBe('2026-02-23');
    expect(result.ambiguous).toBe(false);
  });

  it('falls back to the other field order when day-first is impossible', () => {
    expect(parseStatementDate('02/23/2026').date).toBe('2026-02-23');
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parseStatementDate('31/02/2026')).toThrow(DateParseError);
    expect(() => parseStatementDate('')).toThrow(DateParseError);
    expect(() => parseStatementDate('no es fecha')).toThrow(DateParseError);
  });

  it('accepts 29 February only in leap years', () => {
    expect(parseStatementDate('29/02/2024').date).toBe('2024-02-29');
    expect(() => parseStatementDate('29/02/2026')).toThrow(DateParseError);
  });
});

describe('civil date arithmetic', () => {
  it('round-trips through the day number', () => {
    for (const iso of ['1970-01-01', '2000-02-29', '2026-02-03', '2100-12-31']) {
      expect(fromDayNumber(dayNumber(iso))).toBe(iso);
    }
  });

  it('measures days between dates', () => {
    expect(daysBetween('2026-02-03', '2026-02-10')).toBe(7);
    expect(daysBetween('2026-02-10', '2026-02-03')).toBe(-7);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('clamps when adding months to a long month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('is unaffected by the host timezone', () => {
    // A naive `new Date('2026-02-03')` in UTC+13 would report 2026-02-02.
    expect(monthKey('2026-02-01')).toBe('2026-02');
    expect(monthKey('2026-12-31')).toBe('2026-12');
  });
});

describe('month keys', () => {
  it('shifts across a year boundary', () => {
    expect(addMonthsToKey('2026-12', 1)).toBe('2027-01');
    expect(addMonthsToKey('2026-01', -1)).toBe('2025-12');
  });

  it('enumerates an inclusive range', () => {
    expect(monthRange('2026-01', '2026-04')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('returns nothing for an inverted range', () => {
    expect(monthRange('2026-04', '2026-01')).toEqual([]);
  });

  it('labels a month in Spanish', () => {
    expect(formatMonthKey('2026-02')).toBe('febrero 2026');
  });
});

describe('isIsoDate', () => {
  it('accepts valid and rejects invalid', () => {
    expect(isIsoDate('2026-02-03')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('03/02/2026')).toBe(false);
  });
});
