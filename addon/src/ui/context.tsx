import type { AddonContext } from '@wealthfolio/addon-sdk';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * The addon context, made available to the React tree.
 *
 * The host mounts route components with no props of its own, so the context is
 * captured once in `enable` and handed down from here rather than threaded
 * through every component.
 */
const AddonCtx = createContext<AddonContext | undefined>(undefined);

export function AddonProvider({
  ctx,
  children,
}: {
  ctx: AddonContext;
  children: ReactNode;
}) {
  return <AddonCtx.Provider value={ctx}>{children}</AddonCtx.Provider>;
}

export function useAddon(): AddonContext {
  const ctx = useContext(AddonCtx);
  if (!ctx) {
    throw new Error('useAddon debe usarse dentro de <AddonProvider>.');
  }
  return ctx;
}
