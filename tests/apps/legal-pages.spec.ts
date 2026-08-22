import { mkdirSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
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
mkdirSync(screenshotDir, { recursive: true });

function isExternalRequest(request: Request): boolean {
  const url = new URL(request.url());
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  return url.hostname !== '127.0.0.1' || url.port !== '4178';
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

    const wrapMethod = (
      target: object | undefined,
      key: string,
      bucket: keyof BrowserSecurityEffects,
      label: string,
    ): void => {
      if (!target) return;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      const original = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(target, key, {
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
      typeof Notification === 'undefined' ? undefined : Notification,
      'requestPermission',
      'permissionAttempts',
      'Notification.requestPermission',
    );
  });
}

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

      const response = await page.goto(`/${legalPage.slug}/index.html`, { waitUntil: 'networkidle' });
      expect(response?.ok()).toBe(true);
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

      await page.keyboard.press('Tab');
      const skipLink = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();
      expect(await skipLink.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');

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

      for (const path of [
        '/index.html',
        '/docs/index.html',
        '/privacy/index.html',
        '/terms/index.html',
        '/support/index.html',
      ]) {
        const target = await request.get(path);
        expect(target.ok(), `${path} resolves`).toBe(true);
      }

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({
        path: `${screenshotDir}/${legalPage.slug}-${viewport.name}.png`,
        fullPage: true,
      });
    });
  }

  for (const publicPage of [
    { name: 'landing', path: '/index.html' },
    { name: 'docs', path: '/docs/index.html' },
  ]) {
    test(`${publicPage.name} footer exposes legal links at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const response = await page.goto(publicPage.path, { waitUntil: 'domcontentloaded' });
      expect(response?.ok()).toBe(true);
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
      await footer.screenshot({ path: `${screenshotDir}/${publicPage.name}-footer-${viewport.name}.png` });
    });
  }
}
