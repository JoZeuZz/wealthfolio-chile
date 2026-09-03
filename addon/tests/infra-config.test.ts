import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Invariantes de `infra/`.
 *
 * Estas dos fallaron el 2026-08-07 la primera vez que el compose se encontró con
 * un daemon de Docker de verdad, y las dos son invisibles hasta ese momento: una
 * impide levantar el stack, la otra deja el addon instalado pero invisible. Se
 * fijan aquí porque una revisión a ojo ya las dejó pasar una vez.
 *
 * No sustituyen a `docs/HOST_VALIDATION.md` — un test no puede comprobar que un
 * contenedor arranca. Sí evitan que un cambio de una línea vuelva a romperlo.
 */

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const envExample = readFileSync(repo('infra/.env.example'), 'utf8');
const compose = readFileSync(repo('infra/compose.yml'), 'utf8');

const envValue = (key: string): string | undefined =>
  envExample.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();

describe('infra/.env.example', () => {
  it('fija WF_VERSION al tag tal como lo publica Docker Hub, sin la `v` del tag de git', () => {
    // `wealthfolio/wealthfolio:v3.6.2` no existe: el release v3.6.2 se publica
    // como `3.6.2`, y el pull falla con `manifest unknown`.
    expect(envValue('WF_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('nunca usa `latest`', () => {
    expect(envValue('WF_VERSION')).not.toBe('latest');
  });

  it('deja los secretos vacíos para que nadie herede una clave de ejemplo', () => {
    expect(envValue('WF_SECRET_KEY')).toBe('');
    expect(envValue('WF_AUTH_PASSWORD_HASH')).toBe('');
  });

  it('mantiene la autenticación exigida y el puerto en loopback', () => {
    expect(envValue('WF_AUTH_REQUIRED')).toBe('true');
    expect(envValue('WF_BIND_ADDR')).toBe('127.0.0.1');
  });
});

describe('infra/compose.yml', () => {
  it('apunta WF_ADDONS_DIR al padre del directorio de addons, no al directorio', () => {
    // El servidor le concatena `addons/` (`ensure_addons_directory`). Con
    // `/data/addons` busca en `/data/addons/addons`, que no existe, y el addon
    // queda invisible sin ningún error en ninguna parte.
    const mount = compose.match(/^\s*-\s*\$\{WF_ADDONS_DIR:-[^}]+\}:(\S+)$/m)?.[1];
    const configured = compose.match(/^\s*WF_ADDONS_DIR:\s*'([^']+)'/m)?.[1];

    expect(mount).toBe('/data/addons');
    expect(configured).toBe('/data');
    expect(`${configured}/addons`).toBe(mount);
  });

  it('fija la imagen por variable, nunca a `latest`', () => {
    // El valor lleva espacios: el `:?` de compose incluye un mensaje de error.
    const image = compose.match(/^\s*image:\s*(.+)$/m)?.[1];
    expect(image).toContain('${WF_VERSION');
    expect(image).not.toContain('latest');
  });
});

describe('infra/compose.dev.yml', () => {
  const dev = readFileSync(repo('infra/compose.dev.yml'), 'utf8');

  it('quita el hash de la contraseña, que es lo único que apaga la autenticación', () => {
    // `WF_AUTH_REQUIRED=false` no la apaga: upstream arma la configuración de
    // auth desde el hash (`password_hash.is_some() || oidc.is_some()` en
    // `apps/server/src/config.rs`) y `WF_AUTH_REQUIRED` sólo levanta el chequeo
    // de fail-closed para direcciones no loopback.
    expect(dev).toMatch(/WF_AUTH_PASSWORD_HASH:\s*''/);
  });

  it('no deja CORS en `*` con la autenticación encendida', () => {
    // El servidor entra en panic al arrancar si las dos cosas coinciden, y el
    // contenedor queda en bucle de reinicio sin llegar a escuchar nunca.
    const wildcardCors = /WF_CORS_ALLOW_ORIGINS:\s*'\*'/.test(dev);
    const authOff = /WF_AUTH_PASSWORD_HASH:\s*''/.test(dev);
    expect(wildcardCors && !authOff).toBe(false);
  });
});
