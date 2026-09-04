import { formatMonthKey } from '../../core/dates';
import { abs, formatCLP } from '../../core/money';
import type { MonthlyDelta } from '../../core/metrics/comparison';

/**
 * How a figure changed since the month before.
 *
 * `core/metrics/comparison` already decided which of these sentences is honest;
 * this only chooses the words. In particular there is no branch here that can
 * print a percentage, because the union it renders only carries a ratio in the
 * one shape where a ratio means something.
 *
 * `polarity` is what makes the colour right. More spending is worse, more
 * income is better, and the same "+12 %" is a warning in one card and good news
 * in the next; without it every rise would be green.
 */
export function DeltaLine({
  delta,
  previousMonth,
  polarity,
}: {
  delta: MonthlyDelta;
  previousMonth: string | undefined;
  polarity: 'more-is-worse' | 'more-is-better';
}) {
  if (delta.kind === 'both-zero') return null;

  const since = previousMonth ? formatMonthKey(previousMonth) : undefined;

  if (delta.kind === 'no-baseline') {
    return <Line tone="neutral">Sin base comparable</Line>;
  }

  if (delta.kind === 'new') {
    return <Line tone="neutral">Nuevo este mes{since ? ` · nada en ${since}` : ''}</Line>;
  }

  if (delta.kind === 'gone') {
    return (
      <Line tone="neutral">
        Sin movimientos{since ? ` · ${formatCLP(abs(delta.amount))} en ${since}` : ''}
      </Line>
    );
  }

  if (delta.kind === 'sign-flip') {
    return (
      <Line tone="neutral">
        {formatCLP(delta.before)} en {since ?? 'el mes anterior'}
      </Line>
    );
  }

  const percent = Math.round(Math.abs(delta.ratio) * 100);
  const rose = delta.ratio > 0;
  // A change that rounds to nothing is not a trend; saying "0 % más" reads as a
  // measurement when it is really "the same".
  if (percent === 0) {
    return <Line tone="neutral">Igual que en {since ?? 'el mes anterior'}</Line>;
  }

  const worse = polarity === 'more-is-worse' ? rose : !rose;
  return (
    <Line tone={worse ? 'negative' : 'positive'}>
      {percent} % {rose ? 'más' : 'menos'} que en {since ?? 'el mes anterior'}
    </Line>
  );
}

function Line({
  tone,
  children,
}: {
  tone: 'neutral' | 'positive' | 'negative';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-success'
      : tone === 'negative'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return <span className={`block text-xs font-normal ${toneClass}`}>{children}</span>;
}
