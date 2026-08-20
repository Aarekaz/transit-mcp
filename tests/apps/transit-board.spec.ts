import { mkdirSync } from 'node:fs';
import type { Frame, Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';
import appsConfig from '../../playwright.apps.config';
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
  bridgeEvents: BridgeEvent[];
  protocol?: {
    direction: 'app-to-host' | 'host-to-app';
    kind?: 'request' | 'notification' | 'success-response' | 'error-response' | 'malformed';
    sequence: number;
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }[];
  protocolViolations?: ProtocolViolation[];
  pendingProtocol?: {
    direction: 'app-to-host' | 'host-to-app';
    sequence: number;
    id: string | number;
    method: string;
  }[];
};

type BridgeEvent = {
  name: 'error';
  sequence: number;
  message: string;
} | {
  name: 'sandboxready';
  sequence: number;
};

type ExpectedBridgeEvent = {
  name: BridgeEvent['name'];
  sequence: number;
  messageIncludes?: string;
};

type ProtocolViolation = {
  kind: 'unsolicited-response' | 'duplicate-response' | 'mismatched-response' | 'malformed';
  direction: 'app-to-host' | 'host-to-app';
  sequence: number;
  id?: unknown;
};

type PendingProtocolRequest = {
  direction: 'app-to-host' | 'host-to-app';
  sequence: number;
  id: string | number;
  method: string;
};

type Observations = {
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
  webSockets: string[];
  securityEffects: string[];
  expectedConsoleErrors: string[];
  expectedSecurityEffects: string[];
  expectedExternalRequests: string[];
  expectedWebSockets: string[];
  expectedUnexpectedProtocol: string[];
  expectedProtocolViolations: ProtocolViolation[];
  expectedPendingProtocol: PendingProtocolRequest[];
  expectedBridgeEvents: BridgeEvent[];
};

const observations = new WeakMap<Page, Observations>();
const hostUrl = '/tests/apps/host.html';

test('uses Playwright-managed Chromium and a dedicated gate server', async ({ browserName }, testInfo) => {
  const webServers = Array.isArray(appsConfig.webServer)
    ? appsConfig.webServer
    : [appsConfig.webServer];

  expect(browserName).toBe('chromium');
  expect(testInfo.project.use.channel).toBeUndefined();
  expect(appsConfig.use?.channel).toBeUndefined();
  expect(webServers).toHaveLength(1);
  expect(webServers[0]?.reuseExistingServer).toBe(false);
});

function isUnexpectedExternalRequest(page: Page, request: Request): boolean {
  const url = new URL(request.url());
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  if (url.hostname !== '127.0.0.1' || url.port !== '4178') return true;
  if (request.frame() === page.mainFrame()) return false;
  return request.resourceType() !== 'document'
    || url.pathname !== '/apps/transit-board.html';
}

function isUnexpectedWebSocket(urlValue: string): boolean {
  const url = new URL(urlValue);
  return url.hostname !== '127.0.0.1'
    || url.port !== '4178'
    || url.pathname !== '/'
    || !url.searchParams.has('token');
}

async function appFrame(page: Page): Promise<Frame> {
  const iframe = page.locator('#app-frame');
  await expect(iframe).toBeVisible();
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) {
    throw new Error('Transit Board iframe did not load.');
  }
  await expect(frame.locator('#transit-board')).toBeVisible();
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

async function securityEffects(page: Page): Promise<string[]> {
  return [...(observations.get(page)?.securityEffects ?? [])];
}

async function acknowledgeSecurityEffects(page: Page, expected: string[]): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedSecurityEffects.length;
  await expect.poll(() => current.securityEffects.length).toBeGreaterThanOrEqual(
    start + expected.length,
  );
  expect(current.securityEffects.slice(start)).toEqual(expected);
  current.expectedSecurityEffects.push(...expected);
}

async function acknowledgeWebSockets(page: Page, expected: string[]): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedWebSockets.length;
  await expect.poll(() => current.webSockets.length).toBeGreaterThanOrEqual(
    start + expected.length,
  );
  expect(current.webSockets.slice(start)).toEqual(expected);
  current.expectedWebSockets.push(...expected);
}

async function acknowledgeConsoleErrors(page: Page, expectedFragments: string[]): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedConsoleErrors.length;
  await expect.poll(() => current.consoleErrors.length).toBeGreaterThanOrEqual(
    start + expectedFragments.length,
  );
  const actual = current.consoleErrors.slice(start);
  expect(actual).toHaveLength(expectedFragments.length);
  expectedFragments.forEach((fragment, index) => {
    expect(actual[index]).toContain(fragment);
  });
  current.expectedConsoleErrors.push(...actual);
}

async function acknowledgeUnexpectedProtocol(page: Page, expected: string[]): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedUnexpectedProtocol.length;
  await expect.poll(async () => (await snapshot(page)).unexpectedProtocol.length)
    .toBeGreaterThanOrEqual(start + expected.length);
  expect((await snapshot(page)).unexpectedProtocol.slice(start)).toEqual(expected);
  current.expectedUnexpectedProtocol.push(...expected);
}

async function acknowledgeProtocolViolations(
  page: Page,
  expected: ProtocolViolation[],
): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedProtocolViolations.length;
  await expect.poll(async () => ((await snapshot(page)).protocolViolations ?? []).length)
    .toBeGreaterThanOrEqual(start + expected.length);
  expect(((await snapshot(page)).protocolViolations ?? []).slice(start)).toEqual(expected);
  current.expectedProtocolViolations.push(...expected);
}

async function acknowledgePendingProtocol(
  page: Page,
  expected: PendingProtocolRequest[],
): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  await expect.poll(async () => ((await snapshot(page)).pendingProtocol ?? []).length)
    .toBeGreaterThanOrEqual(expected.length);
  expect((await snapshot(page)).pendingProtocol ?? []).toEqual(expected);
  current.expectedPendingProtocol = [...expected];
}

async function acknowledgeBridgeEvents(
  page: Page,
  expected: ExpectedBridgeEvent[],
): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  const start = current.expectedBridgeEvents.length;
  await expect.poll(async () => (await snapshot(page)).bridgeEvents.length)
    .toBeGreaterThanOrEqual(start + expected.length);
  const actual = (await snapshot(page)).bridgeEvents.slice(start);
  expect(actual).toHaveLength(expected.length);
  expected.forEach((event, index) => {
    expect(actual[index]?.name).toBe(event.name);
    expect(actual[index]?.sequence).toBe(event.sequence);
    if (event.messageIncludes === undefined) {
      expect(actual[index]).toEqual({ name: event.name, sequence: event.sequence });
    } else {
      expect(actual[index]).toEqual(expect.objectContaining({
        name: event.name,
        sequence: event.sequence,
        message: expect.stringContaining(event.messageIncludes),
      }));
    }
  });
  current.expectedBridgeEvents.push(...actual);
}

test.beforeEach(async ({ context, page }) => {
  const current: Observations = {
    consoleErrors: [],
    pageErrors: [],
    externalRequests: [],
    webSockets: [],
    securityEffects: [],
    expectedConsoleErrors: [],
    expectedSecurityEffects: [],
    expectedExternalRequests: [],
    expectedWebSockets: [],
    expectedUnexpectedProtocol: [],
    expectedProtocolViolations: [],
    expectedPendingProtocol: [],
    expectedBridgeEvents: [],
  };
  observations.set(page, current);
  await page.exposeBinding('__metroRecordSecurityEffect', (_source, effect: unknown) => {
    if (typeof effect === 'string') current.securityEffects.push(effect);
  });
  await context.addInitScript(() => {
    const record = (name: string): void => {
      const binding = (globalThis as typeof globalThis & {
        __metroRecordSecurityEffect?: (effect: string) => Promise<void>;
      }).__metroRecordSecurityEffect;
      if (binding) void binding(name);
    };

    const propertyOwner = (target: object, key: PropertyKey): object | undefined => {
      let owner: object | null = target;
      while (owner) {
        if (Object.prototype.hasOwnProperty.call(owner, key)) return owner;
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      return undefined;
    };
    const wrapMethod = (
      target: object,
      key: string,
      label: string,
    ): void => {
      const owner = propertyOwner(target, key);
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      const original = descriptor?.value;
      if (typeof original !== 'function') return;
      Object.defineProperty(owner, key, {
        ...descriptor,
        value: function wrapped(this: unknown, ...args: unknown[]): unknown {
          record(label);
          return Reflect.apply(original, this, args);
        },
      });
    };
    const wrapConstructor = (key: 'WebSocket' | 'EventSource' | 'XMLHttpRequest'): void => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      const original = descriptor?.value;
      if (typeof original !== 'function') return;
      const wrapped = new Proxy(original, {
        construct(target, args, newTarget) {
          const isParentHmrSocket = key === 'WebSocket'
            && window === window.top
            && (() => {
              try {
                const url = new URL(String(args[0]), window.location.href);
                return url.hostname === '127.0.0.1'
                  && url.port === '4178'
                  && url.pathname === '/'
                  && url.searchParams.has('token');
              } catch {
                return false;
              }
            })();
          if (!isParentHmrSocket) record(`network.${key}.construct`);
          return Reflect.construct(target, args, newTarget);
        },
      });
      Object.defineProperty(globalThis, key, { ...descriptor, value: wrapped });
    };
    const wrapGetter = (
      target: object,
      key: string,
      label: string,
      transform?: (value: unknown) => unknown,
    ): void => {
      const owner = propertyOwner(target, key);
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor?.get || descriptor.configurable !== true) return;
      const originalGet = descriptor.get;
      Object.defineProperty(owner, key, {
        ...descriptor,
        get(this: unknown): unknown {
          record(label);
          const value = Reflect.apply(originalGet, this, []);
          return transform ? transform(value) : value;
        },
      });
    };
    const wrapSetterAndGetter = (
      target: object,
      key: string,
      label: string,
    ): void => {
      const owner = propertyOwner(target, key);
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || descriptor.configurable !== true) return;
      Object.defineProperty(owner, key, {
        ...descriptor,
        ...(descriptor.get
          ? {
              get(this: unknown): unknown {
                record(`${label}.get`);
                return Reflect.apply(descriptor.get as () => unknown, this, []);
              },
            }
          : {}),
        ...(descriptor.set
          ? {
              set(this: unknown, value: unknown): void {
                record(`${label}.set`);
                Reflect.apply(descriptor.set as (next: unknown) => void, this, [value]);
              },
            }
          : {}),
      });
    };
    const storageProxies = new WeakMap<object, Map<string, object>>();
    const storageProxy = (storage: unknown, label: string): unknown => {
      if (!(storage instanceof Storage)) return storage;
      const existing = storageProxies.get(storage)?.get(label);
      if (existing) return existing;
      const methodCache = new Map<PropertyKey, unknown>();
      const proxy = new Proxy(storage, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (methodCache.has(property)) return methodCache.get(property);
          const wrapped = (...args: unknown[]): unknown => {
            record(`${label}.method.${String(property)}`);
            return Reflect.apply(value, target, args);
          };
          methodCache.set(property, wrapped);
          return wrapped;
        },
        set(target, property, value) {
          record(`${label}.property.set`);
          return Reflect.set(target, property, value, target);
        },
        deleteProperty(target, property) {
          record(`${label}.property.delete`);
          return Reflect.deleteProperty(target, property);
        },
        defineProperty(target, property, descriptor) {
          record(`${label}.property.define`);
          return Reflect.defineProperty(target, property, descriptor);
        },
      });
      const labels = storageProxies.get(storage) ?? new Map<string, object>();
      labels.set(label, proxy);
      storageProxies.set(storage, labels);
      return proxy;
    };
    const instrumentNavigatorProperty = (
      key: 'permissions' | 'geolocation' | 'clipboard' | 'mediaDevices',
      label: string,
      methods: string[],
    ): void => {
      let value: unknown;
      try {
        value = Reflect.get(navigator, key);
      } catch {
        value = undefined;
      }
      if (typeof value === 'object' && value !== null) {
        for (const method of methods) {
          wrapMethod(value, method, `${label}.${method}`);
        }
      }
      wrapGetter(navigator, key, `${label}.get`);
    };

    wrapMethod(globalThis, 'fetch', 'network.fetch');
    wrapConstructor('WebSocket');
    wrapConstructor('EventSource');
    wrapConstructor('XMLHttpRequest');
    wrapMethod(XMLHttpRequest.prototype, 'open', 'network.XMLHttpRequest.open');
    wrapMethod(XMLHttpRequest.prototype, 'send', 'network.XMLHttpRequest.send');

    wrapGetter(window, 'localStorage', 'storage.localStorage.get', value => (
      storageProxy(value, 'storage.localStorage')
    ));
    wrapGetter(window, 'sessionStorage', 'storage.sessionStorage.get', value => (
      storageProxy(value, 'storage.sessionStorage')
    ));
    wrapGetter(window, 'indexedDB', 'storage.indexedDB.get');
    for (const method of ['open', 'deleteDatabase', 'databases', 'cmp']) {
      wrapMethod(IDBFactory.prototype, method, `storage.indexedDB.method.${method}`);
    }
    wrapSetterAndGetter(document, 'cookie', 'storage.cookie');

    instrumentNavigatorProperty('permissions', 'permissions', ['query']);
    instrumentNavigatorProperty(
      'geolocation',
      'geolocation',
      ['getCurrentPosition', 'watchPosition', 'clearWatch'],
    );
    instrumentNavigatorProperty(
      'clipboard',
      'clipboard',
      ['read', 'write', 'readText', 'writeText'],
    );
    instrumentNavigatorProperty(
      'mediaDevices',
      'mediaDevices',
      ['enumerateDevices', 'getUserMedia', 'getDisplayMedia', 'selectAudioOutput'],
    );
    for (const method of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia']) {
      wrapMethod(navigator, method, `mediaDevices.${method}`);
    }
  });

  page.on('console', message => {
    if (message.type() === 'error') current.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => current.pageErrors.push(error.message));
  page.on('request', request => {
    if (isUnexpectedExternalRequest(page, request)) current.externalRequests.push(request.url());
  });
  page.on('websocket', socket => {
    if (isUnexpectedWebSocket(socket.url())) current.webSockets.push(socket.url());
  });
  await page.goto(hostUrl);
});

test.afterEach(async ({ page }) => {
  const current = observations.get(page);
  expect(current?.consoleErrors ?? []).toEqual(current?.expectedConsoleErrors ?? []);
  expect(current?.pageErrors ?? []).toEqual([]);
  expect(current?.externalRequests ?? []).toEqual(current?.expectedExternalRequests ?? []);
  expect(current?.webSockets ?? []).toEqual(current?.expectedWebSockets ?? []);
  expect(await securityEffects(page)).toEqual(current?.expectedSecurityEffects ?? []);
  const currentSnapshot = await snapshot(page);
  expect(currentSnapshot.unexpectedProtocol).toEqual(
    current?.expectedUnexpectedProtocol ?? [],
  );
  expect(currentSnapshot.protocolViolations ?? []).toEqual(
    current?.expectedProtocolViolations ?? [],
  );
  expect(currentSnapshot.pendingProtocol ?? []).toEqual(current?.expectedPendingProtocol ?? []);
  expect(currentSnapshot.bridgeEvents).toEqual(current?.expectedBridgeEvents ?? []);
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

test('exposes a dedicated empty state for all thirteen tools', async ({ page }) => {
  for (const toolName of TOOL_NAMES) {
    const frame = await selectScenario(page, toolName, 'empty');
    await expect(frame.locator('[data-empty-state]')).toBeVisible();
    await expect(frame.locator('[role="alert"]')).toHaveCount(0);
  }
});

test('exposes the deterministic error state from host controls', async ({ page }) => {
  const frame = await selectScenario(page, 'get_incidents', 'error');
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
  const frame = await selectScenario(page, 'search_stations');
  await page.evaluate(() => new Promise<void>(resolve => {
    const method = 'task6/parent-source-spoof';
    const receive = (event: MessageEvent): void => {
      if ((event.data as { method?: unknown })?.method !== method) return;
      window.removeEventListener('message', receive);
      resolve();
    };
    window.addEventListener('message', receive);
    window.postMessage({ jsonrpc: '2.0', method }, '*');
  }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(async () => (await snapshot(page)).calls.length).toBe(1);
  await frame.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(frame.locator('#transit-board')).toHaveAttribute('data-display-mode', 'fullscreen');

  const current = await snapshot(page);
  expect(current.unexpectedProtocol).toEqual([]);
  expect(current.sizeChanges.length).toBeGreaterThan(0);
  expect(current.sizeChanges.every(change => (
    typeof change.width === 'number' && typeof change.height === 'number'
  ))).toBe(true);

  const protocol = current.protocol ?? [];
  const inbound = protocol.filter(entry => (
    entry.direction === 'app-to-host'
    && (entry.kind === 'request' || entry.kind === 'notification')
  ));
  const outbound = protocol.filter(entry => (
    entry.direction === 'host-to-app'
    && (entry.kind === 'request' || entry.kind === 'notification')
  ));
  expect([...new Set(inbound.map(entry => entry.method))].sort()).toEqual([
    'tools/call',
    'ui/initialize',
    'ui/notifications/initialized',
    'ui/notifications/size-changed',
    'ui/request-display-mode',
  ]);
  expect(inbound.filter(entry => entry.method === 'ui/initialize')).toHaveLength(2);
  expect(inbound.filter(entry => entry.method === 'ui/initialize').map(entry => entry.sequence))
    .toEqual([1, 2]);
  expect(inbound.filter(entry => entry.method === 'ui/notifications/initialized')).toHaveLength(2);
  expect(inbound
    .filter(entry => entry.method === 'ui/notifications/initialized')
    .map(entry => entry.sequence)).toEqual([1, 2]);
  expect(inbound.filter(entry => entry.method === 'tools/call')).toHaveLength(1);
  expect(inbound.filter(entry => entry.method === 'ui/request-display-mode')).toHaveLength(1);
  const sizeNotifications = inbound.filter(
    entry => entry.method === 'ui/notifications/size-changed',
  );
  expect(sizeNotifications.filter(entry => entry.sequence === 1).length).toBeGreaterThan(0);
  expect(sizeNotifications.filter(entry => entry.sequence === 2))
    .toHaveLength(current.sizeChanges.length);
  expect([...new Set(sizeNotifications.map(entry => entry.sequence))]).toEqual([1, 2]);
  expect([...new Set(outbound.map(entry => entry.method))].sort()).toEqual([
    'ui/notifications/host-context-changed',
    'ui/notifications/tool-input',
    'ui/notifications/tool-result',
    'ui/resource-teardown',
  ]);
  expect(outbound.filter(entry => entry.method === 'ui/resource-teardown')).toHaveLength(1);
  expect(outbound
    .filter(entry => entry.method === 'ui/resource-teardown')
    .map(entry => entry.sequence)).toEqual([1]);
  expect(outbound.filter(entry => entry.method === 'ui/notifications/tool-input')).toHaveLength(2);
  expect(outbound.filter(entry => entry.method === 'ui/notifications/tool-result')).toHaveLength(2);
  expect(outbound.filter(entry => entry.method === 'ui/notifications/host-context-changed'))
    .toHaveLength(1);
  const requests = protocol.filter(entry => entry.kind === 'request');
  expect(requests.map(entry => ({
    direction: entry.direction,
    sequence: entry.sequence,
    method: entry.method,
  }))).toEqual([
    { direction: 'app-to-host', sequence: 1, method: 'ui/initialize' },
    { direction: 'host-to-app', sequence: 1, method: 'ui/resource-teardown' },
    { direction: 'app-to-host', sequence: 2, method: 'ui/initialize' },
    { direction: 'app-to-host', sequence: 2, method: 'tools/call' },
    { direction: 'app-to-host', sequence: 2, method: 'ui/request-display-mode' },
  ]);
  const successResponses = protocol.filter(entry => entry.kind === 'success-response');
  expect(successResponses).toHaveLength(5);
  for (const request of requests) {
    expect(successResponses.filter(response => (
      response.direction !== request.direction
      && response.sequence === request.sequence
      && response.id === request.id
    ))).toHaveLength(1);
  }
  expect(protocol.some(entry => entry.kind === 'error-response')).toBe(false);
  expect(protocol.some(entry => entry.kind === 'malformed')).toBe(false);
  expect(current.protocolViolations ?? []).toEqual([]);
  expect(current.pendingProtocol ?? []).toEqual([]);
  expect(current.bridgeEvents).toEqual([]);
});

test('records and rejects an unexpected official sandbox-ready notification', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-proxy-ready',
      params: {},
    }, '*');
  });

  await acknowledgeUnexpectedProtocol(page, ['ui/notifications/sandbox-proxy-ready']);
  await acknowledgeBridgeEvents(page, [{ name: 'sandboxready', sequence: 1 }]);
  expect((await snapshot(page)).protocol ?? []).toContainEqual(expect.objectContaining({
    direction: 'app-to-host',
    method: 'ui/notifications/sandbox-proxy-ready',
  }));
});

test('does not let a hybrid security marker hide JSON-RPC from the host', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      type: 'metro-mcp-apps-security-effect',
      effect: 'network.hybrid-probe',
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-proxy-ready',
    }, '*');
  });

  await expect.poll(() => securityEffects(page)).toEqual([]);
  await acknowledgeProtocolViolations(page, [{
    kind: 'malformed',
    direction: 'app-to-host',
    sequence: 1,
  }]);
  await acknowledgeConsoleErrors(page, ['Failed to parse message']);
  await acknowledgeBridgeEvents(page, [{
    name: 'error',
    sequence: 1,
    messageIncludes: 'Invalid JSON-RPC message received',
  }]);
  const current = await snapshot(page);
  expect(current.protocol ?? []).toContainEqual(expect.objectContaining({
    direction: 'app-to-host',
    kind: 'malformed',
    method: 'ui/notifications/sandbox-proxy-ready',
  }));
  expect(current.bridgeEvents).toContainEqual(expect.objectContaining({
    name: 'error',
    sequence: 1,
    message: expect.stringContaining('Invalid JSON-RPC message received'),
  }));
});

test('surfaces Apps-invalid params even when generic JSON-RPC ledgers are clean', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: 'not-a-number', height: 275 },
    }, '*');
  });

  await expect.poll(async () => (await snapshot(page)).bridgeEvents.length).toBe(1);
  await acknowledgeBridgeEvents(page, [{
    name: 'error',
    sequence: 1,
    messageIncludes: 'Uncaught error in notification handler',
  }]);
  const current = await snapshot(page);
  expect(current.bridgeEvents).toEqual([{
    name: 'error',
    sequence: 1,
    message: expect.stringContaining('Uncaught error in notification handler'),
  }]);
  expect(current.unexpectedProtocol).toEqual([]);
  expect(current.protocolViolations ?? []).toEqual([]);
  expect(current.pendingProtocol ?? []).toEqual([]);
});

test('does not acknowledge an unrelated AppBridge error', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: 'first-invalid-width', height: 275 },
    }, '*');
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: 320, height: 'second-invalid-height' },
    }, '*');
  });

  const oneError = [{
    name: 'error' as const,
    sequence: 1,
    messageIncludes: 'Uncaught error in notification handler',
  }];
  await expect(acknowledgeBridgeEvents(page, oneError)).rejects.toThrow();
  await acknowledgeBridgeEvents(page, [...oneError, ...oneError]);
});

test('records unsolicited success and error responses as protocol violations', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'task6-unsolicited-success',
      result: { ok: true },
    }, '*');
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'task6-unsolicited-error',
      error: { code: -32_000, message: 'Task 6 probe' },
    }, '*');
    window.parent.postMessage({
      jsonrpc: '2.0',
      error: { code: -32_600, message: 'Task 6 idless probe' },
    }, '*');
  });

  await acknowledgeProtocolViolations(page, [
    {
      kind: 'unsolicited-response',
      direction: 'app-to-host',
      sequence: 1,
      id: 'task6-unsolicited-success',
    },
    {
      kind: 'unsolicited-response',
      direction: 'app-to-host',
      sequence: 1,
      id: 'task6-unsolicited-error',
    },
    {
      kind: 'unsolicited-response',
      direction: 'app-to-host',
      sequence: 1,
    },
  ]);
  await acknowledgeBridgeEvents(page, [
    {
      name: 'error',
      sequence: 1,
      messageIncludes: 'Received a response for an unknown message ID',
    },
    {
      name: 'error',
      sequence: 1,
      messageIncludes: 'Received a response for an unknown message ID',
    },
    {
      name: 'error',
      sequence: 1,
      messageIncludes: 'Received a response for an unknown message ID',
    },
  ]);
  const protocol = (await snapshot(page)).protocol ?? [];
  expect(protocol).toContainEqual(expect.objectContaining({
    kind: 'success-response',
    id: 'task6-unsolicited-success',
    result: { ok: true },
  }));
  expect(protocol).toContainEqual(expect.objectContaining({
    kind: 'error-response',
    id: 'task6-unsolicited-error',
    error: { code: -32_000, message: 'Task 6 probe' },
  }));
  expect(protocol).toContainEqual(expect.objectContaining({
    kind: 'error-response',
    error: { code: -32_600, message: 'Task 6 idless probe' },
  }));
});

test('records a response with the wrong direction as mismatched', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  const initialize = ((await snapshot(page)).protocol ?? []).find(entry => (
    entry.direction === 'app-to-host'
    && entry.kind === 'request'
    && entry.method === 'ui/initialize'
  ));
  expect(initialize?.id).toEqual(expect.anything());

  await frame.evaluate(id => {
    window.parent.postMessage({ jsonrpc: '2.0', id, result: {} }, '*');
  }, initialize?.id);

  await acknowledgeProtocolViolations(page, [{
    kind: 'mismatched-response',
    direction: 'app-to-host',
    sequence: 1,
    id: initialize?.id,
  }]);
  await acknowledgeBridgeEvents(page, [{
    name: 'error',
    sequence: 1,
    messageIncludes: 'Received a response for an unknown message ID',
  }]);
});

test('records a source-valid duplicate response instead of dropping it', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await page.evaluate(async () => {
    const harness = (window as Window & {
      __metroAppsHarness: { teardownActive(): Promise<void> };
    }).__metroAppsHarness;
    await harness.teardownActive();
  });
  const completed = await snapshot(page);
  const response = (completed.protocol ?? []).find(entry => (
    entry.direction === 'app-to-host'
    && entry.kind === 'success-response'
    && entry.sequence === 1
  ));
  expect(response?.id).toEqual(expect.anything());

  await frame.evaluate(id => {
    window.parent.postMessage({ jsonrpc: '2.0', id, result: {} }, '*');
  }, response?.id);

  await acknowledgeProtocolViolations(page, [{
    kind: 'duplicate-response',
    direction: 'app-to-host',
    sequence: 1,
    id: response?.id,
  }]);
  await acknowledgeBridgeEvents(page, [{
    name: 'error',
    sequence: 1,
    messageIncludes: 'Received a response for an unknown message ID',
  }]);
  expect(((await snapshot(page)).protocol ?? []).filter(entry => (
    entry.direction === 'app-to-host'
    && entry.kind === 'success-response'
    && entry.sequence === 1
    && entry.id === response?.id
  ))).toHaveLength(2);
});

test('keeps a source-valid request visible when its response is missing', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await page.evaluate(async () => {
    const harness = (window as Window & {
      __metroAppsHarness: { closeActiveForProbe(): Promise<void> };
    }).__metroAppsHarness;
    await harness.closeActiveForProbe();
  });
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'task6-missing-response',
      method: 'task6/missing-response',
      params: { probe: true },
    }, '*');
  });

  await acknowledgeUnexpectedProtocol(page, ['task6/missing-response']);
  await acknowledgePendingProtocol(page, [{
    direction: 'app-to-host',
    sequence: 1,
    id: 'task6-missing-response',
    method: 'task6/missing-response',
  }]);
});

test('records malformed source-valid JSON-RPC instead of dropping it', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'task6-malformed',
      method: 42,
      params: { probe: true },
    }, '*');
  });

  await acknowledgeProtocolViolations(page, [{
    kind: 'malformed',
    direction: 'app-to-host',
    sequence: 1,
    id: 'task6-malformed',
  }]);
  await acknowledgeConsoleErrors(page, ['Failed to parse message']);
  await acknowledgeBridgeEvents(page, [{
    name: 'error',
    sequence: 1,
    messageIncludes: 'Invalid JSON-RPC message received',
  }]);
  expect((await snapshot(page)).protocol ?? []).toContainEqual(expect.objectContaining({
    kind: 'malformed',
    id: 'task6-malformed',
    method: 42,
    params: { probe: true },
  }));
});

test('classifies safe, null, unsafe, and explicit-undefined values like the installed SDK', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await page.evaluate(async () => {
    const harness = (window as Window & {
      __metroAppsHarness: { closeActiveForProbe(): Promise<void> };
    }).__metroAppsHarness;
    await harness.closeActiveForProbe();
  });
  const before = await snapshot(page);
  const safeInteger = Number.MAX_SAFE_INTEGER;
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

  await frame.evaluate(({ safe, unsafe }) => {
    const post = (message: object): void => window.parent.postMessage(message, '*');
    post({
      jsonrpc: '2.0',
      id: safe,
      method: 'task6/sdk-safe-id',
      params: undefined,
    });
    post({
      jsonrpc: '2.0',
      id: 'task6-sdk-string-id',
      method: 'task6/sdk-string-id',
      params: undefined,
    });
    post({ jsonrpc: '2.0', id: unsafe, method: 'task6/sdk-unsafe-id' });
    post({ jsonrpc: '2.0', id: null, method: 'task6/sdk-null-id' });
    post({
      jsonrpc: '2.0',
      method: 'task6/sdk-undefined-params',
      params: undefined,
    });
    post({
      jsonrpc: '2.0',
      id: undefined,
      error: { code: -32_600, message: 'Task 6 explicit undefined ID' },
    });
    post({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32_600, message: 'Task 6 null ID' },
    });
    post({
      jsonrpc: '2.0',
      id: 'task6-sdk-unsafe-code',
      error: { code: unsafe, message: 'Task 6 unsafe error code' },
    });
    post({ jsonrpc: '2.0', id: safe - 1, result: { ok: true } });
    post({ jsonrpc: '2.0', id: unsafe, result: { ok: true } });
  }, { safe: safeInteger, unsafe: unsafeInteger });

  await expect.poll(async () => (await snapshot(page)).protocol?.length)
    .toBe((before.protocol?.length ?? 0) + 10);
  const current = await snapshot(page);
  const delta = (current.protocol ?? []).slice(before.protocol?.length ?? 0);
  expect(delta.map(record => ({
    kind: record.kind,
    ...('id' in record ? { id: record.id } : {}),
    ...('method' in record ? { method: record.method } : {}),
  }))).toStrictEqual([
    { kind: 'request', id: safeInteger, method: 'task6/sdk-safe-id' },
    { kind: 'request', id: 'task6-sdk-string-id', method: 'task6/sdk-string-id' },
    { kind: 'malformed', id: unsafeInteger, method: 'task6/sdk-unsafe-id' },
    { kind: 'malformed', id: null, method: 'task6/sdk-null-id' },
    { kind: 'notification', method: 'task6/sdk-undefined-params' },
    { kind: 'error-response', id: undefined },
    { kind: 'malformed', id: null },
    { kind: 'malformed', id: 'task6-sdk-unsafe-code' },
    { kind: 'success-response', id: safeInteger - 1 },
    { kind: 'malformed', id: unsafeInteger },
  ]);
  expect(Object.hasOwn(delta[0] ?? {}, 'params')).toBe(true);
  expect(delta[0]?.params).toBeUndefined();
  expect(Object.hasOwn(delta[1] ?? {}, 'params')).toBe(true);
  expect(delta[1]?.params).toBeUndefined();
  expect(Object.hasOwn(delta[4] ?? {}, 'params')).toBe(true);
  expect(delta[4]?.params).toBeUndefined();
  expect(Object.hasOwn(delta[5] ?? {}, 'id')).toBe(true);
  expect(delta[5]?.id).toBeUndefined();

  await acknowledgeUnexpectedProtocol(page, [
    'task6/sdk-safe-id',
    'task6/sdk-string-id',
    'task6/sdk-undefined-params',
  ]);
  await acknowledgeProtocolViolations(page, [
    { kind: 'malformed', direction: 'app-to-host', sequence: 1, id: unsafeInteger },
    { kind: 'malformed', direction: 'app-to-host', sequence: 1, id: null },
    { kind: 'unsolicited-response', direction: 'app-to-host', sequence: 1 },
    { kind: 'malformed', direction: 'app-to-host', sequence: 1, id: null },
    {
      kind: 'malformed',
      direction: 'app-to-host',
      sequence: 1,
      id: 'task6-sdk-unsafe-code',
    },
    {
      kind: 'unsolicited-response',
      direction: 'app-to-host',
      sequence: 1,
      id: safeInteger - 1,
    },
    { kind: 'malformed', direction: 'app-to-host', sequence: 1, id: unsafeInteger },
  ]);
  await acknowledgePendingProtocol(page, [
    {
      direction: 'app-to-host',
      sequence: 1,
      id: safeInteger,
      method: 'task6/sdk-safe-id',
    },
    {
      direction: 'app-to-host',
      sequence: 1,
      id: 'task6-sdk-string-id',
      method: 'task6/sdk-string-id',
    },
  ]);
});

test('detects WebSocket construction through both browser oracles', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  const url = 'ws://127.0.0.1:4178/task6-probe-websocket';
  await frame.evaluate(probeUrl => {
    try {
      const socket = new WebSocket(probeUrl);
      socket.close();
    } catch {
      // The constructor attempt is the forbidden effect under test.
    }
  }, url);

  await acknowledgeSecurityEffects(page, ['network.WebSocket.construct']);
  await acknowledgeWebSockets(page, [url]);
});

test('detects EventSource construction', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    try {
      const source = new EventSource('data:text/event-stream,data%3A%20probe%0A%0A');
      source.close();
    } catch {
      // The constructor attempt is the forbidden effect under test.
    }
  });

  await acknowledgeSecurityEffects(page, ['network.EventSource.construct']);
});

test('does not acknowledge an unrelated security effect', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    try {
      const source = new EventSource('data:text/event-stream,data%3A%20expected%0A%0A');
      source.close();
    } catch {
      // Constructor attempts are the observations under test.
    }
    void new XMLHttpRequest();
  });

  await expect(acknowledgeSecurityEffects(page, ['network.EventSource.construct']))
    .rejects.toThrow();
  await acknowledgeSecurityEffects(page, [
    'network.EventSource.construct',
    'network.XMLHttpRequest.construct',
  ]);
});

test('does not acknowledge an unrelated WebSocket', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  const expectedUrl = 'ws://127.0.0.1:4178/task6-expected-websocket';
  const unexpectedUrl = 'ws://127.0.0.1:4178/task6-unexpected-websocket';
  await frame.evaluate(({ first, second }) => {
    for (const url of [first, second]) {
      try {
        const socket = new WebSocket(url);
        socket.close();
      } catch {
        // Constructor attempts are the observations under test.
      }
    }
  }, { first: expectedUrl, second: unexpectedUrl });

  await expect(acknowledgeWebSockets(page, [expectedUrl])).rejects.toThrow();
  await acknowledgeWebSockets(page, [expectedUrl, unexpectedUrl]);
  await acknowledgeSecurityEffects(page, [
    'network.WebSocket.construct',
    'network.WebSocket.construct',
  ]);
});

test('does not acknowledge an unrelated console error', async ({ page }) => {
  await page.evaluate(() => {
    console.error('task6 expected console probe');
    console.error('task6 unrelated console probe');
  });

  await expect(acknowledgeConsoleErrors(page, ['task6 expected console probe']))
    .rejects.toThrow();
  await acknowledgeConsoleErrors(page, [
    'task6 expected console probe',
    'task6 unrelated console probe',
  ]);
});

test('does not acknowledge an unrelated protocol method', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'task6/expected-notification',
    }, '*');
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'task6/unrelated-notification',
    }, '*');
  });

  await expect(acknowledgeUnexpectedProtocol(page, ['task6/expected-notification']))
    .rejects.toThrow();
  await acknowledgeUnexpectedProtocol(page, [
    'task6/expected-notification',
    'task6/unrelated-notification',
  ]);
});

for (const [probe, expected] of [
  ['fetch', 'network.fetch'],
  ['XMLHttpRequest', 'network.XMLHttpRequest.construct'],
] as const) {
  test(`detects ${probe} use`, async ({ page }) => {
    const frame = await selectScenario(page, 'get_station_predictions');
    await frame.evaluate(async selected => {
      if (selected === 'fetch') {
        await fetch('data:text/plain,task6-probe');
        return;
      }
      void new XMLHttpRequest();
    }, probe);

    await acknowledgeSecurityEffects(page, [expected]);
  });
}

test('retains caught opaque-origin storage access across a remount', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    try {
      void window.localStorage;
    } catch {
      // Opaque-origin denial must still be observable by the parent oracle.
    }
  });
  await selectScenario(page, 'get_incidents');

  await acknowledgeSecurityEffects(page, ['storage.localStorage.get']);
});

for (const [storageName, label] of [
  ['localStorage', 'storage.localStorage'],
  ['sessionStorage', 'storage.sessionStorage'],
] as const) {
  test(`detects ${storageName} method and property mutations`, async ({ page }) => {
    await page.evaluate(selected => {
      const storage = selected === 'localStorage' ? window.localStorage : window.sessionStorage;
      storage.setItem('task6-probe-method', '1');
      (storage as Storage & { task6Probe?: string }).task6Probe = '2';
      delete (storage as Storage & { task6Probe?: string }).task6Probe;
      storage.removeItem('task6-probe-method');
    }, storageName);

    await acknowledgeSecurityEffects(page, [
      `${label}.get`,
      `${label}.method.setItem`,
      `${label}.property.set`,
      `${label}.property.delete`,
      `${label}.method.removeItem`,
    ]);
  });
}

test('records storage access without changing normal storage outcomes', async ({ page }) => {
  const result = await page.evaluate(() => {
    const first = window.localStorage;
    const second = window.localStorage;
    first.setItem('task6-probe-outcome', 'preserved');
    const value = second.getItem('task6-probe-outcome');
    second.removeItem('task6-probe-outcome');
    return { sameObject: first === second, value };
  });

  expect(result).toEqual({ sameObject: true, value: 'preserved' });
  await acknowledgeSecurityEffects(page, [
    'storage.localStorage.get',
    'storage.localStorage.get',
    'storage.localStorage.method.setItem',
    'storage.localStorage.method.getItem',
    'storage.localStorage.method.removeItem',
  ]);
});

test('detects IndexedDB access', async ({ page }) => {
  await page.evaluate(() => {
    indexedDB.cmp(1, 1);
  });

  await acknowledgeSecurityEffects(page, [
    'storage.indexedDB.get',
    'storage.indexedDB.method.cmp',
  ]);
});

test('detects cookie reads and writes', async ({ page }) => {
  await page.evaluate(() => {
    void document.cookie;
    document.cookie = 'task6-probe=1; Max-Age=0; SameSite=Strict';
  });

  await acknowledgeSecurityEffects(page, ['storage.cookie.get', 'storage.cookie.set']);
});

test('detects Permissions API access', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(async () => {
    try {
      await navigator.permissions.query({ name: 'geolocation' });
    } catch {
      // Access remains forbidden even when the opaque sandbox rejects it.
    }
  });

  await acknowledgeSecurityEffects(page, ['permissions.get', 'permissions.query']);
});

for (const [property, expected] of [
  ['geolocation', ['geolocation.get', 'geolocation.getCurrentPosition']],
  ['clipboard', ['clipboard.get', 'clipboard.readText']],
  ['mediaDevices', ['mediaDevices.get', 'mediaDevices.enumerateDevices']],
] as const) {
  test(`detects navigator.${property} access`, async ({ page }) => {
    const frame = await selectScenario(page, 'get_station_predictions');
    await frame.evaluate(async selected => {
      try {
        if (selected === 'geolocation') {
          navigator.geolocation.getCurrentPosition(() => undefined, () => undefined);
        } else if (selected === 'clipboard') {
          await navigator.clipboard.readText();
        } else {
          await navigator.mediaDevices.enumerateDevices();
        }
      } catch {
        // The sandbox may reject the call; the attempt must remain observable.
      }
    }, property);

    await acknowledgeSecurityEffects(page, [...expected]);
    if (property === 'geolocation') {
      await acknowledgeConsoleErrors(page, ['Geolocation access has been blocked']);
    }
  });
}
