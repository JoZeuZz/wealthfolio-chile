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
import { useEffect, useState } from 'react';
import { ImportHistory, type ImportRun } from '../../services/import-history';
import { useAddon } from '../context';

/**
 * The import history.
 *
 * Answers "what did I already load, and can I trust it?" — file hash, parser
 * version and counts. The statement itself is never stored; see docs/PRIVACY.md
 * for why that is a deliberate choice rather than a missing feature.
 */
export function ImportHistoryPage() {
  const ctx = useAddon();
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const recent = await ImportHistory.from(ctx).recent(100);
        if (!cancelled) setRuns(recent);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Importaciones</h1>
          <p className="text-muted-foreground text-sm">
            Registro de cada cartola procesada. No se guarda el archivo original, solo su huella.
          </p>
        </div>
        <Button onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/importar')}>
          Importar cartola
        </Button>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudo leer el historial</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? <p className="text-muted-foreground text-sm">Cargando…</p> : null}

      {!loading && runs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Sin importaciones todavía</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Cuando importes tu primera cartola aparecerá aquí.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {runs.length > 0 ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="p-3">Fecha</th>
                  <th className="p-3">Archivo</th>
                  <th className="p-3">Banco / cuenta</th>
                  <th className="p-3">Período</th>
                  <th className="p-3">Parser</th>
                  <th className="p-3 text-right">Omitidas</th>
                  <th className="p-3 text-right">Detectados</th>
                  <th className="p-3 text-right">Creados</th>
                  <th className="p-3 text-right">Fallidos</th>
                  <th className="p-3 text-right">Duplicados</th>
                  <th className="p-3 text-right">Ignorados</th>
                  <th className="p-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b align-top">
                    <td className="p-3 whitespace-nowrap tabular-nums">
                      {run.timestamp.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col">
                        <span>{run.fileName}</span>
                        <span
                          className="text-muted-foreground font-mono text-xs"
                          title={run.fileHash}
                        >
                          {run.fileHash.slice(0, 12)}…
                        </span>
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col">
                        <span>{run.institution}</span>
                        <span className="text-muted-foreground text-xs">{run.accountName}</span>
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap text-xs">
                      {run.periodFrom && run.periodTo
                        ? `${run.periodFrom} → ${run.periodTo}`
                        : '—'}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col">
                        <span className="text-xs">{run.parser}</span>
                        <span className="text-muted-foreground text-xs">v{run.parserVersion}</span>
                        {run.profileStatus === 'pending-real-sample' ? (
                          <Badge variant="outline" className="mt-1 w-fit">
                            sin validar
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{run.skippedRows ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums">{run.detectedRows}</td>
                    <td className="p-3 text-right tabular-nums">{run.importedRows}</td>
                    <td className="p-3 text-right tabular-nums">
                      {/* Runs recorded before v0.1.1 did not separate write failures. */}
                      {run.failedRows ?? '—'}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {run.exactDuplicates + run.probableDuplicates}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {run.ignoredRows + (run.deselectedRows ?? 0)}
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={
                          run.status === 'completed'
                            ? 'secondary'
                            : run.status === 'partial'
                              ? 'outline'
                              : 'destructive'
                        }
                        title={run.message}
                      >
                        {statusLabel(run.status)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function statusLabel(status: ImportRun['status']): string {
  switch (status) {
    case 'completed':
      return 'Completada';
    case 'partial':
      return 'Parcial';
    default:
      return 'Fallida';
  }
}
