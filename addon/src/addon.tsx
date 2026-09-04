import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { AddonProvider } from './ui/context';
import { DashboardPage } from './ui/pages/DashboardPage';
import { ImportHistoryPage } from './ui/pages/ImportHistoryPage';
import { ImportWizardPage } from './ui/pages/ImportWizardPage';
import { ReconciliationPage } from './ui/pages/ReconciliationPage';
import { SettingsPage } from './ui/pages/SettingsPage';

/**
 * Wealthfolio Chile — addon entry point.
 *
 * The sidebar entry and the five routes are declared in `manifest.json`, so
 * the host renders navigation without executing any of this. `enable` runs the
 * first time the user opens one of the routes, and its only job is to register
 * which component renders each one.
 *
 * The host owns the React root — nothing here calls `createRoot`.
 */

let addonCtx: AddonContext | undefined;

function withProviders(Page: () => ReactElement) {
  return function Route() {
    const ctx = addonCtx;
    if (!ctx) return null;
    return (
      <QueryClientProvider client={ctx.api.query.getClient() as QueryClient}>
        <AddonProvider ctx={ctx}>
          <Page />
        </AddonProvider>
      </QueryClientProvider>
    );
  };
}

const DashboardRoute = withProviders(DashboardPage);
const ImportRoute = withProviders(ImportWizardPage);
const HistoryRoute = withProviders(ImportHistoryPage);
const ReconciliationRoute = withProviders(ReconciliationPage);
const SettingsRoute = withProviders(SettingsPage);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // Each `id` must equal a `contributes.routes[].id` in the manifest, or the
  // host renders a blank "route is not available" page.
  ctx.router.add({
    id: 'wealthfolio-chile',
    path: '/addons/wealthfolio-chile',
    component: DashboardRoute,
  });

  ctx.router.add({
    id: 'wealthfolio-chile-import',
    path: '/addons/wealthfolio-chile/importar',
    component: ImportRoute,
  });

  ctx.router.add({
    id: 'wealthfolio-chile-history',
    path: '/addons/wealthfolio-chile/importaciones',
    component: HistoryRoute,
  });

  ctx.router.add({
    id: 'wealthfolio-chile-reconciliacion',
    path: '/addons/wealthfolio-chile/conciliacion',
    component: ReconciliationRoute,
  });

  ctx.router.add({
    id: 'wealthfolio-chile-configuracion',
    path: '/addons/wealthfolio-chile/configuracion',
    component: SettingsRoute,
  });

  ctx.api.logger.info('Wealthfolio Chile habilitado.');

  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};

export default enable;
