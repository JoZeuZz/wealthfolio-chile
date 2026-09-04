import type { ReactNode } from 'react';
import { formatCLP, type Money as MoneyValue } from '../../core/money';

/**
 * Money rendering.
 *
 * Always formatted from the exact integer representation — never from a float —
 * so what the user reads is what the engine computed.
 */
export function Amount({
  value,
  signed = false,
  className = '',
}: {
  value: MoneyValue;
  /** Colour by direction and always show the sign. */
  signed?: boolean;
  className?: string;
}) {
  const negative = value.minor < 0;
  const tone = signed ? (negative ? 'text-destructive' : 'text-success') : '';
  const text = formatCLP(value);
  return (
    <span className={`tabular-nums ${tone} ${className}`.trim()}>
      {signed && !negative && value.minor !== 0 ? '+' : ''}
      {text}
    </span>
  );
}

/**
 * A labelled figure for a summary row.
 *
 * A description-list pair rather than two anonymous `div`s, so the label and
 * its number reach the accessibility tree as a pair. They previously did not
 * reach it at all: the whole preview summary — income, expenses, how many
 * movements were about to be written — was invisible to a screen reader and to
 * any tool that reads the page semantically.
 *
 * The caller supplies the surrounding `<dl>`; several of these in a grid are
 * one list, not one list each.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: MoneyValue | string;
  /** Secondary line under the figure: a breakdown, a comparison, both. */
  hint?: ReactNode;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  const toneClass =
    tone === 'positive' ? 'text-success' : tone === 'negative' ? 'text-destructive' : '';
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${toneClass}`.trim()}>
        {typeof value === 'string' ? value : formatCLP(value)}
        {typeof hint === 'string' ? (
          <span className="text-muted-foreground block text-xs font-normal">{hint}</span>
        ) : (
          hint
        )}
      </dd>
    </div>
  );
}
