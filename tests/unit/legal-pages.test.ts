import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectFile = (path: string): string =>
  new URL(`../../${path}`, import.meta.url).pathname;

function readRequiredProjectFile(path: string): string {
  const file = projectFile(path);
  expect(existsSync(file), `${path} exists`).toBe(true);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function staticHeadersForPath(source: string, pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let pattern: string | undefined;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(rawLine)) {
      pattern = line;
      continue;
    }
    if (!pattern) continue;
    const matches = pattern.endsWith('*')
      ? pathname.startsWith(pattern.slice(0, -1))
      : pathname === pattern;
    if (!matches) continue;
    const content = line.trimStart();
    const separator = content.indexOf(':');
    if (separator <= 0) continue;
    headers[content.slice(0, separator)] = content.slice(separator + 1).trim();
  }
  return headers;
}

const legalPages = [
  {
    slug: 'privacy',
    title: /privacy/i,
    lastUpdated: { datetime: '2026-08-21', text: 'August 21, 2026' },
  },
  {
    slug: 'terms',
    title: /terms/i,
    lastUpdated: { datetime: '2026-08-21', text: 'August 21, 2026' },
  },
  {
    slug: 'support',
    title: /support/i,
    lastUpdated: { datetime: '2026-09-08', text: 'September 8, 2026' },
  },
] as const;

function cssHexVariable(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  expect(match, `--${name} is a six-digit hex color`).not.toBeNull();
  return match?.[1] ?? '#000000';
}

function relativeLuminance(hex: string): number {
  const linearChannel = (offset: number): number => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
    );
  };
  const [red, green, blue] = [linearChannel(1), linearChannel(3), linearChannel(5)];
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('public legal and support pages', () => {
  it.each(legalPages)('publishes /$slug/ as a complete static document', ({ slug, title, lastUpdated }) => {
    const html = readRequiredProjectFile(`public/${slug}/index.html`);

    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toMatch(/<html\s+lang="en">/i);
    expect(html).toMatch(new RegExp(`<title>[^<]*${title.source}[^<]*<\\/title>`, 'i'));
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]+">/i);
    expect(html).toContain(
      `<link rel="canonical" href="https://transitmcp.com/${slug}/">`,
    );
    expect(html).toContain('<link rel="stylesheet" href="/legal.css">');
    expect(html).toMatch(/<header\b/i);
    expect(html).toMatch(/<nav\b[^>]*aria-label="Primary"/i);
    expect(html).toMatch(/<main\b[^>]*id="main-content"/i);
    expect(html).toMatch(/<footer\b/i);
    expect(html.match(/<h1\b/gi)).toHaveLength(1);
    expect(html).toContain(
      `<time datetime="${lastUpdated.datetime}">${lastUpdated.text}</time>`,
    );
    expect(html).toMatch(/class="skip-link"[^>]*href="#main-content"/i);
    expect(html).toMatch(/href="\/"[^>]*>\s*Transit MCP\s*</i);
  });

  it('publishes the complete anonymous privacy disclosure inventory', () => {
    const html = readRequiredProjectFile('public/privacy/index.html');

    expect(html).toMatch(/without (?:creating|requiring) an account/i);
    for (const disclosure of [
      /GitHub identity/i,
      /OAuth grants?/i,
      /access tokens?/i,
      /refresh tokens?/i,
      /client registrations?/i,
      /cookies?/i,
      /browser storage/i,
    ]) {
      expect(html).toMatch(disclosure);
    }
    expect(html).toMatch(/request bod(?:y|ies)[^.]*public transit (?:arguments|inputs)[^.]*only[^.]*answer/i);
    expect(html).toMatch(/Cloudflare[^.]*IP address/i);
    expect(html).toMatch(/sampled Worker (?:logs|traces)[^.]*allowlisted/i);
    expect(html).toMatch(/transit inputs[^.]*WMATA[^.]*MTA/i);
    expect(html).toMatch(/server-to-server/i);
    expect(html).toMatch(/does not forward[^.]*IP address[^.]*conversation/i);
    expect(html).toMatch(/client-held[^.]*signed[^.]*state[^.]*five minutes/i);
    expect(html).toMatch(/public station-selection fields/i);
    expect(html).toMatch(/Transit MCP[^.]*allowlisted operational telemetry/i);
    expect(html).toMatch(/client software reports about itself/i);
    expect(html).toMatch(/usage-metrics store[^.]*client software name/i);
    expect(html).toMatch(/keeps these records for about three months/i);
    expect(html).toMatch(/Cloudflare[^.]*logs?[^.]*may/i);
    expect(html).toMatch(/WMATA[^.]*MTA[^.]*may[^.]*logs?/i);
    expect(html).toMatch(/outside Transit MCP(?:'s|&rsquo;s) direct control/i);
    expect(html).toMatch(/does not sell/i);
    expect(html).toMatch(/no advertising/i);
    expect(html).toMatch(/not used[^.]*model training/i);
    expect(html).toMatch(/does not track you across/i);
    expect(html).toMatch(/Cloudflare[^.]*GitHub[^.]*WMATA[^.]*MTA/i);
    expect(html).toMatch(/MCP client(?:'s|&rsquo;s)?[^.]*polic/i);
    expect(html).toMatch(/stop[^.]*disconnecting[^.]*ceasing requests/i);
    expect(html).toMatch(/Claude[^.]*OpenAI[^.]*Codex[^.]*independent/i);
    expect(html).toMatch(/href="\/support\/"/i);
    expect(html).toMatch(/security report/i);
  });

  it('sets practical terms for a public read-only informational service', () => {
    const html = readRequiredProjectFile('public/terms/index.html');

    expect(html).toMatch(/public, read-only informational service/i);
    expect(html).toMatch(/unofficial community project/i);
    expect(html).toMatch(/not affiliated with or endorsed by[^.]*WMATA[^.]*MTA[^.]*OpenAI[^.]*Anthropic[^.]*transit agenc/i);
    expect(html).toMatch(/WMATA and MTA[^.]*availability[^.]*accuracy/i);
    expect(html).toMatch(/fair use/i);
    expect(html).toMatch(/rate limit/i);
    expect(html).toMatch(/(?:abuse|abusive use)[^.]*disrupt(?:ion|ive)?[^.]*circumvent[^.]*unlawful/i);
    expect(html).toMatch(/not (?:use|rely on)[^.]*emergenc/i);
    expect(html).toMatch(/safety-critical/i);
    expect(html).toMatch(/guaranteed arrival/i);
    expect(html).toMatch(/delayed[^.]*incomplete[^.]*inaccurate[^.]*unavailable/i);
    expect(html).toMatch(/third-party[^.]*terms/i);
    expect(html).toMatch(/without warrant/i);
    expect(html).toMatch(/not liable/i);
    expect(html).toMatch(
      /href="https:\/\/github\.com\/Aarekaz\/metro-mcp"[^>]*>[^<]*(?:source|GitHub)/i,
    );
    expect(html).toMatch(/MIT License/i);
    expect(html).toMatch(/&copy; 2026 Anurag Dhungana/i);
    expect(html).toMatch(/change or discontinue/i);
  });

  it('routes support and security reports without inventing an SLA or private form', () => {
    const html = readRequiredProjectFile('public/support/index.html');

    expect(html).toMatch(/href="\/docs\/"/i);
    expect(html).toMatch(/href="\/info"/i);
    expect(html).toMatch(/href="https:\/\/github\.com\/Aarekaz\/metro-mcp\/issues"/i);
    expect(html).toMatch(/href="https:\/\/github\.com\/Aarekaz\/metro-mcp\/security"/i);
    expect(html).toMatch(/private vulnerability reporting is not currently enabled/i);
    expect(html).toMatch(/no guaranteed response time/i);
    for (const detail of [
      /version/i,
      /client/i,
      /request ID/i,
      /timestamp/i,
      /city/i,
      /tool/i,
      /minimal reproduction/i,
    ]) {
      expect(html).toMatch(detail);
    }
    expect(html).toMatch(/never post[^.]*API keys?[^.]*bearer tokens?[^.]*secrets/i);
    expect(html).toMatch(/private conversation/i);
    expect(html).toMatch(/href="https:\/\/anuragd\.me\/"[^>]*>Anurag Dhungana</i);
    expect(html).toMatch(/href="mailto:hey@anuragd\.me"[^>]*>hey@anuragd\.me</i);
    expect(html).not.toMatch(/security\/advisories\/new/i);
    expect(html).not.toMatch(/respond within|response time of|SLA/i);
  });

  it.each(legalPages)('keeps /$slug/ inert and first-party', ({ slug }) => {
    const html = readRequiredProjectFile(`public/${slug}/index.html`);

    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/i);
    expect(html).not.toMatch(/\b(?:analytics|tracking pixel|web beacon|Google Tag|gtag|segment)\b/i);
    expect(html).not.toMatch(/<(?:a|form)\b[^>]*(?:href|action)="[^"]*(?:authorize|callback|token|register)[^"]*"/i);
    expect(html).not.toMatch(/<input\b[^>]*(?:name|autocomplete)="[^"]*(?:password|secret|token|api[-_ ]?key)[^"]*"/i);
    expect(html).not.toMatch(/Sign in with GitHub/i);
    expect(html).not.toMatch(/<(?:img|script|iframe|source)\b[^>]+(?:src|srcset)="https?:/i);
    expect(html).not.toMatch(/<link\b(?=[^>]*href="https?:)(?![^>]*rel="canonical")[^>]*>/i);
  });

  it('provides shared responsive styling without active behavior or outside resources', () => {
    const css = readRequiredProjectFile('public/legal.css');

    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/outline:/);
    expect(css).toMatch(/max-width:\s*6[0-9]ch/);
    expect(css).toMatch(/@media\s*\([^)]*min-width/i);
    expect(css).not.toMatch(/@import|https?:\/\/|url\s*\(/i);
    expect(css).not.toMatch(/@keyframes|animation\s*:/i);
  });

  it.each(legalPages)('publishes a scriptless static-header policy for /$slug/', ({ slug }) => {
    const source = readRequiredProjectFile('public/_headers');
    const headers = staticHeadersForPath(source, `/${slug}/index.html`);

    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBe(
      'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    );
    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; "
      + "connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('keeps the inline landing and docs experiences under a separate static CSP', () => {
    const source = readRequiredProjectFile('public/_headers');
    for (const pathname of ['/', '/docs/index.html']) {
      const csp = staticHeadersForPath(source, pathname)['Content-Security-Policy'];
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
      expect(csp).toContain('font-src https://fonts.gstatic.com');
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  it('uses an AA-safe text accent while reserving bright orange for non-text details', () => {
    const css = readRequiredProjectFile('public/legal.css');
    const paper = cssHexVariable(css, 'paper');
    const raisedPaper = cssHexVariable(css, 'paper-raised');
    const textAccent = cssHexVariable(css, 'accent-text');

    expect(contrastRatio(textAccent, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(textAccent, raisedPaper)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/a:hover\s*{[^}]*color:\s*var\(--accent-text\)/i);
    expect(css).toMatch(/\.eyebrow\s*{[^}]*color:\s*var\(--accent-text\)/i);
    expect(css).toMatch(/\.route-line\s*{[^}]*background:[^}]*var\(--accent\)/i);
  });

  it('makes anonymous access and legal navigation visible on the canonical public pages', () => {
    const landingPage = readRequiredProjectFile('public/index.html');
    const docsPage = readRequiredProjectFile('public/docs/index.html');

    expect(landingPage).toMatch(/Anonymous access/i);
    expect(docsPage).toMatch(/anonymous Streamable HTTP/i);
    for (const html of [landingPage, docsPage]) {
      expect(html).toMatch(/<footer[\s\S]*href="\/privacy\/"[^>]*>Privacy<\/a>/i);
      expect(html).toMatch(/<footer[\s\S]*href="\/terms\/"[^>]*>Terms<\/a>/i);
      expect(html).toMatch(/<footer[\s\S]*href="\/support\/"[^>]*>Support<\/a>/i);
    }
  });
});

const publicPages = [
  { file: 'public/index.html', url: 'https://transitmcp.com/' },
  { file: 'public/docs/index.html', url: 'https://transitmcp.com/docs/' },
  { file: 'public/privacy/index.html', url: 'https://transitmcp.com/privacy/' },
  { file: 'public/terms/index.html', url: 'https://transitmcp.com/terms/' },
  { file: 'public/support/index.html', url: 'https://transitmcp.com/support/' },
] as const;

function metaContent(html: string, attribute: 'name' | 'property', key: string): string | undefined {
  const pattern = new RegExp(`<meta\\s+${attribute}="${key.replace(/[.:]/g, '\\$&')}"\\s+content="([^"]+)">`, 'i');
  return html.match(pattern)?.[1];
}

describe('public page discoverability', () => {
  it.each(publicPages)('publishes a complete search and social head for $url', ({ file, url }) => {
    const html = readRequiredProjectFile(file);

    expect(html.match(/<title>[^<]{20,}<\/title>/gi)).toHaveLength(1);
    expect(metaContent(html, 'name', 'description')?.length).toBeGreaterThan(50);
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html.match(/<h1\b/gi)).toHaveLength(1);
    for (const key of ['og:type', 'og:title', 'og:description']) {
      expect(metaContent(html, 'property', key), key).toBeTruthy();
    }
    expect(metaContent(html, 'property', 'og:url')).toBe(url);
    expect(metaContent(html, 'property', 'og:image')).toBe('https://transitmcp.com/og-image.png');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'name', 'twitter:title')).toBeTruthy();
    expect(metaContent(html, 'name', 'twitter:description')).toBeTruthy();
    expect(metaContent(html, 'name', 'twitter:image')).toBe('https://transitmcp.com/og-image.png');
  });

  it('gives every public page a unique title and description', () => {
    const heads = publicPages.map(({ file }) => readRequiredProjectFile(file));
    const titles = heads.map(html => html.match(/<title>([^<]+)<\/title>/i)?.[1]);
    const descriptions = heads.map(html => metaContent(html, 'name', 'description'));

    expect(new Set(titles).size).toBe(publicPages.length);
    expect(new Set(descriptions).size).toBe(publicPages.length);
  });

  it('describes the landing and docs pages with parseable structured data', () => {
    const typesFor = (file: string): string[] =>
      [...readRequiredProjectFile(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
        .map(match => (JSON.parse(match[1] ?? '{}') as { '@type'?: string })['@type'] ?? '');

    expect(typesFor('public/index.html')).toEqual(['SoftwareApplication', 'WebSite']);
    expect(typesFor('public/docs/index.html')).toEqual(['TechArticle']);
  });

  it('publishes robots.txt, sitemap.xml, and llms.txt for crawlers and agents', () => {
    const robots = readRequiredProjectFile('public/robots.txt');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toContain('Sitemap: https://transitmcp.com/sitemap.xml');

    const sitemap = readRequiredProjectFile('public/sitemap.xml');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    expect(locations.sort()).toEqual(publicPages.map(({ url }) => url).sort());
    expect(sitemap).toMatch(/<loc>https:\/\/transitmcp\.com\/<\/loc>\s*<changefreq>[a-z]+<\/changefreq>\s*<priority>1\.0<\/priority>/);

    const llms = readRequiredProjectFile('public/llms.txt');
    expect(llms).toMatch(/^# Transit MCP$/m);
    expect(llms).toContain('https://transitmcp.com/mcp');
    expect(llms).toContain('https://metro-mcp.anuragd.me/mcp');
    expect(llms).toContain('https://chatgpt.com/plugins/plugin_asdk_app_6a9078f4d6dc8191be735cc1c2ff45b5');
    for (const path of ['docs', 'privacy', 'terms', 'support']) {
      expect(llms).toContain(`https://transitmcp.com/${path}/`);
    }
  });

  it('tells readers that Metro MCP was renamed and the legacy endpoint keeps working', () => {
    for (const file of ['public/docs/index.html', 'README.md']) {
      const source = readRequiredProjectFile(file);
      expect(source).toMatch(/Metro MCP is now Transit MCP/);
      expect(source).toContain('https://metro-mcp.anuragd.me/mcp');
      expect(source).toMatch(/continue to be supported/);
    }
    expect(readRequiredProjectFile('public/index.html')).toMatch(
      /<footer[\s\S]*Transit MCP was formerly Metro MCP\./,
    );
  });
});
