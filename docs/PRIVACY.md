# Privacidad

Este proyecto maneja cartolas bancarias: movimientos, saldos, comercios,
números de cuenta. Las reglas de abajo no son recomendaciones.

---

## Dónde vive cada cosa

| Dato | Ubicación | Sale del equipo |
| --- | --- | --- |
| Bytes de la cartola | Memoria del iframe, durante la importación | **No** |
| Movimientos importados | Base SQLite de Wealthfolio | No |
| Historial de importaciones | `ctx.api.storage` del addon | No |
| Reglas y preferencias | `ctx.api.storage` del addon | No |
| Archivo original | **No se guarda** | — |

El addon no hace ninguna petición de red. Su `manifest.json` no declara el
permiso `network`, así que el host bloquearía cualquier intento.

---

## El archivo no se guarda

El historial guarda el SHA-256 del archivo, no el archivo. Eso responde todas
las preguntas que el usuario realmente se hace — «¿ya cargué febrero?», «¿por
qué esto salió mal?» — sin mantener una copia de una cartola dentro de la
aplicación.

Es una decisión de diseño, no una funcionalidad faltante. Si alguna vez se
implementa el guardado opcional, tendrá que ser explícito, configurable, cifrado
y documentado aquí.

---

## Qué nunca entra a un log

Prohibido registrar, en cualquier nivel:

- RUT
- Número de cuenta completo
- Número de tarjeta
- Saldos
- Descripciones de movimientos sin redactar
- Cartolas completas o fragmentos
- Tokens o credenciales

El addon **no llama a `ctx.api.logger` directamente**. Llama a
`createRedactingLogger()` (`core/privacy.ts`), que pasa cada mensaje por
`redactSensitive()` antes de entregarlo al host. Así «¿se nos filtró algo?» es
una pregunta de un solo archivo.

```ts
const logger = createRedactingLogger(ctx.api.logger, { verboseEnabled });
logger.info('Importación completed: 12 de 14 movimientos');   // ✅ conteos
logger.error(`Falló la cuenta 001234567890`);                  // → "[NUM]"
```

Los diagnósticos detallados se activan con `verboseLogging` en los ajustes del
addon, y **siguen pasando por la redacción**: se puede depurar sin exponer
datos financieros.

### Utilidades disponibles

| Función | Efecto |
| --- | --- |
| `maskAccountNumber('000123456789')` | `••••6789` |
| `maskRut('12.345.678-9')` | `••.•••.678-9` |
| `maskCardNumber('4051 2233 4455 6677')` | `•••• •••• •••• 6677` |
| `redactSensitive(texto)` | Reemplaza RUT, tarjetas, tokens, correos y dígitos largos |
| `redactDescription(texto)` | Redacta y trunca |
| `redactAmount(minor)` | Solo el orden de magnitud: `-1e4..1e5` |

`redactAmount` existe porque un monto exacto más una fecha identifica un
movimiento tan bien como un ID.

---

## Lo que se guarda del archivo

Del archivo importado se conserva su **SHA-256** y un nombre **saneado**: se le
quitan las secuencias de dígitos largas y cualquier cosa con forma de RUT, y
queda lo que hace reconocible la fila del historial —la palabra del banco, el
período, la extensión—. Los bancos chilenos bautizan sus descargas con el RUT o
el número de cuenta (`CartolaCuentaRut_12345678-9_202602.csv`,
`Movimientos_001234567890.xlsx`), y `ctx.api.storage` se replica entre los
dispositivos emparejados del usuario, así que guardar el nombre tal cual era
guardar el identificador.

El resumen de una importación que falló guarda **cifras y un código**, nunca el
texto del host. Un mensaje del host puede citar la petición de vuelta, y la
petición es una fila de cartola. La redacción no alcanza para eso: quita lo que
tiene forma —RUT, tarjeta, cuenta, token, correo— y el nombre de una persona no
la tiene. El texto completo vive en memoria, en la pantalla que el usuario está
mirando, y muere con ella.

Por la misma razón, un problema de parseo dice **qué columna** falló y en qué
línea, y no cita la celda: cuando una columna viene corrida, esa celda es una
glosa entera.

## Cartolas reales y Git

```
samples/
├── synthetic/   ← versionado. Datos inventados. Los fixtures salen de aquí.
└── private/     ← IGNORADO. Cartolas reales. Nunca se sube nada.
```

Defensas activas:

1. `.gitignore` incluye `samples/private/` y `**/samples/private/`.
2. `addon/tests/fixtures.ts` solo lee de `samples/synthetic/`, y hay un test que
   lo verifica.
3. CI falla si aparece cualquier archivo versionado bajo `samples/private/`.
4. CI falla si algo con forma de RUT aparece en los fixtures sintéticos.

### Al calibrar un banco con un archivo real

1. Trabaja sobre el archivo en `samples/private/`.
2. Arregla el perfil.
3. **Crea un fixture sintético equivalente**: misma estructura, mismos
   encabezados, datos inventados.
4. El test se escribe contra el fixture sintético.
5. El archivo real nunca se copia, ni se cita en un mensaje de commit, ni se
   pega en un issue.

---

## IA

No hay ninguna integración de IA hoy. Cuando la haya:

- Nada se envía a un servicio externo sin consentimiento explícito por operación.
- Nunca se envía una cartola completa.
- El motor determinista y la interpretación por IA quedan separados.
- **La IA nunca decide saldos ni aritmética.** Puede proponer un nombre de
  comercio o una categoría; no puede cambiar un número.

---

## Secretos

Ninguno todavía. Cuando se integre Fintoc u otro proveedor, las credenciales van
en `ctx.api.secrets` (cifrado en reposo, acotado al addon), nunca en
`ctx.api.storage`, nunca en el código, nunca en el repositorio.

---

## Calibrar contra una cartola real

`pnpm calibrate` (ver [BANK_FORMATS.md](BANK_FORMATS.md) y
[REAL_SAMPLE_WORKFLOW.md](REAL_SAMPLE_WORKFLOW.md)) es el único punto del
proyecto que toca un archivo real a propósito, así que es el que más defensas
lleva:

- **dónde puede vivir el archivo.** Fuera del repositorio, o en
  `samples/private/` y sólo mientras Git lo ignore de verdad —se le pregunta a
  `git check-ignore` en vez de adivinar—. Cualquier otra ruta dentro del
  repositorio se rechaza, incluidas las ignoradas. Que una carpeta esté
  ignorada y que sea el lugar de las cartolas son propiedades distintas:
  `.ai/`, `dist/`, `coverage/` y `node_modules/` están ignoradas y ninguna es
  un sitio para datos bancarios; `.ai/` en particular es donde se acumulan
  informes que después se pegan en otras herramientas;
- **los enlaces no son una puerta lateral.** La ruta se resuelve
  (`realpath`) antes de juzgarla, así que un symlink de fuera que apunte hacia
  dentro no se cuela;
- **se niega antes de leer** si el archivo no existe, es un directorio, está
  vacío o pesa más de 10 MB —el mismo tope que el asistente de importación—;
- **ningún mensaje de error de Node llega crudo.** `ENOENT: no such file or
  directory, open '/home/ana/CartolaRut_12345678_5.csv'` lleva un RUT, un
  nombre y un directorio personal, y es lo primero que ve alguien que escribe
  mal la ruta. Se reporta la clase del fallo y nunca la ruta;
- lee el archivo en memoria durante una llamada y no lo copia a ninguna parte
  —ni al repositorio, ni a `.ai/`, ni a `/tmp`—. La E/S del comando se inyecta
  y **no contiene ninguna operación de escritura**: no es una promesa, es que
  no hay con qué;
- su salida son conteos, códigos, roles normalizados y posiciones de columna. Ni glosas, ni
  montos, ni RUT, ni números de cuenta, ni el nombre del archivo. Los tests de
  `addon/tests/calibration.test.ts` y `addon/tests/calibration-cli.test.ts`
  comprueban las ausencias, no sólo las presencias.

### El informe no imprime una huella

Calibrar un formato no necesita identificar de forma estable la exportación.
El SHA-256 sigue existiendo dentro del flujo de importación, donde cumple una
función de idempotencia e historial, pero no sale en el informe pegable de
calibración. Son contextos y propósitos distintos.

Un informe de calibración no sustituye al fixture sintético. Sigue prohibido
derivar un fixture de una cartola real cambiándole los nombres: un fixture se
escribe a mano.

---

## Si algo se filtra igual

1. `git rm --cached` no basta: el dato queda en el historial.
2. Reescribe el historial (`git filter-repo`) antes de cualquier push.
3. Si ya se subió a un remoto, considera las credenciales comprometidas y
   rótalas.
4. Anota qué defensa falló y agrega la que lo habría evitado.
