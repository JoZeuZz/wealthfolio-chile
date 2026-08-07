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
| F2 | Entorno Docker de Wealthfolio | ⚠️ escrito, no ejecutado (falta Docker) |
| F3 | Scaffold del addon | ✅ CLI oficial, 3 rutas, permisos mínimos |
| F4 | Modelo financiero canónico | ✅ |
| F5 | Ingesta CSV / TXT / XLSX / XLS | ✅ |
| F6 | Vista previa de importación | ✅ |
| F7 | Deduplicación | ✅ |
| F8 | Adaptador Banco de Chile | ⚠️ completo, sin cartola real |
| F9 | Adaptador BancoEstado | ⚠️ completo, sin cartola real |
| F10 | Adaptador Falabella / CMR | ⚠️ completo, sin cartola real |
| F11 | Historial de importaciones | ✅ |

---

## MVP+1

| Fase | Qué | Estado |
| --- | --- | --- |
| F12 | Conciliación de transferencias internas | ⚠️ motor ✅, falta UI y engancharlo al import |
| F13 | Conciliación de pagos de tarjeta | ⚠️ motor ✅, falta UI |
| F14 | Normalización de comercios | ✅ |
| F15 | Categorización y reglas | ⚠️ motor ✅ + 24 reglas, falta editor |
| F16 | Motor de cuotas | ✅ |
| F17 | Panel Chile | ✅ |
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

### 1. Cerrar el ciclo end-to-end real

Bloqueante para todo lo demás.

- [ ] Instalar Docker + Compose v2
- [ ] `./scripts/stack.sh start`
- [ ] `./scripts/deploy-addon.sh`
- [ ] Verificar que "Chile" aparece en la barra lateral
- [ ] Importar un fixture sintético contra la instancia real
- [ ] Confirmar que los movimientos llegan con la metadata correcta
- [ ] Reimportar y confirmar cero duplicados

### 2. Calibrar con cartolas reales

- [ ] Descargar una cartola de cada banco a `samples/private/`
- [ ] Seguir [BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*
- [ ] Crear fixtures sintéticos equivalentes
- [ ] Marcar los perfiles como `verified`

Prioridad: BancoEstado (CuentaRUT) primero — es la cuenta más común.

### 3. Enganchar la conciliación al flujo

El motor está testeado pero no conectado.

- [ ] `prepareImport` debe cargar movimientos recientes de *otras* cuentas
- [ ] Pantalla de sugerencias: confirmar / rechazar
- [ ] Persistir las decisiones del usuario en `storage`
- [ ] Aplicar las confirmadas al reclasificar

### 4. Editores de reglas y categorías

- [ ] CRUD de reglas con vista previa del efecto
- [ ] Activar/desactivar reglas predefinidas
- [ ] Editor del árbol de categorías
- [ ] Recategorizar movimientos ya importados

### 5. Más adelante

- [ ] Presupuestos por categoría
- [ ] Gráficos de evolución (Recharts ya está disponible desde el host)
- [ ] Exportar a CSV
- [ ] Más bancos: Santander, BCI, Scotiabank, Itaú, Tenpo, Mercado Pago
- [ ] UF / CLF como moneda de primera clase
- [ ] Fintoc, si aparecen credenciales

---

## Bloqueos conocidos

| Bloqueo | Impacto | Salida |
| --- | --- | --- |
| ~~Sin Docker en esta máquina~~ | Resuelto el 2026-08-07: F2 ejecutada contra `wealthfolio/wealthfolio:3.6.2`. Ver [HOST_VALIDATION.md](HOST_VALIDATION.md) | — |
| Un addon no puede enlazar transferencias | La atribución de rendimiento del host queda `partial` en cuentas con transferencias importadas | [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md); proponer API upstream |
| Sin cartolas reales | F8–F10 sin validar | Descargar una de cada banco |
| Sin API de spending en el SDK | Categorización duplicada | [ADR 0003](adr/0003-categorizacion-propia.md); proponer API upstream |
