# Roadmap

| Estado | Significado |
| --- | --- |
| ✅ | Hecho y verificado con tests |
| ⚠️ | Implementado, pendiente de validación con datos o entorno reales |
| ⬜ | No empezado |

---

## MVP

| Fase | Qué | Estado |
| --- | --- | --- |
| F0 | Discovery de upstream | ✅ [UPSTREAM.md](UPSTREAM.md) |
| F1 | Bootstrap del repositorio | ✅ |
| F2 | Entorno Docker de Wealthfolio | ✅ ejecutado contra 3.6.2, 3.7.0 (referencia) y 3.8.0 (smoke) |
| F3 | Scaffold del addon | ✅ CLI oficial, 3 rutas, permisos mínimos |
| F4 | Modelo financiero canónico | ✅ |
| F5 | Ingesta CSV / TXT / XLSX / XLS | ✅ |
| F6 | Vista previa de importación | ✅ |
| F7 | Deduplicación | ✅ |
| F8 | Adaptador Banco de Chile | ⚠️ cuenta y tarjeta con fixture y test; cuenta validada en host; sin cartola real |
| F9 | Adaptador BancoEstado | ⚠️ validado en host; sin cartola real |
| F10 | Adaptador Falabella / CMR | ⚠️ tarjeta validada en host; cuenta con fixture y test; sin cartola real. El significado de la columna de monto en una fila en cuotas sigue sin evidencia |
| F11 | Historial de importaciones | ✅ |

---

## MVP+1

| Fase | Qué | Estado |
| --- | --- | --- |
| F12 | Conciliación de transferencias internas | ⚠️ motor ✅ (emparejamiento mutuo iterativo, ambigüedad explícita), pantalla de revisión ✅ de sólo lectura. Aplicar requiere una API que el SDK no expone — ADR 0005 |
| F13 | Conciliación de pagos de tarjeta | ⚠️ motor ✅, visible en la pantalla de revisión |
| F14 | Normalización de comercios | ✅ |
| F15 | Categorización y reglas | ✅ motor + reglas predefinidas + editor de reglas propias (CRUD, vista previa del efecto) en `Configuración`. No recategoriza retroactivamente movimientos ya importados — sólo ajusta lecturas futuras |
| F16 | Motor de cuotas | ✅ |
| F17 | Panel Chile | ✅ caja y gasto separados, devoluciones explícitas, una vista por moneda |
| F18 | Insights | ✅ |

---

## Después

| Fase | Qué | Estado | Nota |
| --- | --- | --- | --- |
| F19 | Servicio importador | ⬜ | Decisión D11: no aporta hasta validar los perfiles |
| F20 | IA / MCP | ⬜ | Wealthfolio ya trae MCP. Ver D12 |
| F21 | Evaluar fork del core | ⬜ | Hoy no se justifica. Ver [ADR 0001](adr/0001-addon-sobre-fork.md) |

---

## Lo próximo, en orden

### 1. Calibrar con cartolas reales

Lo único que separa el release candidate de un `0.2.0`.

- [ ] Descargar una cartola de cada banco a `samples/private/`
- [ ] Seguir [BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*
- [ ] Resolver la pregunta de CMR: en una fila en cuotas, ¿una columna `Monto`
      sin etiquetar es el valor de la cuota o el total de la compra?
- [ ] Derivar fixtures sintéticos equivalentes, sin PII
- [ ] Promover `validationStatus` a `verified` sólo donde haya evidencia
- [ ] Reevaluar `balanceCheck: 'authoritative'` por perfil con la cartola a la vista

Prioridad: BancoEstado (CuentaRUT) primero — es la cuenta más común.

### 2. Recategorizar movimientos ya importados

`Configuración` (`SettingsPage`) ya cubre `verboseLogging`, `transferWindowDays`,
activar/desactivar reglas predefinidas y CRUD de reglas propias con vista previa
del efecto. Lo único que sigue sin existir: una regla nueva o editada no
reclasifica los movimientos que Wealthfolio ya tiene guardados — sólo cambia
cómo se leen las próximas importaciones.

- [ ] Recategorizar movimientos ya importados al guardar una regla

### 3. Aplicar una conciliación

Bloqueado por upstream. Requiere que el Addon SDK exponga `activities/link` o
`transfer-pair`; hasta entonces la pantalla de conciliación es de sólo lectura y
la frontera queda en `services/reconciliation.ts`.

- [ ] Seguir el SDK release a release
- [ ] Proponer la API upstream

### 4. Más adelante

- [ ] Presupuestos por categoría
- [ ] Exportar a CSV
- [ ] Más bancos: Santander, BCI, Scotiabank, Itaú, Tenpo, Mercado Pago
- [ ] UF / CLF como moneda de primera clase
- [ ] Conversión entre monedas — Wealthfolio 3.8 publicó `ExchangeRatesAPI.getRatesForDates`
      (tasa histórica real, ver [UPSTREAM.md](UPSTREAM.md) § *veredicto de APIs
      nuevas*); el bloqueo técnico ya no existe, lo que falta es diseñar la
      conversión en el panel (redondeo, `rate: null`, subir `minWealthfolioVersion`
      a 3.8.0) — deliberadamente diferido, no bloqueado
- [ ] Fintoc, si aparecen credenciales

## Bloqueos conocidos

| Bloqueo | Impacto | Salida |
| --- | --- | --- |
| ~~Sin Docker en esta máquina~~ | Resuelto. F2 ejecutada contra `3.6.2` y después contra `3.7.0` | — |
| Un addon no puede enlazar transferencias | La atribución de rendimiento del host queda `partial` en cuentas con transferencias importadas | [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md); proponer API upstream |
| Sin cartolas reales | F8–F10 sin validar con banco real; es lo que mantiene la versión en release candidate | Descargar una de cada banco |
| El panel no convierte entre monedas | Muestra un bloque por moneda en vez de un total único | Ya no es un bloqueo de API — 3.8 publicó `ExchangeRatesAPI.getRatesForDates`. Es una decisión de diseño diferida a propósito, ver [UPSTREAM.md](UPSTREAM.md) |
| `SpendingAPI` del SDK es genérica, no chilena | 3.8 publicó `ctx.api.spending`, pero no conoce Transbank/CMR/Redcompra/avances en efectivo | [ADR 0003](adr/0003-categorizacion-propia.md) sigue vigente — evaluado y diferido, ver [UPSTREAM.md](UPSTREAM.md) |
