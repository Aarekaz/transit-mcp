import { mkdirSync } from 'node:fs';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';

type BrowserSecurityEffects = {
  storageWrites: string[];
  permissionAttempts: string[];
};

const pages = [
  {
    slug: 'privacy',
    heading: 'Privacy',
    content: [/without creating an account/i, /WMATA/i, /MTA/i, /does not sell/i],
  },
  {
    slug: 'terms',
    heading: 'Terms of Use',
    content: [/public, read-only informational service/i, /fair use/i, /emergency/i],
  },
  {
    slug: 'support',
    heading: 'Support',
    content: [/Documentation/i, /GitHub issues/i, /no guaranteed response time/i],
  },
] as const;

const viewports = [
  { name: 'desktop', width: 1_280, height: 960 },
  { name: 'mobile', width: 320, height: 800 },
] as const;

const screenshotDir = 'output/playwright/screenshots';
const workerOrigin = 'http://127.0.0.1:4179';
mkdirSync(screenshotDir, { recursive: true });

const internalRouteExpectations = {
  '/': { contentType: 'text/html', body: /Plug your LLM into the/i },
  '/docs/': { contentType: 'text/html', body: /Connect anonymously/i },
  '/privacy/': { contentType: 'text/html', body: /Privacy, in plain language/i },
  '/terms/': { contentType: 'text/html', body: /Terms of Use/i },
  '/support/': { contentType: 'text/html', body: /<h1>Support<\/h1>/i },
  '/info': { contentType: 'application/json', body: /"name":\s*"Metro MCP"/i },
} as const;

const expectedObserverLabels = [
  'Storage.setItem',
  'Storage.removeItem',
  'Storage.clear',
  'indexedDB.open',
  'indexedDB.deleteDatabase',
  'caches.open',
  'caches.delete',
  'permissions.query',
  'geolocation.get',
  'geolocation.watch',
  'mediaDevices.getUserMedia',
  'Notification.requestPermission',
] as const;

function isExternalRequest(request: Request): boolean {
  const url = new URL(request.url());
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  return url.origin !== workerOrigin;
}

function parseRgb(value: string): [number, number, number] {
  const match = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  expect(match, `${value} is an RGB color`).not.toBeNull();
  return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linearize = (value: number): number => {
    const channel = value / 255;
    return (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );
  };
  const linearRed = linearize(red);
  const linearGreen = linearize(green);
  const linearBlue = linearize(blue);
  return (0.2126 * linearRed) + (0.7152 * linearGreen) + (0.0722 * linearBlue);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(parseRgb(first));
  const secondLuminance = relativeLuminance(parseRgb(second));
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function validateInternalAnchors(page: Page, request: APIRequestContext): Promise<void> {
  const hrefs = await page.locator('a[href]').evaluateAll(anchors => (
    [...new Set(anchors.map(anchor => anchor.getAttribute('href')).filter(Boolean))]
  ));

  for (const href of hrefs) {
    if (!href) continue;
    if (href.startsWith('#')) {
      await expect(page.locator(href), `${href} fragment exists`).toHaveCount(1);
      continue;
    }
    if (!href.startsWith('/')) continue;

    const expectation = internalRouteExpectations[href as keyof typeof internalRouteExpectations];
    expect(expectation, `${href} has an explicit route contract`).toBeDefined();
    if (!expectation) continue;

    const response = await request.get(`${workerOrigin}${href}`);
    expect(response.status(), `${href} status`).toBe(200);
    expect(response.url(), `${href} remains canonical`).toBe(`${workerOrigin}${href}`);
    expect(response.headers()['content-type'], `${href} content type`).toContain(expectation.contentType);
    expect(await response.text(), `${href} content`).toMatch(expectation.body);
  }
}

async function installSecurityObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const effects: BrowserSecurityEffects = {
      storageWrites: [],
      permissionAttempts: [],
    };
    const scope = globalThis as typeof globalThis & {
      __metroLegalSecurityEffects?: BrowserSecurityEffects;
    };
    scope.__metroLegalSecurityEffects = effects;

    const propertyOwner = (target: object, key: PropertyKey): object | undefined => {
      let owner: object | null = target;
      while (owner) {
        if (Object.prototype.hasOwnProperty.call(owner, key)) return owner;
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      return undefined;
    };

    const wrapMethod = (
      target: object | undefined,
      key: string,
      bucket: keyof BrowserSecurityEffects,
      label: string,
    ): void => {
      if (!target) return;
      const owner = propertyOwner(target, key);
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      const original = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(owner, key, {
        ...descriptor,
        value: function wrapped(this: unknown, ...args: unknown[]): unknown {
          effects[bucket].push(label);
          return Reflect.apply(original, this, args);
        },
      });
    };

    wrapMethod(Storage.prototype, 'setItem', 'storageWrites', 'Storage.setItem');
    wrapMethod(Storage.prototype, 'removeItem', 'storageWrites', 'Storage.removeItem');
    wrapMethod(Storage.prototype, 'clear', 'storageWrites', 'Storage.clear');
    wrapMethod(globalThis.indexedDB, 'open', 'storageWrites', 'indexedDB.open');
    wrapMethod(globalThis.indexedDB, 'deleteDatabase', 'storageWrites', 'indexedDB.deleteDatabase');
    wrapMethod(globalThis.caches, 'open', 'storageWrites', 'caches.open');
    wrapMethod(globalThis.caches, 'delete', 'storageWrites', 'caches.delete');
    wrapMethod(navigator.permissions, 'query', 'permissionAttempts', 'permissions.query');
    wrapMethod(navigator.geolocation, 'getCurrentPosition', 'permissionAttempts', 'geolocation.get');
    wrapMethod(navigator.geolocation, 'watchPosition', 'permissionAttempts', 'geolocation.watch');
    wrapMethod(
      navigator.mediaDevices,
      'getUserMedia',
      'permissionAttempts',
      'mediaDevices.getUserMedia',
    );
    wrapMethod(
      typeof Notification === 'undefined' ? undefined : Notification,
      'requestPermission',
      'permissionAttempts',
      'Notification.requestPermission',
    );
  });
}

test('security observers record every monitored API without leaving test artifacts', async ({
  context,
  page,
}) => {
  await installSecurityObservers(page);
  const response = await page.goto(`${workerOrigin}/privacy/`, { waitUntil: 'load' });
  expect(response?.ok()).toBe(true);

  const result = await page.evaluate(async () => {
    const effects = (globalThis as typeof globalThis & {
      __metroLegalSecurityEffects?: BrowserSecurityEffects;
    }).__metroLegalSecurityEffects;
    if (!effects) throw new Error('Security observers were not installed.');

    const databaseName = '__metro-legal-observer-self-check__';
    const cacheName = '__metro-legal-observer-self-check__';
    const requestResult = <T>(current: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      current.addEventListener('success', () => resolve(current.result), { once: true });
      current.addEventListener('error', () => reject(current.error), { once: true });
    });

    localStorage.setItem('observer-self-check', '1');
    localStorage.removeItem('observer-self-check');
    localStorage.clear();

    const database = await requestResult(indexedDB.open(databaseName));
    database.close();
    await requestResult(indexedDB.deleteDatabase(databaseName));

    await caches.open(cacheName);
    await caches.delete(cacheName);

    await navigator.permissions.query({ name: 'geolocation' });
    const ignorePosition = (): void => undefined;
    navigator.geolocation.getCurrentPosition(ignorePosition, ignorePosition, { timeout: 0 });
    const watchId = navigator.geolocation.watchPosition(
      ignorePosition,
      ignorePosition,
      { timeout: 0 },
    );
    navigator.geolocation.clearWatch(watchId);
    await navigator.mediaDevices.getUserMedia({ audio: false, video: false }).catch(() => undefined);
    void Notification.requestPermission().catch(() => undefined);

    const observed = [...effects.storageWrites, ...effects.permissionAttempts];
    effects.storageWrites.length = 0;
    effects.permissionAttempts.length = 0;

    return {
      observed,
      effectsAfterReset: effects,
      localStorageLength: localStorage.length,
      sessionStorageLength: sessionStorage.length,
      cacheNames: await caches.keys(),
      databaseNames: (await indexedDB.databases()).map(databaseInfo => databaseInfo.name),
    };
  });

  await context.clearPermissions();
  expect(result.observed).toEqual(expectedObserverLabels);
  expect(result.effectsAfterReset).toEqual({ storageWrites: [], permissionAttempts: [] });
  expect(result.localStorageLength).toBe(0);
  expect(result.sessionStorageLength).toBe(0);
  expect(result.cacheNames).not.toContain('__metro-legal-observer-self-check__');
  expect(result.databaseNames).not.toContain('__metro-legal-observer-self-check__');
  expect((await context.storageState()).origins).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

for (const viewport of viewports) {
  for (const legalPage of pages) {
    test(`${legalPage.slug} legal page is inert and readable at ${viewport.name}`, async ({
      context,
      page,
      request,
    }) => {
      await page.setViewportSize(viewport);
      await installSecurityObservers(page);
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const externalRequests: string[] = [];
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', current => {
        if (isExternalRequest(current)) externalRequests.push(current.url());
      });

      const pageUrl = `${workerOrigin}/${legalPage.slug}/`;
      const response = await page.goto(pageUrl, { waitUntil: 'load' });
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toBe(pageUrl);
      expect(response?.headers()['x-frame-options']).toBe('DENY');
      expect(response?.headers()['x-content-type-options']).toBe('nosniff');
      expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(response?.headers()['permissions-policy']).toBe(
        'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
      );
      expect(response?.headers()['content-security-policy']).toContain("script-src 'none'");
      expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
      await expect(page).toHaveTitle(new RegExp(legalPage.heading, 'i'));
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `https://metro-mcp.anuragd.me/${legalPage.slug}/`,
      );
      await expect(page.getByRole('banner')).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('contentinfo')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: legalPage.heading })).toHaveCount(1);
      await expect(page.locator('time[datetime="2026-08-21"]')).toHaveText('August 21, 2026');
      for (const pattern of legalPage.content) {
        await expect(page.locator('main')).toContainText(pattern);
      }

      const backgroundColor = await page.locator('html').evaluate(element => (
        getComputedStyle(element).backgroundColor
      ));
      const eyebrowColor = await page.locator('.eyebrow').evaluate(element => (
        getComputedStyle(element).color
      ));
      const hoverLink = page.locator('.legal-copy a').first();
      await hoverLink.hover();
      const hoverColor = await hoverLink.evaluate(element => getComputedStyle(element).color);
      expect(contrastRatio(eyebrowColor, backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hoverColor, backgroundColor)).toBeGreaterThanOrEqual(4.5);

      await page.keyboard.press('Tab');
      const skipLink = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();
      expect(await skipLink.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${pageUrl}#main-content`);
      await expect(page.locator('#main-content')).toHaveCount(1);

      expect(await page.locator('script').count()).toBe(0);
      expect(await page.locator('form').count()).toBe(0);
      const effects = await page.evaluate(() => (
        globalThis as typeof globalThis & {
          __metroLegalSecurityEffects?: BrowserSecurityEffects;
        }
      ).__metroLegalSecurityEffects);
      expect(effects).toEqual({ storageWrites: [], permissionAttempts: [] });
      expect((await context.storageState()).origins).toEqual([]);
      expect((await context.cookies())).toEqual([]);
      expect(externalRequests).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      await validateInternalAnchors(page, request);

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({
        path: `${screenshotDir}/${legalPage.slug}-${viewport.name}.png`,
        fullPage: true,
      });
    });
  }

  for (const publicPage of [
    { name: 'landing', path: '/' },
    { name: 'docs', path: '/docs/' },
  ]) {
    test(`${publicPage.name} footer exposes legal links at ${viewport.name}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      const pageUrl = `${workerOrigin}${publicPage.path}`;
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toBe(pageUrl);
      const footer = page.locator('footer');
      await footer.scrollIntoViewIfNeeded();
      for (const link of [
        { name: 'Privacy', href: '/privacy/' },
        { name: 'Terms', href: '/terms/' },
        { name: 'Support', href: '/support/' },
      ]) {
        const locator = footer.getByRole('link', { name: link.name, exact: true });
        await expect(locator).toBeVisible();
        await expect(locator).toHaveAttribute('href', link.href);
      }
      expect(await footer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await validateInternalAnchors(page, request);
      await footer.screenshot({ path: `${screenshotDir}/${publicPage.name}-footer-${viewport.name}.png` });
    });
  }
}
