import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@wealthfolio/ui';
import type { Account } from '@wealthfolio/addon-sdk';
import { useCallback, useEffect, useState } from 'react';
import {
  addMonthsToKey,
  civilToday,
  formatIsoDate,
  monthEnd,
  monthKey,
  monthStart,
} from '../../core/dates';
import { Confidence } from '../../core/model/kinds';
import type { AmbiguousTransfer, TransferMatch } from '../../core/reconcile/transfers';
import type { CardPaymentMatch } from '../../core/reconcile/credit-card';
import { reconcileWindow, type ReconciliationResult } from '../../services/reconciliation';
import { useAddon } from '../context';
import { Amount } from '../components/Money';

/**
 * Reviewing what the matchers found.
 *
 * Read-only, and that is the design rather than a shortcut. Applying a match
 * means rewriting two activities and recording a counterpart in their
 * metadata, and Wealthfolio has no public way for an addon to say "these two
 * legs are one transfer": `activities/link`, `/unlink` and `/transfer-pair`
 * exist in the host's HTTP API and are absent from `@wealthfolio/addon-sdk`
 * 3.7.0 and from the sandbox bridge — re-checked against the published package
 * and against `.upstream/wealthfolio` at `v3.7.0`. Building a second, private
 * pairing ledger to fill that gap is the one thing ADR 0005 rules out, because
 * it would have to be migrated away the moment upstream exposes the real one.
 *
 * So this page answers the question the addon *can* answer — "which of my
 * movements are the same money seen twice, and how sure is that?" — and leaves
 * the ledger alone. These candidates do not alter the dashboard because no
 * public host operation exists to apply the pairing.
 *
 * Nothing here presents a suggestion as a fact. Confirmed, suggested and
 * ambiguous are three different claims and they read differently.
 */

/** Months of history the review covers. */
const WINDOW_MONTHS = 3;

interface PageState {
  result?: ReconciliationResult;
  accounts: Map<string, string>;
  error?: string;
  loading: boolean;
}

export function ReconciliationPage() {
  const ctx = useAddon();
  const [state, setState] = useState<PageState>({ accounts: new Map(), loading: true });
  const [month, setMonth] = useState(() => monthKey(civilToday()));

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const [result, accounts] = await Promise.all([
        reconcileWindow(ctx, {
          fromDate: monthStart(addMonthsToKey(month, -(WINDOW_MONTHS - 1))),
          toDate: monthEnd(month),
        }),
        ctx.api.accounts.getAll(),
      ]);
      setState({
        result,
        accounts: new Map(accounts.map((account: Account) => [account.id, account.name])),
        loading: false,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [ctx, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const name = (accountId: string) => state.accounts.get(accountId) ?? accountId;
  const result = state.result;

  const confirmed = (result?.transfers ?? []).filter((m) => m.confidence === Confidence.confirmed);
  const suggested = (result?.transfers ?? []).filter((m) => m.confidence !== Confidence.confirmed);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Conciliación</h1>
          <p className="text-muted-foreground text-sm">
            Movimientos que parecen ser el mismo dinero visto dos veces: transferencias entre tus
            cuentas y pagos de tarjeta.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Ver los meses anteriores"
            onClick={() => setMonth(addMonthsToKey(month, -1))}
          >
            <span aria-hidden>←</span>
          </Button>
          <span className="min-w-40 text-center text-sm font-medium">
            {WINDOW_MONTHS} meses hasta {month}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Ver los meses siguientes"
            // Nothing has been imported from the future. Walking past the
            // current month only produced empty screens that looked like data
            // loss, and on the reconciliation screen an empty window is
            // indistinguishable from "nothing matched".
            disabled={month >= monthKey(civilToday())}
            onClick={() => setMonth(addMonthsToKey(month, 1))}
          >
            <span aria-hidden>→</span>
          </Button>
        </div>
      </header>

      <Alert>
        <AlertTitle>Esta pantalla no cambia nada</AlertTitle>
        <AlertDescription>
          Wealthfolio no expone todavía a los addons una forma de enlazar los dos tramos de una
          transferencia, así que aquí sólo se revisa. Los pares mostrados no alteran los totales del
          panel Chile.
        </AlertDescription>
      </Alert>

      {state.error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron leer los movimientos</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{state.error}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Reintentar
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {result?.truncated ? (
        <Alert variant="destructive">
          <AlertTitle>La lectura quedó incompleta</AlertTitle>
          <AlertDescription>
            No se alcanzaron a revisar todos los movimientos del período, así que puede faltar el
            otro tramo de alguna transferencia. Acota el período antes de fiarte de esta lista.
          </AlertDescription>
        </Alert>
      ) : null}

      {state.loading ? (
        <p className="text-muted-foreground text-sm" role="status">
          Revisando movimientos…
        </p>
      ) : null}

      {result && !state.loading ? (
        <>
          <Section
            title="Pares confirmados"
            empty="Ningún par tiene evidencia suficiente para darse por seguro."
            hint="Monto y cuentas coinciden y la glosa lo dice explícitamente."
          >
            {confirmed.map((match) => (
              <TransferRow key={pairKey(match)} match={match} name={name} tone="confirmed" />
            ))}
          </Section>

          <Section
            title="Pares sugeridos"
            empty="No hay pares que revisar."
            hint="Coinciden en monto y fechas, pero la evidencia no alcanza para afirmarlo."
          >
            {suggested.map((match) => (
              <TransferRow key={pairKey(match)} match={match} name={name} tone="suggested" />
            ))}
          </Section>

          <Section
            title="Sin decidir"
            empty="No quedó ningún grupo ambiguo."
            hint="Varios movimientos indistinguibles entre sí: elegir uno sería echarlo a suertes."
          >
            {result.ambiguousTransfers.map((knot) => (
              <AmbiguousRow key={knotKey(knot)} knot={knot} name={name} />
            ))}
          </Section>

          <Section
            title="Pagos de tarjeta"
            empty="No se reconoció ningún pago de tarjeta en el período."
            hint="Un cargo en la cuenta y el abono que lo recibe en el estado de cuenta."
          >
            {result.cardPayments.map((match) => (
              <CardPaymentRow key={cardKey(match)} match={match} name={name} />
            ))}
          </Section>

          <p className="text-muted-foreground text-sm">
            Se revisaron {result.considered} movimientos importados por Wealthfolio Chile.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  empty,
  children,
}: {
  title: string;
  hint: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title} ({children.length})
        </CardTitle>
        <p className="text-muted-foreground text-sm">{hint}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {children.length === 0 ? (
          <p className="text-muted-foreground text-sm">{empty}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function TransferRow({
  match,
  name,
  tone,
}: {
  match: TransferMatch;
  name: (id: string) => string;
  tone: 'confirmed' | 'suggested';
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone === 'confirmed' ? 'default' : 'outline'}>
          {tone === 'confirmed' ? 'Confirmado' : 'Sugerido'}
        </Badge>
        <span className="font-medium">{name(match.outflow.accountId)}</span>
        <span aria-hidden>→</span>
        <span className="font-medium">{name(match.inflow.accountId)}</span>
        <Amount value={match.outflow.transaction.amount} />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
        <span>
          Salida {formatIsoDate(match.outflow.transaction.date)} · entrada{' '}
          {formatIsoDate(match.inflow.transaction.date)}
        </span>
        <span>
          {match.gapDays === 0 ? 'mismo día' : `${match.gapDays} día(s) de diferencia`}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{match.reason}</p>
    </div>
  );
}

function AmbiguousRow({
  knot,
  name,
}: {
  knot: AmbiguousTransfer;
  name: (id: string) => string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <Badge variant="outline">Sin decidir</Badge>
      <p className="text-muted-foreground text-xs">{knot.reason}</p>
      <ul className="flex flex-col gap-1">
        {knot.movements.map((movement) => (
          <li key={`${movement.accountId}:${movement.transaction.fingerprint}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span>{formatIsoDate(movement.transaction.date)}</span>
            <span className="font-medium">{name(movement.accountId)}</span>
            <Amount value={movement.transaction.amount} signed />
            <span className="text-muted-foreground">{movement.transaction.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardPaymentRow({
  match,
  name,
}: {
  match: CardPaymentMatch;
  name: (id: string) => string;
}) {
  const twoSided = match.cardCredit !== undefined;
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={match.confidence === Confidence.confirmed ? 'default' : 'outline'}>
          {match.confidence === Confidence.confirmed ? 'Confirmado' : 'Sugerido'}
        </Badge>
        <span className="font-medium">{name(match.payment.accountId)}</span>
        {twoSided ? (
          <>
            <span aria-hidden>→</span>
            <span className="font-medium">{name(match.cardCredit!.accountId)}</span>
          </>
        ) : null}
        <Amount value={match.payment.transaction.amount} />
      </div>
      <div className="text-muted-foreground text-xs">
        {formatIsoDate(match.payment.transaction.date)}
      </div>
      <p className="text-muted-foreground text-xs">{match.reason}</p>
    </div>
  );
}

function pairKey(match: TransferMatch): string {
  return `${match.outflow.transaction.fingerprint}:${match.inflow.transaction.fingerprint}`;
}

function knotKey(knot: AmbiguousTransfer): string {
  return knot.movements.map((m) => m.transaction.fingerprint).join('|');
}

function cardKey(match: CardPaymentMatch): string {
  return `${match.payment.accountId}:${match.payment.transaction.fingerprint}`;
}
