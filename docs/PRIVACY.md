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

## Si algo se filtra igual

1. `git rm --cached` no basta: el dato queda en el historial.
2. Reescribe el historial (`git filter-repo`) antes de cualquier push.
3. Si ya se subió a un remoto, considera las credenciales comprometidas y
   rótalas.
4. Anota qué defensa falló y agrega la que lo habría evitado.
