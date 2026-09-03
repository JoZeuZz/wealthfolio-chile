import '@testing-library/jest-dom/vitest';
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AddonProvider } from '../../src/ui/context';
import { fakeHost, type FakeHost } from '../host';

/**
 * Rendering an addon page.
 *
 * The pages read the host through `useAddon()`, so every test needs a provider
 * around them. Reusing `fakeHost()` — the same double the service tests use —
 * is deliberate: a UI test that invented its own host would be free to invent
 * host behaviour the services already proved wrong, which is exactly how the
 * six boundary bugs of 0.1.1 went undetected by three hundred passing tests.
 */

afterEach(cleanup);

export interface UiHarness extends RenderResult {
  host: FakeHost;
  user: ReturnType<typeof userEvent.setup>;
}

export function renderPage(
  element: ReactElement,
  options: Parameters<typeof fakeHost>[0] = {},
): UiHarness {
  const host = fakeHost(options);
  const result = render(<AddonProvider ctx={host.ctx}>{element}</AddonProvider>);
  return { ...result, host, user: userEvent.setup() };
}

/**
 * A file the drop zone will accept.
 *
 * Always synthetic. `docs/PRIVACY.md` forbids a real cartola from becoming a
 * fixture, and a UI test is not an exception.
 */
export function csvFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/csv' });
}
