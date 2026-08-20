import { mkdirSync } from 'node:fs';
import type { Frame, Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  HOSTILE_TEXT,
  TOOL_CASES,
  TOOL_NAMES,
  resultFor,
  type FixtureState,
  type ToolName,
} from './fixtures';

type HarnessSnapshot = {
  tool: ToolName;
  state: FixtureState;
  calls: { name: string; arguments?: Record<string, unknown> }[];
  deliveries: { method: string; params: unknown }[];
  displayRequests: string[];
  sizeChanges: { width?: number; height?: number }[];
  unexpectedProtocol: string[];
};

type Observations = {
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
};

const observations = new WeakMap<Page, Observations>();
const hostUrl = '/tests/apps/host.html';

function isUnexpectedExternalRequest(page: Page, request: Request): boolean {
  const url = new URL(request.url());
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  if (url.hostname !== '127.0.0.1' || url.port !== '4178') return true;
  if (request.frame() === page.mainFrame()) return false;
  return request.resourceType() !== 'document'
    || url.pathname !== '/apps/transit-board.html';
}

async function appFrame(page: Page): Promise<Frame> {
  await expect(page.locator('#app-frame')).toBeVisible();
  await expect.poll(() => page.frames().some(frame => (
    /\/apps\/transit-board\.html/.test(frame.url())
  ))).toBe(true);
  const frame = page.frames().find(candidate => /\/apps\/transit-board\.html/.test(candidate.url()));
  if (!frame) {
    throw new Error('Transit Board iframe did not load.');
  }
  return frame;
}

async function selectScenario(
  page: Page,
  toolName: ToolName,
  state: FixtureState = 'ready',
): Promise<Frame> {
  if (await page.locator('#tool-control').inputValue() !== toolName) {
    await page.locator('#tool-control').selectOption(toolName);
  }
  if (await page.locator('#state-control').inputValue() !== state) {
    await page.locator('#state-control').selectOption(state);
  }
  await expect(page.locator('#host-status')).toHaveAttribute(
    'data-scenario',
    `${toolName}:${state}`,
  );
  await expect(page.locator('#host-status')).toHaveAttribute('data-ready', 'true');
  const frame = await appFrame(page);
  if (state === 'ready' || state === 'hostile') {
    await expect(frame.locator(`[data-view="${TOOL_CASES[toolName].view}"]`)).toBeVisible();
  }
  return frame;
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  return page.evaluate(() => {
    const harness = (window as Window & {
      __metroAppsHarness: { snapshot(): HarnessSnapshot };
    }).__metroAppsHarness;
    return harness.snapshot();
  });
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => {
    const effects: string[] = [];
    Object.defineProperty(window, '__metroSecurityEffects', { value: effects });
    const record = (name: string): void => {
      effects.push(name);
    };
    const wrap = (
      owner: Record<string, unknown>,
      key: string,
      label: string,
    ): void => {
      const original = owner[key];
      if (typeof original !== 'function') return;
      owner[key] = function wrapped(this: unknown, ...args: unknown[]): unknown {
        record(label);
        return Reflect.apply(original, this, args);
      };
    };

    wrap(globalThis as unknown as Record<string, unknown>, 'fetch', 'fetch');
    wrap(XMLHttpRequest.prototype as unknown as Record<string, unknown>, 'open', 'xhr');
    wrap(Storage.prototype as unknown as Record<string, unknown>, 'setItem', 'storage.setItem');
    wrap(Storage.prototype as unknown as Record<string, unknown>, 'removeItem', 'storage.removeItem');
    wrap(Storage.prototype as unknown as Record<string, unknown>, 'clear', 'storage.clear');
    wrap(IDBFactory.prototype as unknown as Record<string, unknown>, 'open', 'indexedDB.open');
    wrap(IDBFactory.prototype as unknown as Record<string, unknown>, 'deleteDatabase', 'indexedDB.deleteDatabase');
    if (navigator.permissions) {
      wrap(
        navigator.permissions as unknown as Record<string, unknown>,
        'query',
        'permissions.query',
      );
    }
    if (navigator.geolocation) {
      wrap(
        navigator.geolocation as unknown as Record<string, unknown>,
        'getCurrentPosition',
        'geolocation.getCurrentPosition',
      );
      wrap(
        navigator.geolocation as unknown as Record<string, unknown>,
        'watchPosition',
        'geolocation.watchPosition',
      );
    }
    if (navigator.mediaDevices) {
      wrap(
        navigator.mediaDevices as unknown as Record<string, unknown>,
        'getUserMedia',
        'mediaDevices.getUserMedia',
      );
    }
    if (navigator.clipboard) {
      wrap(navigator.clipboard as unknown as Record<string, unknown>, 'read', 'clipboard.read');
      wrap(navigator.clipboard as unknown as Record<string, unknown>, 'write', 'clipboard.write');
      wrap(navigator.clipboard as unknown as Record<string, unknown>, 'readText', 'clipboard.readText');
      wrap(navigator.clipboard as unknown as Record<string, unknown>, 'writeText', 'clipboard.writeText');
    }
  });

  const current: Observations = {
    consoleErrors: [],
    pageErrors: [],
    externalRequests: [],
  };
  observations.set(page, current);
  page.on('console', message => {
    if (message.type() === 'error') current.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => current.pageErrors.push(error.message));
  page.on('request', request => {
    if (isUnexpectedExternalRequest(page, request)) current.externalRequests.push(request.url());
  });
  await page.goto(hostUrl);
});

test.afterEach(async ({ page }) => {
  const current = observations.get(page);
  expect(current?.consoleErrors ?? []).toEqual([]);
  expect(current?.pageErrors ?? []).toEqual([]);
  expect(current?.externalRequests ?? []).toEqual([]);

  const frame = page.frames().find(candidate => /\/apps\/transit-board\.html/.test(candidate.url()));
  if (frame) {
    const effects = await frame.evaluate(() => (
      (window as Window & { __metroSecurityEffects?: string[] }).__metroSecurityEffects ?? []
    ));
    expect(effects).toEqual([]);
  }
});

for (const toolName of TOOL_NAMES) {
  test(`${toolName} renders its dedicated view instead of raw JSON`, async ({ page }) => {
    const frame = await selectScenario(page, toolName);
    await expect(frame.locator('h1')).toHaveCount(1);
    await expect(frame.locator('pre, code')).toHaveCount(0);
    const text = await frame.locator('#transit-board').innerText();
    expect(text).not.toContain('{"city"');
    expect(text).not.toContain('"structuredContent"');
  });
}

test('captures review screenshots for all five visual families', async ({ page }) => {
  mkdirSync('output/playwright', { recursive: true });
  const representatives = [
    ['arrival', 'get_station_predictions'],
    ['service', 'get_incidents'],
    ['network', 'get_all_stations'],
    ['route', 'get_bus_routes'],
    ['vehicle', 'get_bus_positions'],
  ] as const;
  for (const [family, toolName] of representatives) {
    const frame = await selectScenario(page, toolName);
    expect(TOOL_CASES[toolName].family).toBe(family);
    await frame.locator('#transit-board').screenshot({
      path: `output/playwright/${family}.png`,
    });
  }
});

test('delivers exact input/result/context and refreshes with immutable original arguments', async ({ page }) => {
  const frame = await selectScenario(page, 'search_stations');
  const initial = await snapshot(page);
  expect(initial.deliveries.map(delivery => delivery.method)).toEqual([
    'ui/initialize:host-context',
    'ui/notifications/tool-input',
    'ui/notifications/tool-result',
  ]);
  expect(initial.deliveries[0]?.params).toEqual({
    toolInfo: {
      id: 'fixture-2',
      tool: {
        name: 'search_stations',
        inputSchema: { type: 'object' },
      },
    },
    theme: 'light',
    styles: {
      variables: {
        '--color-background-primary': 'color-mix(in oklab, oklch(0.97 0.01 90) 94%, oklch(0.76 0.05 160))',
        '--color-background-secondary': 'oklch(0.985 0.008 91)',
        '--color-text-primary': 'oklch(0.22 0.02 82)',
        '--color-text-secondary': 'oklch(0.45 0.025 82)',
        '--color-text-info': 'oklch(0.46 0.11 61)',
        '--color-border-primary': 'oklch(0.78 0.02 84)',
        '--color-ring-primary': 'oklch(0.5 0.16 55)',
        '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", sans-serif',
      },
    },
    displayMode: 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: 736, maxHeight: 1_200 },
    locale: 'en-US',
    timeZone: 'America/New_York',
    userAgent: 'metro-mcp-apps-reference-host/1.0.0',
    platform: 'web',
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  expect(initial.deliveries[1]?.params).toEqual({
    arguments: { city: 'nyc', query: 'Times Square' },
  });
  expect(initial.deliveries[2]?.params).toEqual(
    resultFor('search_stations', 'ready'),
  );

  await frame.getByRole('searchbox', { name: 'Filter stations' }).fill('127');
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(async () => (await snapshot(page)).calls.length).toBe(1);
  expect((await snapshot(page)).calls).toEqual([{
    name: 'search_stations',
    arguments: { city: 'nyc', query: 'Times Square' },
  }]);
  await expect(frame.getByRole('status')).toHaveText('Transit data refreshed.');
});

test('keeps controls keyboard reachable, named, and visibly focused', async ({ page }) => {
  const frame = await selectScenario(page, 'search_stations');
  const refresh = frame.getByRole('button', { name: 'Refresh' });
  const fullscreen = frame.getByRole('button', { name: 'Enter fullscreen' });
  const search = frame.getByRole('searchbox', { name: 'Filter stations' });
  await expect(refresh).toBeEnabled();
  await expect(fullscreen).toBeVisible();
  await expect(search).toBeVisible();

  await refresh.focus();
  await page.keyboard.press('Tab');
  await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  expect(await search.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
});

test('reflows at an actual 320 CSS pixel iframe without horizontal overflow', async ({ page }) => {
  await page.locator('#width-control').selectOption('320');
  const frame = await selectScenario(page, 'get_all_stations');
  await expect.poll(() => frame.evaluate(() => window.innerWidth)).toBe(320);
  const layout = await frame.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    boardRight: document.querySelector('#transit-board')?.getBoundingClientRect().right,
  }));
  expect(layout).toEqual({ innerWidth: 320, documentWidth: 320, boardRight: 320 });
});

test('applies host-native modern colors/fonts, themes, fullscreen, and safe areas', async ({ page }) => {
  const frame = await selectScenario(page, 'get_incidents');
  const board = frame.locator('#transit-board');
  const initialStyles = await board.evaluate(element => ({
    font: element.style.getPropertyValue('--font-ui'),
    canvas: element.style.getPropertyValue('--board-canvas'),
    background: getComputedStyle(element).backgroundColor,
  }));
  expect(initialStyles.font).toContain('-apple-system');
  expect(initialStyles.canvas).toContain('color-mix(in oklab');

  await page.locator('#theme-control').selectOption('dark');
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => board.evaluate(element => getComputedStyle(element).backgroundColor))
    .not.toBe(initialStyles.background);

  await page.locator('#safe-area-control').selectOption('on');
  const padding = await board.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      top: Number.parseFloat(style.paddingTop),
      right: Number.parseFloat(style.paddingRight),
      bottom: Number.parseFloat(style.paddingBottom),
      left: Number.parseFloat(style.paddingLeft),
    };
  });
  expect(padding.top).toBeGreaterThanOrEqual(12);
  expect(padding.right).toBeGreaterThanOrEqual(16);
  expect(padding.bottom).toBeGreaterThanOrEqual(20);
  expect(padding.left).toBeGreaterThanOrEqual(24);

  await frame.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(board).toHaveAttribute('data-display-mode', 'fullscreen');
  await expect(frame.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  expect((await snapshot(page)).displayRequests).toEqual(['fullscreen']);
});

test('exposes deterministic empty and error states from host controls', async ({ page }) => {
  let frame = await selectScenario(page, 'get_incidents', 'empty');
  await expect(frame.locator('[data-empty-state]')).toHaveText(
    'No active service incidents are reported.',
  );

  frame = await selectScenario(page, 'get_incidents', 'error');
  await expect(frame.locator('[data-state="error"]')).toContainText(
    'Fixture transit provider unavailable.',
  );
});

test('renders hostile transit strings only as text', async ({ page }) => {
  const frame = await selectScenario(page, 'get_incidents', 'hostile');
  await expect(frame.locator('.service-description')).toContainText(HOSTILE_TEXT);
  await expect(frame.locator('.service-description img, .service-description script')).toHaveCount(0);
  expect(await frame.evaluate(() => (
    (globalThis as typeof globalThis & { hostileExecuted?: boolean }).hostileExecuted
  ))).toBeUndefined();
});

test('records only expected official-protocol effects', async ({ page }) => {
  await selectScenario(page, 'get_station_predictions');
  const current = await snapshot(page);
  expect(current.unexpectedProtocol).toEqual([]);
  expect(current.sizeChanges.length).toBeGreaterThan(0);
  expect(current.sizeChanges.every(change => (
    typeof change.width === 'number' && typeof change.height === 'number'
  ))).toBe(true);
});
