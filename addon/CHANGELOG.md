# Changelog

## 0.1.1 — 2026-08-06

Estabilización de las fronteras con el host. Sin funcionalidad nueva de cara al
usuario; tres correcciones que afectaban directamente la integridad de los datos.

### Corregido

- **El signo se perdía al releer una actividad.** Wealthfolio guarda un monto sin
  signo y expresa la dirección en el `activityType`. Al reconstruir el índice de
  duplicados el signo no se recuperaba, así que un gasto de `-85.400` se comparaba
  contra `+85.400` y **ningún duplicado probable se detectaba**. La huella exacta
  seguía funcionando, que es por qué el error no se notaba. La semántica de signos
  vive ahora en una sola función (`activityDetailsToSignedMoney`) y ya no está
  duplicada entre el panel y el índice.
- **Filtro de fechas inexistente.** Se enviaban `startDate`/`endDate` a
  `activities.search`; v3.6.2 lee `dateFrom`/`dateTo`. Los filtros se ignoraban en
  silencio y toda consulta escaneaba la cuenta completa.
- **El wizard quedaba en blanco si fallaba la lectura de duplicados.** Ahora el
  parseo, el índice de duplicados y el permiso de importar son tres estados
  distintos: la vista previa se muestra igual, **Confirmar queda deshabilitado** y
  hay un botón Reintentar. Ya no existe respaldo silencioso a un índice vacío,
  porque importar sin comprobar duplicados puede duplicar dinero.
- **Una importación parcial se anunciaba como éxito.** `partial` y `failed` ya no
  muestran el toast verde, y el resumen distingue creados, fallidos al escribir,
  duplicados exactos, posibles duplicados, ignorados por regla y desmarcados por
  el usuario — antes todo eso era «omitidos».
- **Un fallo al guardar el historial anulaba una importación exitosa.** Ahora se
  reporta aparte: los movimientos quedan escritos y el usuario ve que el historial
  no se actualizó.
- **El panel podía mostrar cifras incompletas en silencio** al superar su límite
  de páginas. Ahora consulta sólo la ventana temporal que necesita y avisa cuando
  no alcanzó a leerlo todo.
- **Licencia inconsistente**: el README decía «sin definir» y los manifiestos
  decían MIT. Ambos declaran `UNLICENSED`, coherente con la decisión D13. Elegir
  licencia sigue pendiente y es del propietario.

### Añadido

- `services/reconciliation.ts`: fachada de orquestación para la conciliación
  multi-cuenta. No añade funcionalidad — mantiene `prepareImport()` puro y deja
  documentado dónde entra el host.
- 95 tests nuevos (280 en total), los primeros sobre `services/` con un doble
  mínimo del host: `activity-index`, `import-runner`, `import-preparation`,
  `imported-transactions`, `storage` y el round-trip de signos.

## 0.1.0 — 2026-08-05

Primera versión. Motor de importación completo; formatos bancarios pendientes de
calibrar con cartolas reales.

### Añadido

- **Modelo canónico** de transacción, independiente de las columnas de cualquier
  banco y del modelo de actividades de Wealthfolio.
- **Aritmética exacta de dinero**: enteros de unidades menores con escala por
  valor. Nunca floats.
- **Fechas civiles** sobre `YYYY-MM-DD` y aritmética entera, inmunes a la zona
  horaria de la máquina.
- **Lectura de CSV, TXT, XLSX y XLS heredado**, con detección de delimitador por
  consistencia y respaldo a Windows-1252.
- **Adaptadores** para Banco de Chile, BancoEstado y Falabella/CMR, más dos
  genéricos. Marcados `pending-real-sample`.
- **Detección de parser** con evidencia estructural (columna de saldo ⇒ cuenta;
  columna de cuotas ⇒ tarjeta) además de la léxica.
- **Idempotencia**: huella determinista guardada en la metadata de la actividad.
  Reimportar el mismo archivo produce cero movimientos nuevos.
- **Motor de conciliación** de transferencias entre cuentas propias y de pagos de
  tarjeta, con niveles de confianza y sin emparejar automáticamente lo dudoso.
  Implementado y testeado; todavía **no integrado** al flujo de importación, que
  ve una sola cuenta por vez.
- **Normalización de comercios**: separa procesador de pago, verbo bancario,
  ruido de referencia y comuna.
- **Motor de reglas** condición → acción, determinista y auditable, con 24
  reglas predefinidas para vocabulario bancario chileno.
- **Motor de cuotas**: detecta cuotas, reconstruye planes y proyecta lo
  comprometido mes a mes.
- **Métricas e insights** deterministas.
- **Wizard de importación** en 4 pasos con vista previa obligatoria.
- **Panel Chile** y **historial de importaciones**.
- **Redacción de logs**: el addon nunca llama al logger del host directamente.

### Notas

- El bundle incluye SheetJS (~700 KB) porque el host no lo provee. Ver
  ADR 0004.
- La categorización es propia: el subsistema `spending` del core existe pero no
  está expuesto al SDK. Ver ADR 0003.
