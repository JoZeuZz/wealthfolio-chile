# Qué hacer cuando llegue la primera cartola real

Este documento existe antes que el archivo. `samples/private/` está vacío,
ninguna línea de este código ha visto una exportación real, y los cinco perfiles
bancarios siguen `pending-real-sample` por eso — no por falta de tests.

El día que haya una cartola real en la mano es el día de mayor riesgo del
proyecto: el archivo está ahí, la herramienta es cómoda, y dejarlo junto al
código es lo natural. Este es el orden que evita eso.

---

## Los nueve pasos

### 1. Guardar el archivo en `samples/private/`

O fuera del repositorio, si prefieres. Esas son las dos únicas opciones que
`pnpm calibrate` acepta; cualquier otra ruta dentro del repositorio se rechaza
aunque Git la ignore (ver [PRIVACY.md](PRIVACY.md)).

`samples/private/` está en `.gitignore` y CI falla si aparece algo versionado
ahí dentro.

### 2. No renombrarlo con el RUT

Los bancos ya lo hacen: `CartolaCuentaRut_12345678-9_202602.csv`. Renombrarlo a
algo neutro (`cuentarut-feb.csv`) cuesta un segundo y quita el dato del nombre,
que es la parte que más viaja — aparece en cada mensaje de error, en cada
autocompletado del shell y en cada captura de pantalla.

No es obligatorio: el informe nunca imprime el nombre del archivo. Es una
defensa más, no la única.

### 3. Calibrar

```
cd addon
pnpm --silent calibrate -- ../samples/private/cuentarut-feb.csv
```

Para forzar un perfil concreto y ver por qué falla:

```
pnpm --silent calibrate -- ../samples/private/cuentarut-feb.csv --parser banco-estado.cuenta
```

El archivo se lee en su sitio. No se copia, no se cachea, no se escribe nada.

### 4. Leer sólo el informe

El informe es lo único que puede salir de esa máquina. Trae:

| Bloque | Qué responde |
| --- | --- |
| Archivo | extensión, tamaño, cantidad de hojas y filas |
| Detección | qué perfil ganó, con cuánta confianza, y **qué otros perfiles lo reclamaron** |
| Cabecera | roles normalizados y posiciones de columnas sin mapear, nunca texto libre |
| Filas | leídas, mapeadas, omitidas, fallidas, con números de línea |
| Montos | en qué escala decimal quedaron, cuántas entradas y salidas |
| Fechas | orden, fechas distintas, filas ambiguas |
| Saldos | pasos comprobados, descuadres y **de qué clase** (`sign`, `scale-100`) |
| Clasificación | cuántas filas por tipo, cuántas sin clasificar |
| Avisos | los códigos del parser, agrupados |

No trae glosas, montos, nombres, RUT, números de cuenta, nombre ni huella del
archivo. Eso es lo que lo hace pegable en un issue.

Las dos líneas que más suelen valer: **columnas sin mapear** (una columna que el
banco imprime y el perfil ignora es una sinonimia o un rol que falta) y
**escala decimal** (una nube de `scale 2` en una cartola CLP significa que el
separador de miles se leyó como decimal, que es el error más caro que este
pipeline puede cometer y no se ve en un conteo de filas).

### 5. No copiar el archivo

Ni a `fixtures/`, ni a `.ai/`, ni a `/tmp`, ni a un adjunto. No convertirlo en
fixture "cambiándole los nombres": los montos, las fechas y la estructura siguen
siendo de una persona.

### 6. Escribir un fixture sintético equivalente

A mano. Misma estructura, mismos encabezados, mismo orden de fechas, misma
convención de signos, mismos casos raros — y datos inventados. Va a
`samples/synthetic/`.

Un fixture bueno reproduce lo que el informe encontró: si el informe dijo que
hay tres filas con una columna de cuotas y dos filas con saldo declarado, el
fixture las tiene.

### 7. Agregar tests de regresión

En `addon/tests/`. Cada cosa que el perfil aprendió del archivo real es un test
contra el fixture sintético. Si el fixture no la reproduce, el aprendizaje se
pierde en la siguiente refactorización.

### 8. Recalibrar el perfil

Corregir el perfil declarativo en `addon/src/core/providers/`, volver a correr
`pnpm --silent calibrate` sobre el archivo real y comprobar que el informe
cambió como se esperaba. Después `pnpm verify`.

### 9. Mover `validationStatus` sólo con evidencia

Y sólo la del banco que se calibró.

- `pending-real-sample` → `verified` requiere que una exportación real de **ese**
  banco se haya leído entera, sin filas fallidas y con la clasificación
  revisada.
- `balanceCheck: 'advisory'` → `'authoritative'` requiere haber visto el
  recorrido de saldos cuadrar en un archivo real de ese banco. Un perfil que
  declara su columna de saldo autoritativa convierte un descuadre aislado en un
  error que bloquea la importación: es una promesa sobre el formato del banco,
  no una preferencia.

Un perfil calibrado no promueve a los otros cuatro.

---

## Lo que no cambia por tener una cartola

- El fixture sigue siendo sintético.
- El informe sigue siendo lo único que sale de la máquina.
- Ningún commit menciona el archivo, su nombre, su contenido ni su huella.
- Ningún agente de IA externo recibe el archivo. La herramienta local basta.

## La pregunta abierta de CMR

En una fila en cuotas de una cartola CMR/Falabella, una columna `Monto` sin
etiquetar puede ser el valor de la cuota o el total de la compra. Todo el
cálculo de deuda comprometida depende de cuál sea. Hoy la fila se marca
`ambiguous-installment-amount` y el plan no deriva el total.

Cuando haya una cartola CMR real, esta es la pregunta que hay que responder
primero, y se responde mirando: si la suma de la columna cuadra con el total del
estado de cuenta, es la cuota; si cada fila en cuotas repite el mismo número
mes a mes mientras el saldo baja, también es la cuota.
