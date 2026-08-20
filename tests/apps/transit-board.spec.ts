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
  protocol?: {
    direction: 'app-to-host' | 'host-to-app';
    method: string;
    sequence: number;
    params?: unknown;
  }[];
};

type Observations = {
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
  webSockets: string[];
  expectedConsoleErrors: string[];
  expectedSecurityEffects: string[];
  expectedExternalRequests: string[];
  expectedWebSockets: string[];
  expectedUnexpectedProtocol: string[];
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
  return page.evaluate(() => (
    (window as Window & { __metroSecurityEffects?: string[] }).__metroSecurityEffects ?? []
  ));
}

async function acknowledgeSecurityEffects(page: Page, expected: string[]): Promise<void> {
  await expect.poll(() => securityEffects(page)).toEqual(expect.arrayContaining(expected));
  const actual = await securityEffects(page);
  expect(actual).not.toEqual([]);
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  current.expectedSecurityEffects = actual;
}

async function acknowledgeWebSocket(page: Page, url: string): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  await expect.poll(() => current.webSockets).toContain(url);
  current.expectedWebSockets = [...current.webSockets];
}

async function acknowledgeConsoleError(page: Page, fragment: string): Promise<void> {
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  await expect.poll(() => current.consoleErrors.some(message => message.includes(fragment)))
    .toBe(true);
  current.expectedConsoleErrors = [...current.consoleErrors];
}

async function acknowledgeUnexpectedProtocol(page: Page, method: string): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).unexpectedProtocol).toContain(method);
  const current = observations.get(page);
  if (!current) throw new Error('Missing browser observations.');
  current.expectedUnexpectedProtocol = (await snapshot(page)).unexpectedProtocol;
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => {
    const effects: string[] = [];
    Object.defineProperty(window, '__metroSecurityEffects', { value: effects });
    const effectMessageType = 'metro-mcp-apps-security-effect';
    if (window === window.top) {
      window.addEventListener('message', event => {
        const data = event.data as { type?: unknown; effect?: unknown } | null;
        if (data?.type !== effectMessageType || typeof data.effect !== 'string') return;
        event.stopImmediatePropagation();
        effects.push(data.effect);
      }, { capture: true });
    }
    const record = (name: string): void => {
      effects.push(name);
      if (window !== window.top) {
        window.parent.postMessage({ type: effectMessageType, effect: name }, '*');
      }
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

  const current: Observations = {
    consoleErrors: [],
    pageErrors: [],
    externalRequests: [],
    webSockets: [],
    expectedConsoleErrors: [],
    expectedSecurityEffects: [],
    expectedExternalRequests: [],
    expectedWebSockets: [],
    expectedUnexpectedProtocol: [],
  };
  observations.set(page, current);
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
  expect((await snapshot(page)).unexpectedProtocol).toEqual(
    current?.expectedUnexpectedProtocol ?? [],
  );
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
  const inbound = protocol.filter(entry => entry.direction === 'app-to-host');
  const outbound = protocol.filter(entry => entry.direction === 'host-to-app');
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
});

test('records and rejects an unexpected official sandbox-ready notification', async ({ page }) => {
  const frame = await selectScenario(page, 'get_station_predictions');
  await frame.evaluate(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-proxy-ready',
    }, '*');
  });

  await acknowledgeUnexpectedProtocol(page, 'ui/notifications/sandbox-proxy-ready');
  expect((await snapshot(page)).protocol ?? []).toContainEqual(expect.objectContaining({
    direction: 'app-to-host',
    method: 'ui/notifications/sandbox-proxy-ready',
  }));
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
  await acknowledgeWebSocket(page, url);
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
      await acknowledgeConsoleError(page, 'Geolocation access has been blocked');
    }
  });
}
