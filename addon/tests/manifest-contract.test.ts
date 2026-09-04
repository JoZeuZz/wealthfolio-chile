import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Invariantes del contrato declarado con el host.
 *
 * El manifiesto, el `package.json` y la configuración de build declaran tres
 * veces la misma versión de Wealthfolio. Cuando divergen no falla nada
 * visiblemente: el host sólo emite un warning por `sdkVersion` distinta y ni
 * siquiera mira `hostDependencies` más allá de los nombres
 * (`apps/frontend/src/addons/addons-core.ts:validateAddonCompatibility`). El
 * único gate duro es `minWealthfolioVersion`
 * (`crates/core/src/addons/service.rs:enforce_min_wealthfolio_version`).
 *
 * Es decir: una migración a medias se ve exactamente igual que una completa
 * hasta que algo se rompe en runtime. Estos tests la hacen ruidosa.
 */

const addon = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const manifest = JSON.parse(readFileSync(addon('manifest.json'), 'utf8')) as {
  version: string;
  sdkVersion: string;
  minWealthfolioVersion: string;
  hostDependencies: Record<string, string>;
};
const pkg = JSON.parse(readFileSync(addon('package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const viteConfig = readFileSync(addon('vite.config.ts'), 'utf8');

const VERSION_TRIPLE = /^\d+\.\d+\.\d+$/;

/**
 * La versión del addon, que se declara dos veces.
 *
 * `manifest.json` es lo que el host lee y muestra; `package.json` es lo que
 * nombra el zip (`wealthfolio-chile-$npm_package_version.zip`). Divergir
 * produce el peor fallo posible de un release: un archivo que se llama como la
 * versión nueva conteniendo un manifiesto que le dice al host que es la vieja,
 * de modo que instalarlo sobre la anterior no es una actualización de nada.
 *
 * Ya pasó una vez en sentido contrario: la documentación decía `0.2.0-rc.1`
 * mientras los dos manifiestos seguían en `0.1.1`. `infra/addons/**` no entra
 * aquí porque no está versionado — `scripts/deploy-addon.sh` lo genera copiando
 * este mismo `manifest.json`.
 */
describe('la versión del addon', () => {
  it('es la misma en el manifiesto y en package.json', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('tiene una forma que el host y npm entienden los dos', () => {
    // `major.minor.patch` con un pre-release opcional: `0.2.0-rc.1`.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe('manifest.json', () => {
  it('declara una sdkVersion con forma de versión exacta', () => {
    expect(manifest.sdkVersion).toMatch(VERSION_TRIPLE);
  });

  it('declara un minWealthfolioVersion que el host sabe parsear', () => {
    // `parse_version_triple` rechaza cualquier otra cosa y el install falla.
    expect(manifest.minWealthfolioVersion).toMatch(VERSION_TRIPLE);
  });

  it('no exige un host más nuevo que el SDK con el que se construyó', () => {
    const triple = (v: string) => v.split('.').map(Number) as [number, number, number];
    expect(triple(manifest.minWealthfolioVersion) <= triple(manifest.sdkVersion)).toBe(true);
  });

  it('pide del host exactamente las mismas versiones que declara package.json', () => {
    // Divergir aquí es cómo el addon termina compilado contra un paquete y
    // ejecutado contra otro.
    expect(manifest.hostDependencies).toEqual(pkg.peerDependencies);
  });

  it('alinea las dependencias de Wealthfolio con la sdkVersion declarada', () => {
    const expected = `^${manifest.sdkVersion}`;
    expect(pkg.peerDependencies['@wealthfolio/addon-sdk']).toBe(expected);
    expect(pkg.peerDependencies['@wealthfolio/ui']).toBe(expected);
    expect(pkg.devDependencies['@wealthfolio/addon-sdk']).toBe(expected);
    expect(pkg.devDependencies['@wealthfolio/ui']).toBe(expected);
    expect(pkg.devDependencies['@wealthfolio/addon-dev-tools']).toBe(expected);
  });
});

describe('vite.config.ts', () => {
  it('fija el build target en lugar de heredar el default de Vite', () => {
    // La guía de migración v3.6→v3.7 lo pide explícitamente: un default de Vite
    // que suba solo el piso de navegadores rompería el addon en el WebView más
    // viejo que Wealthfolio soporta, y no en la máquina de quien lo construye.
    for (const target of ['chrome107', 'edge107', 'firefox104', 'safari16']) {
      expect(viteConfig).toContain(target);
    }
  });
});
