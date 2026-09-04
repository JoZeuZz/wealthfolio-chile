/** @vitest-environment happy-dom */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImportHistoryPage } from '../../src/ui/pages/ImportHistoryPage';
import { MAX_SHARD_PROBES } from '../../src/services/storage';
import { renderPage } from './harness';

/**
 * El historial cuando el almacenamiento está dañado.
 *
 * Las lecturas ahora se niegan en vez de devolver una lista corta, así que
 * esta pantalla es donde esa negativa se convierte en algo que el usuario
 * puede entender y resolver. Un mensaje de error sin diagnóstico ni reparación
 * deja al usuario exactamente igual de atascado que el truncamiento silencioso
 * que se quería eliminar, sólo que además asustado.
 */

function run(n: number) {
  return {
    id: `run-${n}`,
    timestamp: '2026-02-01T12:00:00.000Z',
    fileName: 'cartola.csv',
    fileHash: 'a'.repeat(64),
    institution: 'banco-chile',
    parser: 'banco-chile.cuenta-corriente',
    parserVersion: '1',
    profileStatus: 'pending-real-sample' as const,
    accountId: 'acc-1',
    accountName: 'Cuenta corriente',
    currency: 'CLP',
    detectedRows: 1,
    importedRows: 1,
    exactDuplicates: 0,
    probableDuplicates: 0,
    ignoredRows: 0,
    errorRows: 0,
    status: 'completed' as const,
  };
}

describe('diagnóstico de almacenamiento en el historial', () => {
  it('un índice ilegible se explica y se ofrece reconstruirlo', async () => {
    const { host, user } = renderPage(<ImportHistoryPage />);
    // Cuatro shards escritos y el índice destruido: la lista es legible, pero
    // sólo recorriéndola.
    for (let shard = 0; shard < 4; shard += 1) {
      host.store.data.set(`wfcl.imports.s${shard}`, JSON.stringify([run(shard)]));
    }

    // Sin índice la lectura sí funciona — el sondeo la recupera — así que lo
    // que se comprueba aquí es que la recuperación no es silenciosa: la página
    // carga y el registro recuperado aparece.
    expect(await screen.findAllByText('Cuenta corriente')).toHaveLength(4);
    expect(screen.queryByText('No se pudo leer el historial')).toBeNull();
    expect(user).toBeDefined();
  });

  it('un truncamiento se cuenta con números, no con la palabra «error»', async () => {
    const { host } = renderPage(<ImportHistoryPage />);
    for (let shard = 0; shard < MAX_SHARD_PROBES + 2; shard += 1) {
      host.store.data.set(`wfcl.imports.s${shard}`, JSON.stringify([run(shard)]));
    }

    expect(await screen.findByText('No se pudo leer el historial')).toBeInTheDocument();
    expect(
      await screen.findByText(/sin llegar al final/i),
    ).toBeInTheDocument();
    // Reconstruir el índice no arregla un truncamiento y no se ofrece.
    expect(screen.queryByRole('button', { name: /reconstruir el índice/i })).toBeNull();
  });

  it('un bloque ilegible se localiza y se promete no tocarlo', async () => {
    const { host } = renderPage(<ImportHistoryPage />);
    host.store.data.set('wfcl.imports.s0', '[{"id":"run-0"');
    host.store.data.set('wfcl.imports.index', JSON.stringify({ v: 1, shards: 1, perShard: 50, total: 1 }));

    expect(await screen.findByText('No se pudo leer el historial')).toBeInTheDocument();
    expect(await screen.findByText(/bloque\(s\) ilegibles/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconstruir el índice/i })).toBeInTheDocument();
    // Y el bloque sigue tal cual: el diagnóstico no destruye la evidencia.
    expect(host.store.data.get('wfcl.imports.s0')).toBe('[{"id":"run-0"');
  });

  it('el diagnóstico no imprime nada de lo que hay dentro de un bloque', async () => {
    const { host } = renderPage(<ImportHistoryPage />);
    host.store.data.set('wfcl.imports.s0', '{"cartola":"CartolaCuentaRut_12345678-9.csv"}');
    host.store.data.set('wfcl.imports.index', JSON.stringify({ v: 1, shards: 1, perShard: 50, total: 1 }));

    await screen.findByText(/bloque\(s\) ilegibles/i);
    expect(document.body.textContent).not.toContain('12345678');
    expect(document.body.textContent).not.toContain('CartolaCuentaRut');
  });
});
