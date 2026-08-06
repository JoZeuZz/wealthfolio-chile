import { Button } from '@wealthfolio/ui';
import { useCallback, useRef, useState } from 'react';
import type { SourceFile } from '../../core/parsing/tabular';

/**
 * File input for the import wizard.
 *
 * The addon runs in an `allow-scripts` sandboxed iframe with an opaque origin,
 * and the host's `files.openCsvDialog()` returns only a *path* — there is no
 * API to read a file's bytes. So the file has to enter through the DOM: a file
 * input or a drop target, read with `File.arrayBuffer()`.
 *
 * That turns out to be the better design anyway. The bytes never leave the
 * sandbox, and the addon needs no `files` permission at all.
 */

const ACCEPTED = '.csv,.txt,.tsv,.xlsx,.xls';

export function FileDrop({
  onFile,
  disabled = false,
}: {
  onFile: (file: SourceFile) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(undefined);
      try {
        const buffer = await file.arrayBuffer();
        onFile({ name: file.name, bytes: new Uint8Array(buffer) });
      } catch {
        setError('No se pudo leer el archivo. Intenta seleccionarlo de nuevo.');
      }
    },
    [onFile],
  );

  return (
    <div className="flex flex-col gap-2">
      <div
        className={[
          'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25',
          disabled ? 'pointer-events-none opacity-60' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void accept(event.dataTransfer?.files?.[0]);
        }}
      >
        <p className="text-sm font-medium">Arrastra tu cartola aquí</p>
        <p className="text-muted-foreground text-xs">
          CSV, TXT o XLSX. El archivo se procesa dentro de la aplicación y no se envía a ningún
          servidor.
        </p>
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={disabled}>
          Seleccionar archivo
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(event) => {
            void accept(event.target.files?.[0]);
            // Reset so selecting the same file twice fires onChange again.
            event.target.value = '';
          }}
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}
