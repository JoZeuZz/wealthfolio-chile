# Avisos de terceros

Dependencias de Wealthfolio Chile y sus licencias.

Ninguna se ha copiado ni modificado: todas se consumen como paquetes. **No hay
código de terceros vendorizado en este repositorio.**

---

## Relación con Wealthfolio

| Componente | Licencia | Cómo lo usamos |
| --- | --- | --- |
| `wealthfolio/wealthfolio` (core) | **AGPL-3.0** | No se copia código. Se consume como aplicación anfitriona a través de su SDK público. `.upstream/wealthfolio` es un checkout de referencia ignorado por Git |
| `@wealthfolio/addon-sdk` | **MIT** | Dependencia (tipos y APIs). Provista por el host en ejecución |
| `@wealthfolio/ui` | **MIT** | Dependencia (componentes). Provista por el host en ejecución |
| `@wealthfolio/addon-dev-tools` | **MIT** | Solo desarrollo: CLI y servidor de recarga |

El core es AGPL-3.0, pero los paquetes que consumimos son MIT y no incorporamos
código del core. Si alguna vez se copiara o adaptara código de upstream, habría
que conservar sus headers y avisos, registrarlo aquí, y revisar las obligaciones
de la AGPL antes de distribuir.

---

## Dependencias de ejecución

| Paquete | Versión | Licencia | Para qué |
| --- | --- | --- | --- |
| [SheetJS `xlsx`](https://sheetjs.com) | 0.20.3 | **Apache-2.0** | Leer XLSX y XLS heredado |

SheetJS se obtiene de su distribución oficial
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) y no del registro npm,
donde el paquete quedó congelado en 0.18.5 con advisories abiertos. Ver
[ADR 0004](docs/adr/0004-libreria-planillas.md).

Es la única dependencia que termina dentro del bundle. Todo lo demás lo provee
el host.

---

## Provistas por el host en ejecución

Marcadas como `external` en el build y declaradas en `hostDependencies` del
manifiesto. Se listan porque el addon las importa, aunque no las distribuya.

| Paquete | Licencia |
| --- | --- |
| react, react-dom | MIT |
| @tanstack/react-query | MIT |
| recharts | MIT |
| date-fns | MIT |
| lucide-react | ISC |

---

## Solo desarrollo

| Paquete | Licencia |
| --- | --- |
| typescript | Apache-2.0 |
| vite | MIT |
| vitest | MIT |
| eslint, @typescript-eslint/* | MIT |
| prettier | MIT |
| tailwindcss, @tailwindcss/vite | MIT |
| @vitejs/plugin-react | MIT |

---

## Proyectos estudiados

Consultados como referencia conceptual durante el diseño. **No se copió código
de ninguno.** Se listan por transparencia sobre de dónde salieron las ideas.

| Proyecto | Licencia | Qué se estudió |
| --- | --- | --- |
| [Actual Budget](https://github.com/actualbudget/actual) | MIT | Forma general del modelo de reglas (condición → acción) y del flujo de conciliación |
| [Firefly III](https://github.com/firefly-iii/firefly-iii) | AGPL-3.0 | Enfoque de pipeline de importación y configuraciones reutilizables |
| [Sure](https://github.com/we-promise/sure) | AGPL-3.0 | Arquitectura de adaptadores por proveedor y normalización de comercios |

La influencia es de forma, no de implementación: nuestro motor de reglas, el
pipeline y la normalización de comercios están escritos desde cero contra el
vocabulario de las cartolas chilenas. Firefly III y Sure son AGPL-3.0, así que
copiar código habría traído obligaciones de licencia; se evitó a propósito.

---

## Verificar

```bash
cd addon
pnpm licenses list          # licencias del árbol instalado
pnpm audit --audit-level high
```

CI corre la auditoría en cada push, de forma informativa.
