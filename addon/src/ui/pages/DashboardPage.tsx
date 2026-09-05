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
  Separator,
} from '@wealthfolio/ui';
import { useEffect, useMemo, useState } from 'react';
import { categoryPath } from '../../core/categories/defaults';
import {
  addMonthsToKey,
  civilToday,
  formatMonthKey,
  monthEnd,
  monthKey,
  monthStart,
} from '../../core/dates';
import { buildInsights, type Insight } from '../../core/insights/rules';
import { compareMonths, type MonthlyComparison } from '../../core/metrics/comparison';
import { buildInstallmentPlans, buildOutlook } from '../../core/installments/plans';
import {
  financialCostBreakdown,
  summarizeByCurrency,
  summarizeMonth,
  totalsByCategory,
  totalsByMerchant,
  unattributedByProcessor,
  unattributedSpending,
} from '../../core/metrics/monthly';
import { financialCostLabel } from '../../core/model/financial-cost';
import { findRecurringCharges } from '../../core/recurring/detect';
import { mandateLabel } from '../../core/chile/mandates';
import { formatCLP } from '../../core/money';
import { Confidence } from '../../core/model/kinds';
import type { NormalizedTransaction } from '../../core/model/transaction';
import { ImportHistory, type ImportRun } from '../../services/import-history';
import { loadImportedTransactions } from '../../services/imported-transactions';
import { useAddon } from '../context';
import { DeltaLine } from '../components/Delta';
import { Amount, Stat } from '../components/Money';

/**
 * The Chile dashboard.
 *
 * Deliberately not a second copy of Wealthfolio's own overview: it answers the
 * cash-flow questions Wealthfolio does not, and it answers them from activities
 * this addon imported, reconstructed out of the metadata written at import
 * time. Everything shown is arithmetic over that data — no estimates, no model.
 */

/**
 * Months of history loaded behind the selected month.
 *
 * Everything the panel computes needs at most this much context: the month
 * itself, the previous month for the comparisons, and a year of history for the
 * recurring-charge and installment detection. Asking the host for exactly that
 * window — rather than paging blindly through the whole activity table until an
 * arbitrary cap — is what keeps the figures correct as an account grows.
 */
const HISTORY_MONTHS = 13;

interface DashboardData {
  transactions: NormalizedTransaction[];
  runs: ImportRun[];
  /** Currency to show when there are no movements to take one from. */
  fallbackCurrency: string;
  /** True when the host held more rows in the window than we could read. */
  truncated: boolean;
}

export function DashboardPage() {
  const ctx = useAddon();
  const [data, setData] = useState<DashboardData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(() => monthKey(civilToday()));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [loaded, runs, settings] = await Promise.all([
          loadImportedTransactions(ctx, {
            fromDate: monthStart(addMonthsToKey(month, -HISTORY_MONTHS)),
            toDate: monthEnd(month),
          }),
          ImportHistory.from(ctx).recent(10),
          ctx.api.settings.get().catch(() => undefined),
        ]);
        if (cancelled) return;
        setData({
          transactions: loaded.transactions,
          runs,
          // Only the fallback for a panel with nothing in it. The totals are
          // sums of the movements, so their currency comes from the movements —
          // see `currencyOf`. A fresh host reports USD, and totalling CLP rows
          // in USD used to take the whole panel down.
          fallbackCurrency: settings?.baseCurrency ?? 'CLP',
          truncated: loaded.truncated,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, month]);

  const [views, viewError] = useMemo<[CurrencyView[], string | undefined]>(() => {
    if (!data) return [[], undefined];
    try {
      return [buildViews(data, month), undefined];
    } catch (err) {
      // A panel that renders nothing at all tells the user less than nothing.
      return [[], err instanceof Error ? err.message : String(err)];
    }
  }, [data, month]);

  const view = views[0]?.view;
  const otherCurrencies = views.slice(1);

  /**
   * Suffix naming the currency a detail card is about.
   *
   * The cards below the summary — categories, merchants, cuotas, non-spending,
   * recurrences, observations — are computed from the leading currency alone,
   * because adding CLP to USD needs a rate the SDK does not publish. The
   * warning that says so appears once, at the top; somebody who arrives by
   * scrolling reads "Gastos por categoría" over figures that are one currency's
   * and not the other's. Empty with a single currency: naming "CLP" on a panel
   * where everything is CLP is noise, not information.
   */
  const scope = otherCurrencies.length > 0 && views[0] ? ` (${views[0].currency})` : '';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Chile</h1>
          <p className="text-muted-foreground text-sm">
            Flujo de caja, categorías y cuotas a partir de tus cartolas importadas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Ver el mes anterior"
            onClick={() => setMonth(addMonthsToKey(month, -1))}
          >
            <span aria-hidden>←</span>
          </Button>
          <span className="min-w-40 text-center text-sm font-medium">{formatMonthKey(month)}</span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Ver el mes siguiente"
            // Nothing has been imported from the future. Walking past the
            // current month only produced empty screens that looked like data
            // loss, and on the reconciliation screen an empty window is
            // indistinguishable from "nothing matched".
            disabled={month >= monthKey(civilToday())}
            onClick={() => setMonth(addMonthsToKey(month, 1))}
          >
            <span aria-hidden>→</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/configuracion')}
          >
            Configuración
          </Button>
          <Button
            variant="outline"
            onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/conciliacion')}
          >
            Conciliación
          </Button>
          <Button onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/importar')}>
            Importar cartola
          </Button>
        </div>
      </header>

      {viewError ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron calcular los totales</AlertTitle>
          <AlertDescription>{viewError}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron cargar los datos</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data?.truncated ? (
        <Alert variant="destructive">
          <AlertTitle>Cifras incompletas</AlertTitle>
          <AlertDescription>
            Este período tiene más movimientos de los que se alcanzaron a leer, así que los totales
            de abajo están por debajo del valor real. Reduce el rango o revisa los movimientos
            directamente en Wealthfolio.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <p className="text-muted-foreground text-sm" role="status">
          Cargando…
        </p>
      ) : null}

      {/* Only when nothing has ever been imported. Keyed on the window alone,
          this card appeared above a populated import history whenever the user
          walked back to a month older than the loaded window: the panel told
          them to import their first statement and listed five imports on the
          same screen. */}
      {!loading && data && data.transactions.length === 0 && data.runs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Todavía no hay movimientos importados</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">
              Importa una cartola para empezar. Los movimientos que importes desde aquí quedan
              marcados y alimentan este panel.
            </p>
            <div>
              <Button
                onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/importar')}
              >
                Importar mi primera cartola
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {view ? (
        <>
          {otherCurrencies.length > 0 ? (
            <Alert>
              <AlertTitle>
                Este mes tiene movimientos en {views.length} monedas
              </AlertTitle>
              <AlertDescription>
                Los totales de abajo son sólo de {views[0]?.currency}. Sumar monedas distintas
                exige un tipo de cambio del día de cada movimiento, que Wealthfolio todavía no
                expone a los addons, así que cada moneda va por separado en vez de dar un total
                inventado.
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Ingresos del mes"
              value={view.summary.income}
              tone="positive"
              hint={
                <DeltaLine
                  delta={view.comparison.income}
                  previousMonth={view.comparison.previousMonth}
                  polarity="more-is-better"
                />
              }
            />
            <Stat
              label="Gasto neto"
              value={view.summary.netSpending}
              tone="negative"
              hint={
                <>
                  {view.summary.refunds.minor > 0 ? (
                    <span className="text-muted-foreground block text-xs font-normal">
                      {formatCLP(view.summary.grossSpending)} menos{' '}
                      {formatCLP(view.summary.refunds)} devueltos
                    </span>
                  ) : null}
                  <DeltaLine
                    delta={view.comparison.netSpending}
                    previousMonth={view.comparison.previousMonth}
                    polarity="more-is-worse"
                  />
                </>
              }
            />
            <Stat
              label="Flujo de caja"
              value={view.summary.netCashFlow}
              tone={view.summary.netCashFlow.minor < 0 ? 'negative' : 'positive'}
              hint={
                <>
                  {view.summary.savingsRate !== undefined ? (
                    <span className="text-muted-foreground block text-xs font-normal">
                      Tasa de ahorro {Math.round(view.summary.savingsRate * 100)}%
                    </span>
                  ) : null}
                  <DeltaLine
                    delta={view.comparison.netCashFlow}
                    previousMonth={view.comparison.previousMonth}
                    polarity="more-is-better"
                  />
                </>
              }
            />
            <Stat
              label="Comprometido en cuotas"
              value={view.outlook.committedTotal}
              hint={
                <span className="text-muted-foreground block text-xs font-normal">
                  {view.outlook.openPlans.length} compra(s) activa(s) · cuotas que faltan por
                  pagar, no el total de la compra
                </span>
              }
            />
          </dl>

          {otherCurrencies.map(({ currency, view: other }) => (
            <Card key={currency}>
              <CardHeader>
                <CardTitle>Movimientos en {currency}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Ingresos"
                    value={other.summary.income}
                    tone="positive"
                    hint={
                      <DeltaLine
                        delta={other.comparison.income}
                        previousMonth={other.comparison.previousMonth}
                        polarity="more-is-better"
                      />
                    }
                  />
                  <Stat
                    label="Gasto neto"
                    value={other.summary.netSpending}
                    tone="negative"
                    hint={
                      <DeltaLine
                        delta={other.comparison.netSpending}
                        previousMonth={other.comparison.previousMonth}
                        polarity="more-is-worse"
                      />
                    }
                  />
                  <Stat
                    label="Flujo de caja"
                    value={other.summary.netCashFlow}
                    tone={other.summary.netCashFlow.minor < 0 ? 'negative' : 'positive'}
                    hint={
                      <DeltaLine
                        delta={other.comparison.netCashFlow}
                        previousMonth={other.comparison.previousMonth}
                        polarity="more-is-better"
                      />
                    }
                  />
                  {/* A count where the leading block carries the cuota
                      commitment. Two blocks drawn alike invite comparison, and
                      these two were not comparable: the fourth figure answered
                      a different question on each side. */}
                  <Stat
                    label="Comprometido en cuotas"
                    value={other.outlook.committedTotal}
                    hint={
                      <span className="text-muted-foreground block text-xs font-normal">
                        {other.outlook.openPlans.length} compra(s) activa(s) · cuotas que faltan
                        por pagar, no el total de la compra
                      </span>
                    }
                  />
                </dl>
              </CardContent>
            </Card>
          ))}

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Gastos por categoría{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {view.categories.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin gastos este mes.</p>
                ) : (
                  view.categories.slice(0, 8).map((entry) => (
                    <div key={entry.category} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span>{categoryPath(entry.category)}</span>
                        <Amount value={entry.amount} />
                      </div>
                      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                        <div
                          className="bg-primary h-full"
                          style={{ width: `${Math.round(entry.share * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
                {/* Fixed and variable used to sit under "Movimientos que no son
                    gasto", a card whose title denied they were spending at all.
                    They are the same month's spending seen another way, so they
                    belong beside the categories. */}
                <Separator />
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span>Gastos fijos</span>
                  <Amount value={view.summary.fixedExpenses} />
                </div>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span>Gastos variables</span>
                  <Amount value={view.summary.variableExpenses} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Comercios principales{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {view.merchants.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin comercios este mes.</p>
                ) : (
                  view.merchants.map((entry) => (
                    <div
                      key={entry.merchant}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span>
                        {entry.merchant}
                        <span className="text-muted-foreground ml-2 text-xs">
                          {entry.transactionCount}×
                        </span>
                      </span>
                      <Amount value={entry.amount} />
                    </div>
                  ))
                )}
                {/* What the ranking leaves out, said out loud. Filed under a
                    shared "Sin comercio" row it fused unrelated movements and
                    competed for the top of the list. */}
                {view.unattributed.transactionCount > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    Además <Amount value={view.unattributed.amount} /> en{' '}
                    {view.unattributed.transactionCount} movimiento(s) sin comercio identificado.
                  </p>
                ) : null}
                {/* Why, when there is a why. A charge routed through Mercado
                    Pago is not a mystery: it is a payment method that by design
                    does not report who was paid — the bank's own glosario says
                    as much to its customers — and that is something a person
                    can act on. The processor is named as an explanation, never
                    as a row of the ranking. */}
                {view.unattributedProcessors.map((group) => (
                  <p key={group.processor} className="text-muted-foreground text-xs">
                    <Amount value={group.amount} /> pasó por {group.processor}, que no informa el
                    comercio ({group.transactionCount} movimiento(s)).
                  </p>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Cuotas comprometidas{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {view.outlook.schedule.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No se detectaron compras en cuotas pendientes.
                  </p>
                ) : (
                  <>
                    {view.outlook.schedule.slice(0, 6).map((entry) => (
                      <div
                        key={entry.month}
                        className="flex items-baseline justify-between gap-2 text-sm"
                      >
                        <span>{formatMonthKey(entry.month)}</span>
                        <Amount value={entry.amount} />
                      </div>
                    ))}
                    <Separator />
                    {view.outlook.openPlans.slice(0, 5).map((plan) => (
                      <div key={plan.id} className="flex items-baseline justify-between gap-2 text-xs">
                        <span>
                          {plan.merchant}{' '}
                          <span className="text-muted-foreground">
                            {plan.currentInstallment}/{plan.totalInstallments}
                          </span>
                          {plan.confidence !== Confidence.confirmed || plan.hasGaps ? (
                            <Badge variant="outline" className="ml-2">
                              estimado
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          quedan {formatCLP(plan.remainingAmount)}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Movimientos que no son gasto{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>Transferencias entre cuentas propias</span>
                  <Amount value={view.summary.internalTransfers} />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span>Pagos de tarjeta de crédito</span>
                  <Amount value={view.summary.cardPayments} />
                </div>
                <p className="text-muted-foreground text-xs">
                  Ninguno de estos montos se cuenta como ingreso ni como gasto: mueven dinero que ya
                  tenías.
                </p>
              </CardContent>
            </Card>
          </section>

          {view.financialCosts.items.length > 0 || view.financialCosts.cashAdvanceCount > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Costos financieros{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {/* Not a total beside the spending: a view of it. Every peso
                    here is already inside the month's gross spending, which is
                    why the card says what it is a part of before it shows a
                    figure. */}
                <p className="text-muted-foreground text-xs">
                  Parte del gasto del mes, no algo aparte: es lo que costó el crédito, separado de
                  lo que compraste con él.
                </p>

                {view.financialCosts.items.length > 0 ? (
                  <>
                    <div className="flex items-baseline justify-between gap-2 font-medium">
                      <span>Total</span>
                      <Amount value={view.financialCosts.total} />
                    </div>
                    <Separator />
                    <div className="flex items-baseline justify-between gap-2">
                      <span>Por deber</span>
                      <Amount value={view.financialCosts.borrowing} />
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span>Por tener el instrumento</span>
                      <Amount value={view.financialCosts.instrument} />
                    </div>
                    <Separator />
                    {view.financialCosts.items.map((item) => (
                      <div
                        key={item.kind}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="text-muted-foreground">
                          {financialCostLabel(item.kind)}
                          {item.transactionCount > 1 ? ` · ${item.transactionCount} cargos` : ''}
                        </span>
                        <Amount value={item.amount} />
                      </div>
                    ))}
                  </>
                ) : null}

                {/* Beside the costs, never inside them. An avance is the debt
                    itself, and adding it would report drawing $200.000 as
                    $200.000 of cost — but it is usually the line that explains
                    why there was interest at all. */}
                {view.financialCosts.cashAdvanceCount > 0 ? (
                  <>
                    <Separator />
                    <div className="flex items-baseline justify-between gap-2">
                      <span>
                        Avance en efectivo
                        <span className="text-muted-foreground block text-xs">
                          {view.financialCosts.cashAdvanceCount} operación(es) · dinero prestado
                          contra el cupo, no un costo
                        </span>
                      </span>
                      <Amount value={view.financialCosts.cashAdvances} />
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {view.recurring.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Gastos que se repiten{scope}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {/* The addon never sees a contract. Everything here is read off
                    the statement, so the card says so before it says anything
                    else — a charge the core only calls `likely` was drawn with
                    no qualifier at all, which made the strongest claim the only
                    unhedged one, and both evidence levels shared one flat list
                    so a habit looked like a commitment. */}
                <p className="text-muted-foreground text-xs">
                  Repeticiones deducidas de tus cartolas. Wealthfolio Chile no ve tus contratos:
                  cada fila muestra la evidencia con la que se afirma.
                </p>

                <RecurringGroup charges={view.recurring.filter((c) => c.confidence === 'likely')} />

                {view.recurring.some((c) => c.confidence === 'possible') ? (
                  <>
                    <Separator />
                    <p className="text-muted-foreground text-xs font-medium">
                      Podrían repetirse — evidencia más débil
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Se repiten con una cadencia parecida pero el monto varía, o el mismo día hubo
                      más de un cargo del mismo comercio.
                    </p>
                    <RecurringGroup
                      charges={view.recurring.filter((c) => c.confidence === 'possible')}
                    />
                  </>
                ) : null}

                <p className="text-muted-foreground text-xs">
                  Las compras en cuotas no aparecen aquí: son un compromiso que termina solo, no un
                  gasto que se repite. Tampoco los traspasos entre tus cuentas ni los pagos de
                  tarjeta.
                </p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Observaciones{scope}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {view.insights.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Necesitamos al menos dos meses de datos para comparar tendencias.
                </p>
              ) : (
                view.insights.map((insight) => <InsightRow key={insight.id} insight={insight} />)
              )}
            </CardContent>
          </Card>

          {data && data.runs.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Últimas importaciones</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {data.runs.slice(0, 5).map((run) => (
                  <div key={run.id} className="flex items-baseline justify-between gap-2">
                    <span>
                      {run.fileName}
                      <span className="text-muted-foreground ml-2 text-xs">
                        {run.institution} · {run.timestamp.slice(0, 10)}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {run.importedRows} importados
                    </span>
                  </div>
                ))}
                <div>
                  <Button
                    variant="link"
                    className="px-0"
                    onClick={() =>
                      ctx.api.navigation.navigate('/addons/wealthfolio-chile/importaciones')
                    }
                  >
                    Ver historial completo
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One evidence tier of the recurring-charge card.
 *
 * The rows carry the evidence rather than a verdict badge: the tier they sit
 * under already says how strong the claim is, so a per-row "posible" marker
 * only repeated the heading — and its absence on the stronger rows was what
 * made those read as established fact.
 */
function RecurringGroup({
  charges,
}: {
  charges: ReturnType<typeof findRecurringCharges>;
}) {
  return (
    <>
      {charges.slice(0, 8).map((charge) => (
        <div
          key={`${charge.currency} ${charge.merchantKey}`}
          className="flex items-baseline justify-between gap-2"
        >
          <span>
            {charge.merchant}
            {charge.mandate ? (
              <Badge variant="outline" className="ml-2">
                {charge.mandate.toUpperCase()}
              </Badge>
            ) : null}
            {/* The evidence, not just the verdict: a reader can check the claim
                against their own statement. */}
            <span className="text-muted-foreground block text-xs">
              {charge.occurrences} cargos · cada{' '}
              {charge.minIntervalDays === charge.maxIntervalDays
                ? `${charge.medianIntervalDays}`
                : `${charge.minIntervalDays}–${charge.maxIntervalDays}`}{' '}
              días · monto ±{Math.round(charge.amountSpread * 100)} %
              {charge.mandate ? ` · ${mandateLabel(charge.mandate)}` : ''}
            </span>
          </span>
          <Amount value={charge.typicalAmount} />
        </div>
      ))}
    </>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const tone =
    insight.severity === 'attention'
      ? 'border-l-destructive'
      : insight.severity === 'positive'
        ? 'border-l-success'
        : 'border-l-muted-foreground';
  return (
    <div className={`border-l-2 pl-3 ${tone}`}>
      <p className="text-sm">{insight.message}</p>
      {insight.detail ? (
        <p className="text-muted-foreground text-xs">{insight.detail}</p>
      ) : null}
    </div>
  );
}

interface CurrencyView {
  currency: string;
  view: DashboardView;
}

interface DashboardView {
  summary: ReturnType<typeof summarizeMonth>;
  categories: ReturnType<typeof totalsByCategory>;
  merchants: ReturnType<typeof totalsByMerchant>;
  unattributed: ReturnType<typeof unattributedSpending>;
  unattributedProcessors: ReturnType<typeof unattributedByProcessor>;
  financialCosts: ReturnType<typeof financialCostBreakdown>;
  recurring: ReturnType<typeof findRecurringCharges>;
  outlook: ReturnType<typeof buildOutlook>;
  insights: Insight[];
  comparison: MonthlyComparison;
}

/**
 * One view per currency present.
 *
 * Totalling CLP and USD needs an exchange rate the SDK does not publish a
 * historical one for, so the panel does not try: it shows each currency's own
 * figures side by side. Before this, a single dollar movement made
 * `currencyOf` throw and replaced the entire panel — peso totals included —
 * with an error message.
 *
 * Ordered so the currency with the most movements leads.
 */
function buildViews(data: DashboardData, month: string): CurrencyView[] {
  const inMonth = data.transactions.filter((t) => monthKey(t.date) === month);
  const previousMonth = addMonthsToKey(month, -1);

  return summarizeByCurrency(month, inMonth, { fallbackCurrency: data.fallbackCurrency }).map(
    ({ currency, summary, transactions }) => {
      const history = data.transactions.filter((t) => t.amount.currency === currency);
      const inPrevious = history.filter((t) => monthKey(t.date) === previousMonth);
      const previousSummary = summarizeMonth(previousMonth, inPrevious, { currency });

      const categories = totalsByCategory(transactions, { currency });
      const previousCategories = totalsByCategory(inPrevious, { currency });
      const merchants = totalsByMerchant(transactions, 8, { currency });
      const unattributed = unattributedSpending(transactions, { currency });
      const financialCosts = financialCostBreakdown(transactions, { currency });
      const unattributedProcessors = unattributedByProcessor(transactions);
      // A monthly pattern that has not charged in this or the previous month is
      // historical evidence, not a current recurring expense.
      const recurring = findRecurringCharges(history).filter(
        (charge) => monthKey(charge.lastDate) >= previousMonth,
      );

      const plans = buildInstallmentPlans(history);
      const outlook = buildOutlook(plans, month, 12, currency);

      const insights = buildInsights({
        month,
        current: summary,
        ...(inPrevious.length > 0 ? { previous: previousSummary } : {}),
        categories,
        ...(inPrevious.length > 0 ? { previousCategories } : {}),
        merchants,
        recurring,
        installments: outlook,
      });

      return {
        currency,
        view: {
          summary,
          categories,
          merchants,
          unattributed,
          unattributedProcessors,
          financialCosts,
          recurring,
          outlook,
          insights,
          // `undefined` rather than a zero summary when the previous month holds
          // no movement in this currency: "there was nothing" and "it was zero"
          // are different claims, and only the second one can carry a delta.
          comparison: compareMonths(summary, inPrevious.length > 0 ? previousSummary : undefined),
        },
      };
    },
  );
}

