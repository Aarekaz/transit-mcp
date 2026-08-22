import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectFile = (path: string): string =>
  new URL(`../../${path}`, import.meta.url).pathname;

function readRequiredProjectFile(path: string): string {
  const file = projectFile(path);
  expect(existsSync(file), `${path} exists`).toBe(true);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const legalPages = [
  { slug: 'privacy', title: /privacy/i },
  { slug: 'terms', title: /terms/i },
  { slug: 'support', title: /support/i },
] as const;

describe('public legal and support pages', () => {
  it.each(legalPages)('publishes /$slug/ as a complete static document', ({ slug, title }) => {
    const html = readRequiredProjectFile(`public/${slug}/index.html`);

    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toMatch(/<html\s+lang="en">/i);
    expect(html).toMatch(new RegExp(`<title>[^<]*${title.source}[^<]*<\\/title>`, 'i'));
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]+">/i);
    expect(html).toContain(
      `<link rel="canonical" href="https://metro-mcp.anuragd.me/${slug}/">`,
    );
    expect(html).toContain('<link rel="stylesheet" href="/legal.css">');
    expect(html).toMatch(/<header\b/i);
    expect(html).toMatch(/<nav\b[^>]*aria-label="Primary"/i);
    expect(html).toMatch(/<main\b[^>]*id="main-content"/i);
    expect(html).toMatch(/<footer\b/i);
    expect(html.match(/<h1\b/gi)).toHaveLength(1);
    expect(html).toMatch(
      /<time\s+datetime="2026-08-21">August 21, 2026<\/time>/i,
    );
    expect(html).toMatch(/class="skip-link"[^>]*href="#main-content"/i);
    expect(html).toMatch(/href="\/"[^>]*>\s*Metro MCP\s*</i);
  });

  it('explains anonymous transit data handling without overstating provider control', () => {
    const html = readRequiredProjectFile('public/privacy/index.html');

    expect(html).toMatch(/without (?:creating|requiring) an account/i);
    expect(html).toMatch(/transit inputs[^.]*WMATA[^.]*MTA/i);
    expect(html).toMatch(/Metro MCP[^.]*allowlisted operational telemetry/i);
    expect(html).toMatch(/Cloudflare[^.]*logs?[^.]*may/i);
    expect(html).toMatch(/WMATA[^.]*MTA[^.]*may[^.]*logs?/i);
    expect(html).toMatch(/outside Metro MCP(?:'s|&rsquo;s) direct control/i);
    expect(html).toMatch(/does not sell/i);
    expect(html).toMatch(/no advertising/i);
    expect(html).toMatch(/does not track you across/i);
    expect(html).toMatch(/href="\/support\/"/i);
  });

  it('sets practical terms for a public read-only informational service', () => {
    const html = readRequiredProjectFile('public/terms/index.html');

    expect(html).toMatch(/public, read-only informational service/i);
    expect(html).toMatch(/WMATA and MTA[^.]*availability[^.]*accuracy/i);
    expect(html).toMatch(/fair use/i);
    expect(html).toMatch(/rate limit/i);
    expect(html).toMatch(/not (?:use|rely on)[^.]*emergenc/i);
    expect(html).toMatch(/without warrant/i);
    expect(html).toMatch(
      /href="https:\/\/github\.com\/Aarekaz\/metro-mcp"[^>]*>[^<]*(?:source|GitHub)/i,
    );
    expect(html).toMatch(/MIT License/i);
  });

  it('routes support and security reports without inventing an SLA or private form', () => {
    const html = readRequiredProjectFile('public/support/index.html');

    expect(html).toMatch(/href="\/docs\/"/i);
    expect(html).toMatch(/href="\/info"/i);
    expect(html).toMatch(/href="https:\/\/github\.com\/Aarekaz\/metro-mcp\/issues"/i);
    expect(html).toMatch(/href="https:\/\/github\.com\/Aarekaz\/metro-mcp\/security"/i);
    expect(html).toMatch(/private vulnerability reporting is not currently enabled/i);
    expect(html).toMatch(/no guaranteed response time/i);
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
    expect(html).not.toMatch(/\b(?:OAuth|client token|Bearer token|Sign in with GitHub)\b/i);
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
