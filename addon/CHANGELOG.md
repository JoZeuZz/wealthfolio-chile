# Changelog

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
- **Conciliación** de transferencias entre cuentas propias y de pagos de
  tarjeta, con niveles de confianza y sin emparejar automáticamente lo dudoso.
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
