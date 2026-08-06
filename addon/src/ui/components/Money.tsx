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

/** A labelled figure for the dashboard's summary row. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: MoneyValue | string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  const toneClass =
    tone === 'positive' ? 'text-success' : tone === 'negative' ? 'text-destructive' : '';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`.trim()}>
        {typeof value === 'string' ? value : formatCLP(value)}
      </span>
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}
