# Wealthfolio Chile

Addon de [Wealthfolio](https://wealthfolio.app) para gestión financiera personal
en Chile: importa cartolas de bancos chilenos, concilia transferencias entre tus
cuentas, detecta compras en cuotas y responde en qué se te va el sueldo.

> **Estado: 0.2.0-rc.1 — validado contra un Wealthfolio v3.7.0 real, todavía sin
> cartolas reales.** 582 tests cubren el motor, la capa de servicios y la
> interfaz sobre un DOM. El addon se ha ejecutado dentro de un Wealthfolio
> corriendo en dos sesiones de validación —3.6.2 primero, 3.7.0 después— y las
> dos encontraron errores que ningún test unitario podía ver, porque estaban en
> la frontera con el host. Todos corregidos y reverificados.
>
> Sigue siendo un *release candidate* por una razón concreta: los adaptadores de
> Banco de Chile, BancoEstado y Falabella/CMR están construidos sobre
> documentación pública, no sobre cartolas reales, y hasta que eso cambie
> ninguno puede llamarse verificado.
>
> Evidencia en [docs/HOST_VALIDATION.md](docs/HOST_VALIDATION.md); matriz en
> [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

### Cómo leer los estados en esta documentación

Cuatro niveles, y no se mezclan:

| Nivel | Qué significa |
| --- | --- |
| **implementado** | El código existe y sus tests unitarios pasan |
| **integrado** | Está enganchado al flujo real del addon, no sólo disponible |
| **validado en host** | Se ejecutó contra un Wealthfolio v3.7.0 corriendo |
| **validado con banco real** | Se ejecutó contra una cartola real de ese banco |

Hoy el proyecto llega a **validado en host**. Ningún banco llega a
**validado con banco real**.

---

## Qué hace

Le das una cartola y obtienes:

- Movimientos normalizados, con comercio y categoría
- Ingresos y egresos que **no cuentan dos veces** una transferencia o un pago de
  tarjeta *dentro de la misma cartola* (ver la nota de abajo sobre el caso
  multi-cuenta, que todavía no está enganchado)
- Compras en cuotas reconstruidas: cuánto llevas, cuánto queda, hasta cuándo
- Flujo de caja mensual, gasto por categoría, comercios principales
- Gastos recurrentes y suscripciones detectados
- Observaciones sobre qué cambió respecto del mes anterior

Todo local. El addon no hace peticiones de red; su manifiesto ni siquiera
declara el permiso para hacerlas.

### La parte que más importa

Una compra CMR de $80.000 y el pago de $80.000 desde tu cuenta corriente **no
son $160.000 de gasto**. Un traspaso de $200.000 de Banco de Chile a
BancoEstado no es un gasto de $200.000 más un ingreso de $200.000.

Esa distinción está en el centro del modelo, no parchada encima: las
transferencias internas y los pagos de tarjeta se mapean a `TRANSFER_IN`/
`TRANSFER_OUT` de Wealthfolio, que netean a cero a nivel de portafolio, y están
excluidas por construcción de todo agregado de ingreso y gasto.

**Qué funciona hoy y qué no.** Cuando la glosa identifica el movimiento como
transferencia o pago de tarjeta, la clasificación ocurre al importar y los
totales ya lo respetan — eso está *integrado*. Emparejar las **dos patas** de
una transferencia que vive en dos cuentas distintas requiere leer movimientos de
otras cuentas, y ese motor (`core/reconcile`, `services/reconciliation.ts`) está
*implementado y testeado pero todavía no integrado*: no hay pantalla para
confirmar o rechazar una sugerencia. Hasta entonces, una transferencia que
ninguna de las dos glosas nombra como tal se cuenta como gasto en una cuenta e
ingreso en la otra.

---

## Bancos soportados

| Banco | Producto | Formatos | Estado |
| --- | --- | --- | --- |
| Banco de Chile | Cuenta corriente, tarjeta | CSV, XLSX | ⚠️ pendiente de calibrar |
| BancoEstado | CuentaRUT, cuenta corriente | CSV, XLSX | ⚠️ pendiente de calibrar |
| Banco Falabella / CMR | Tarjeta, cuenta corriente | CSV, XLSX | ⚠️ pendiente de calibrar |
| Genérico | Cualquiera con fecha, glosa y monto | CSV, TXT, XLSX, XLS | ✅ |

⚠️ significa que el adaptador está completo y testeado, pero el mapeo de
columnas se dedujo de documentación pública. El wizard te lo advierte. Calibrar
uno es editar strings en un perfil — ver
[docs/BANK_FORMATS.md](docs/BANK_FORMATS.md).

PDF no se soporta a propósito: si existe un archivo tabular, esa es la fuente.

---

## Instalar

### Requisitos

- Node 20.19+ (24 recomendado, igual que upstream)
- pnpm 10 (el bootstrap lo activa con corepack)
- Docker + Compose v2, si quieres Wealthfolio self-hosted

### Puesta en marcha

```bash
git clone <este-repo> wealthfolio-chile
cd wealthfolio-chile
./scripts/bootstrap.sh
```

El bootstrap verifica la toolchain, instala dependencias, clona Wealthfolio
como referencia y crea `infra/.env` con un `WF_SECRET_KEY` generado.

### Levantar Wealthfolio

```bash
# Edita infra/.env: define WF_AUTH_PASSWORD_HASH antes de exponer nada
./scripts/stack.sh start
./scripts/deploy-addon.sh     # construye e instala el addon
```

Abre `http://localhost:8088`. En la barra lateral debería aparecer **Chile**.

Por defecto el servicio escucha solo en loopback. Para exponerlo, ponle un proxy
inverso con TLS delante — la app guarda datos bancarios.

---

## Desarrollar

```bash
./scripts/test.sh     # typecheck + lint + tests + build
./scripts/dev.sh      # servidor de desarrollo con recarga
```

Con Wealthfolio de escritorio en modo desarrollo
(`VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev`), el addon se descubre solo en
`localhost:3001`.

### Estructura

```
addon/src/
├── core/       motor determinista — TypeScript puro, sin SDK ni DOM
├── services/   lo único que habla con ctx.api
└── ui/         páginas React
```

La regla que ordena todo: **`core/` no importa nada del SDK ni toca el DOM.**
Por eso se testea en Node sin navegador ni mocks. Ver
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Agregar un banco

Un banco es un `StatementProfile`: sinónimos de columnas, convención de signo,
formato numérico, producto. No se escribe un parser.

```ts
export const MI_BANCO: StatementProfile = {
  institution: 'mi-banco',
  institutionLabel: 'Mi Banco — cuenta corriente',
  parserId: 'mi-banco.cuenta',
  parserVersion: '0.1.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'signed',
  columnSynonyms: { /* … */ },
  validationStatus: 'pending-real-sample',
};

export const miBancoParser = createProfileParser(MI_BANCO, {
  strongMarkers: [/MI\s+BANCO/i],
});
```

Regístralo en `core/providers/registry.ts` y agrega un fixture sintético.

---

## Operar

```bash
./scripts/stack.sh start|stop|restart|logs|status|update
./scripts/backup.sh                    # respaldo con el contenedor detenido
./scripts/restore.sh <archivo.tar.gz>  # DESTRUCTIVO, pide confirmación
./scripts/update-upstream.sh           # refresca el checkout de referencia
```

`update` respalda antes de actualizar. La versión de la imagen está **fijada**
en `infra/.env`, nunca `latest`: un `docker compose up` no debería convertirse
en una actualización no planificada de la app que guarda tu historial
financiero.

---

## Privacidad

- El archivo nunca se guarda; solo su SHA-256, para el historial.
- Ningún log puede contener RUT, número de cuenta, tarjeta, saldos ni glosas sin
  redactar. El addon no llama al logger del host directamente: pasa por
  `createRedactingLogger()`.
- `samples/private/` está en `.gitignore` y CI falla si aparece algo versionado
  ahí, o si algo con forma de RUT entra a los fixtures.
- Los fixtures de test son siempre sintéticos.

Detalle completo en [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Documentación

| Documento | Contenido |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Componentes, flujos y las decisiones que los sostienen |
| [IMPORT_PIPELINE.md](docs/IMPORT_PIPELINE.md) | El pipeline paso a paso |
| [BANK_FORMATS.md](docs/BANK_FORMATS.md) | Estado por banco y cómo calibrar |
| [CURRENT_STATE.md](docs/CURRENT_STATE.md) | Qué funciona hoy y qué no |
| [ROADMAP.md](docs/ROADMAP.md) | Fases completadas y pendientes |
| [DECISIONS.md](docs/DECISIONS.md) | Decisiones de diseño |
| [PRIVACY.md](docs/PRIVACY.md) | Tratamiento de datos financieros |
| [UPSTREAM.md](docs/UPSTREAM.md) | Versión de Wealthfolio y estrategia de actualización |
| [adr/](docs/adr/) | Decisiones que necesitaban justificación larga |

---

## Relación con Wealthfolio

Este proyecto es un **addon**, no un fork. Se construye sobre el Addon SDK
3.7.0 y solo usa APIs soportadas. Nunca escribe SQLite directamente.

`.upstream/wealthfolio` es un checkout de referencia, ignorado por Git: no
vendorizamos código de upstream.

Antes de modificar el core hace falta un ADR que demuestre que no hay
alternativa soportada — y antes de eso, considerar contribuir la API que falta
aguas arriba. Ver [ADR 0001](docs/adr/0001-addon-sobre-fork.md).

## Licencia

Sin definir todavía. `addon/package.json` y `addon/manifest.json` declaran
`UNLICENSED`, que es exactamente eso: no se ha concedido ninguna licencia y el
proyecto no está listo para publicarse. Es una decisión pendiente y consciente;
ver D13 en [DECISIONS.md](docs/DECISIONS.md). Dependencias de terceros en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
