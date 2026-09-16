# Changelog

## 0.2.0-rc.6 — 2026-09-16

Calibración estructural contra cartolas reales para BancoEstado, Banco de
Chile (cuenta corriente y tarjeta nacional) y Falabella/CMR, más el
endurecimiento que salió de esa calibración. "Calibración estructural real"
significa que el calibrador (`pnpm calibrate`) corrió fuera del host contra
cartolas privadas y nunca expuso glosas — **ningún archivo bancario real fue
importado a un Wealthfolio corriendo**; la validación contra el host sigue
usando fixtures sintéticos con la misma forma. Sigue siendo release candidate:
la clasificación (`kind`) de cada movimiento no está confirmada contra ningún
banco real, y Falabella/cuenta corriente no tiene ninguna cartola real todavía.

### Añadido

- **Calibrador (`pnpm calibrate`)**: reporta hechos sanitizados de una cartola
  real sin exponer glosas — forma de columnas no mapeadas, formato numérico
  por celda, evidencia de cuotas, y ahora también evidencia de estados de
  cuenta PDF vía `pdfjs-dist` (extracción de texto, devDependency, nunca en
  `dist/addon.js`; `pdf-lib` no participa del calibrador, sólo genera PDFs
  sintéticos para tests). PDF de CMR es **sólo calibrable, no importable**
  esta tranche — demasiada arquitectura nueva para resolver junto con el
  resto.
- Fechas civiles `dd/mm` sin año, resueltas contra el período declarado por la
  propia cartola (`SALDO INICIAL`/`SALDO FINAL` en Banco de Chile cuenta
  corriente).

### Corregido

**Banco de Chile — cuenta corriente**
- Período derivado de las filas `SALDO INICIAL`/`SALDO FINAL`; saldo recorrido
  como evidencia, sumando cada movimiento desde el último saldo declarado.
- Formato numérico y canal/sucursal confirmados contra XLS real.

**Banco de Chile — tarjeta**
- Detección Nacional vs. Internacional endurecida: exige firma internacional
  completa antes de tratar una cartola como tal, prefiere branding explícito
  del emisor sobre pistas de layout, y usa el preámbulo del workbook como
  evidencia adicional. Las tablas de movimientos internacionales se bloquean
  explícitamente en cualquier hoja del workbook — **Internacional no se
  soporta**, no se importa nunca, sólo se detecta para bloquear con la razón
  correcta.
- Formato numérico resuelto desde metadata de celda en vez de asumir
  convención regional; falla cerrado ante un formato de planilla inseguro en
  vez de adivinar el monto.
- Boundary de escritura endurecido: la validación se aplica también ahí, no
  sólo en el preview.
- Dedupe endurecido contra conflictos de fuente legacy (huellas de una versión
  anterior del fingerprint): se tratan como no importables en vez de
  colisionar en silencio, y el resumen de importación reporta el conflicto
  filtrado con precisión.
- Errores de dirección y de parseo de monto sanitizados: nunca filtran el
  valor crudo de la celda hacia logs o mensajes.

**Falabella / CMR**
- Firma estructural propia (layout, no sólo texto de marca) para detectar CMR
  sin depender de branding.
- `PAGO TARJETA` (glosa propia del lado tarjeta de un pago) reconocido y
  separado de gasto — antes podía contarse como consumo.
- Se exige que la descripción de pago de tarjeta sea explícita: una coincidencia
  parcial ya no basta para clasificar un movimiento como pago.
- Cuotas: `VALOR CUOTA` (cargo del ciclo) distinguido de `MONTO` (compra
  completa). De 130 filas calibradas, en 128 ambos campos coinciden; en las 2
  filas de cuotas activas difieren, y esa diferencia — junto con la
  repetición longitudinal del mismo plan — confirmó que `MONTO` es el total
  original de la compra y `VALOR CUOTA` el cargo facturado del ciclo. Una
  Activity por cuota facturada, no por compra. `CUOTAS PENDIENTES` se lee
  como el conteo de cuotas restantes, no como un par `n de m`.
- El siguiente ciclo de una cuota ya no se confunde con un duplicado exacto de
  la cuota anterior: `installmentRemaining` distingue ambos ciclos aunque el
  resto de la fila coincida.
- Metadata de cuota obsoleta ya no puede ganarle a una edición del usuario en
  el host: el dedupe ignora la metadata de cuotas que el host contradice en
  vez de confiar en la caché.
- Reimportar exactamente el mismo archivo sigue siendo idempotente en todos
  estos casos — verificado con tests de regresión, no sólo con el caso feliz.

**Transversal**
- Freshness de metadata unificada entre todos los lectores del host: la
  pregunta "¿esto sigue siendo lo que escribimos, o el usuario lo cambió?" se
  resuelve una sola vez, no una vez por lector.
- Consola de `pdfjs-dist` suprimida durante la calibración: el propio texto
  del documento podía llegar a `warn()`/`error()` sin pasar por el
  redactor de logs del addon.

### Cambiado

- Ningún cambio de `minWealthfolioVersion` (se mantiene en 3.7.0) ni de
  dependencias runtime. `pdfjs-dist` entra sólo como devDependency del
  calibrador; `pdf-lib` entra sólo como devDependency de tests, para generar
  fixtures PDF sintéticos. Ninguna de las dos entra a `dist/addon.js`.

### Validación

- Host validation adicional documentada para Banco de Chile (cuenta y
  tarjeta) y Falabella/CMR tras cada tranche de hardening — sobre fixtures
  sintéticos, nunca con la cartola real que motivó el fix. Detalle sesión por
  sesión en [docs/HOST_VALIDATION.md](../docs/HOST_VALIDATION.md).
- Review independiente (P0/P1) sobre el estado real-sample de README y CMR:
  0 P0 nuevos, 0 P1 nuevos tras las correcciones de esta tranche.

## 0.2.0-rc.5 — 2026-09-09

### Corregido

- **`INTEREST` crudo en una cuenta de tarjeta se leía siempre como ingreso.**
  El bug era independiente de la versión del host: `activityFlowSign` no
  distinguía por tipo de cuenta, así que un interés cobrado que llegó a la
  tarjeta como `INTEREST` (edición manual en Wealthfolio, u otra vía) contaba
  como ingreso en vez de costo financiero. Corregido en tres partes: (1) la
  lectura ahora trata un `INTEREST` en `CREDIT_CARD` como cargo por defecto;
  (2) la escritura deja de producir esa combinación — un interés entrante
  clasificado por una regla de usuario en cuenta tarjeta se sustituye a
  `CREDIT` en vez de escribirse como `INTEREST` crudo, y el índice de
  duplicados propaga el tipo de cuenta igual que ya lo hacía el resto del
  pipeline; (3) una fila que el propio addon ya había escrito como ingreso en
  una versión anterior a este fix conserva esa dirección mientras la caché de
  metadata siga vigente, en vez de invertirse por el nuevo default. Ver
  [docs/UPSTREAM.md](../docs/UPSTREAM.md) § *Semántica financiera del host*
  para el detalle y el límite conocido pendiente para la migración a 3.8.

### Cambiado

- Tooling de build migrado a `@wealthfolio/addon-sdk`/`@wealthfolio/ui`/
  `@wealthfolio/addon-dev-tools` 3.8.0. `minWealthfolioVersion` se mantiene en
  3.7.0: ninguna superficie 3.8-only se usa. Ver
  [docs/UPSTREAM.md](../docs/UPSTREAM.md).

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
- **El signo se perdía también en los tipos sin dirección.** Wealthfolio no da
  dirección semántica a `UNKNOWN`, `ADJUSTMENT` ni `SPLIT`, y como escribimos
  siempre la magnitud, un cargo `unknown / out / -4.500` llegaba al host como
  `UNKNOWN +4.500` y volvía como ingreso de `+4.500`. El mapping no era
  reversible y el índice de duplicados no encontraba nada. La metadata sube a
  `v: 2` y guarda `dir` (`"in"`/`"out"`), que la lectura consulta **sólo** para
  esos tipos: para los once tipos con dirección documentada manda el
  `activityType` y la metadata no puede contradecirlo. Las actividades escritas
  por 0.1.0/0.1.1, sin `dir`, conservan el comportamiento anterior.
- **Una importación correcta podía anunciarse como fallida.** Si los movimientos
  se escribían bien pero el historial no, el wizard mostraba a la vez el toast
  verde y una alerta roja «No se pudo continuar», sugiriendo repetir una
  importación que no lo necesitaba. Ahora el resultado separa tres cosas: fallo
  (faltan movimientos), advertencia (el ledger está bien, algo alrededor no) y
  detalle por fila. El error global queda sólo para la excepción que impide
  saber si se escribió algo.
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
- `ui/import-outcome.ts`: la decisión de qué mostrar al terminar una corrida,
  como función pura y testeable, fuera del JSX del wizard.
- 116 tests nuevos (301 en total), los primeros sobre `services/` y sobre la
  semántica visual del wizard, con un doble mínimo del host: `activity-index`,
  `import-runner`, `import-preparation`, `imported-transactions`, `storage`,
  `import-outcome` y el round-trip de signos.

### Documentado

- `docs/UPSTREAM.md` corrige su propia afirmación sobre `saveMany`: el lote es
  **atómico**, así que cada entrada de `result.errors` corresponde siempre a
  filas no creadas y una fila mala cuesta su lote entero. El comentario de
  `import-runner` decía lo contrario; se ajustó el comentario, no el
  comportamiento.

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
