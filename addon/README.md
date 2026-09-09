# Wealthfolio Chile — addon

Addon de Wealthfolio para importar cartolas bancarias chilenas, conciliar
movimientos y analizar el gasto.

Documentación completa en la [raíz del repositorio](../README.md).

## Comandos

```bash
pnpm install
pnpm test          # 1301 tests
pnpm typecheck
pnpm lint
pnpm build         # dist/addon.js
pnpm bundle        # ZIP instalable
pnpm verify        # las cuatro anteriores
pnpm dev:server    # servidor de desarrollo (localhost:3001)
```

## Estructura

```
src/
├── addon.tsx     punto de entrada: registra las cinco rutas
├── core/         motor determinista — TS puro, sin SDK ni DOM
├── services/     lo único que habla con ctx.api
└── ui/           páginas React
tests/            vitest, contra fixtures sintéticos
```

`core/` no importa nada del SDK ni toca el DOM. Solo
`core/mapping/activities.ts` importa tipos del SDK, y con `import type`, que
desaparece al compilar. Por eso el motor se testea en Node sin navegador ni
mocks.

## Permisos declarados

| Categoría | Funciones | Para qué |
| --- | --- | --- |
| `accounts` | `getAll` | Listar cuentas de destino |
| `activities` | `search`, `saveMany` | Detectar duplicados y escribir los movimientos confirmados |
| `settings` | `get` | Leer la moneda base |

Nada más. En particular **no** se declara `files`: el archivo entra por
`<input type="file">` dentro del iframe, así que sus bytes nunca salen del
sandbox. Tampoco `network`: el addon no hace ninguna petición.

## Compatibilidad

- Wealthfolio ≥ 3.7.0 (validado también contra 3.8.0)
- SDK 3.8.0 (tipos de build; sin uso de APIs 3.8-only)
- Node 20.19+ (24 recomendado)
