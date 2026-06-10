# Landing Page Redesign — Design Spec

**Date:** 2026-06-03
**Status:** Approved for implementation planning
**Branch:** to be created (`feat/landing-redesign`)

## Motivation

The current `public/index.html` is a 68 KB single file with ~1,900 lines of dark-themed cyberpunk styling (JetBrains Mono, neon-green accents, scanlines, light/dark toggle, ~9 content sections including features grid, stats bar, coverage table, examples, tech stack). It's distinctive but feels dated and tries to do too many jobs at once.

The new page is a business card for one job: **get a developer who already knows MCP to connect their client to `metro-mcp.anuragd.me/mcp`**. Everything not directly serving that job is removed.

## Reference

The design language is inspired by [Sell Traces](https://selltraces.com)'s landing page — centered hero, halftone gradient decoration, minimal navigation, a single CTA pair, no scroll. We adapt the aesthetic with a transit-coded color palette (navy + transit-orange) and a route-line halftone, both restrained enough to read as tech-first.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Primary job | Get MCP clients to connect |
| Audience | Developers who already know MCP |
| Content depth | A — one screen, no scroll (business card) |
| Brand identity | Subtle transit hint, pure-tech base |
| Visual direction | Subway-soul — navy + transit-orange, halftone "route-line" sweep |
| Headline | "Plug your LLM into the **subway**." (accent on `subway`) |
| Primary CTA copy | (URL pill — click to copy) |
| Secondary CTA copy | "Add to LLM" (client-agnostic, not Claude-specific) |
| "Add to LLM" behavior | Open a modal with per-client copy-paste snippets |
| Theme | Light only — no dark/light toggle |
| Implementation | Vanilla HTML + inline CSS + minimal JS, single file |

## 1. Page architecture

One viewport-height layout. Nav top (64 px), centered hero in the middle, thin footer at bottom (40 px). No second screen, no scroll on standard desktop and tablet sizes. Mobile gets the same content stacked with proportional spacing — content remains within ~95 vh on iPhone-class viewports.

```
┌──────────────────────────────────────────────────┐
│  [M] metro-mcp     Docs   GitHub   [Add to LLM]  │  Nav (64px)
├──────────────────────────────────────────────────┤
│                                                  │
│             · · · · ·     · · · · ·              │  Halftone
│           · · · · · · · · · · · · · ·            │  route sweep
│                                                  │
│        Plug your LLM into the subway.            │  Headline
│                                                  │
│        DC Metro and NYC Subway via the           │  Subtitle
│        Model Context Protocol. Connect any       │
│        MCP client to live arrivals, incidents,   │
│        and 594 stations.                         │
│                                                  │
│      ╭─────────────────────╮  ╭─────────────╮    │  CTA row
│      │ metro-mcp.anuragd.. │  │ Add to LLM  │    │
│      ╰─────────────────────╯  ╰─────────────╯    │
│                                                  │
│      Works with Claude · Cursor · Codex · Gemini │  Footnote
│                                                  │
├──────────────────────────────────────────────────┤
│  © 2026 Anurag Dhungana · MIT · v4.0.0 · status  │  Footer (40px)
└──────────────────────────────────────────────────┘
```

## 2. Visual system

### Color tokens

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#fafbfc` | Page background (off-white, not pure) |
| `--ink` | `#0a2540` | Headings, mark, primary button |
| `--ink-2` | `#5b6470` | Subtitle, body secondary |
| `--ink-3` | `#8a93a0` | Footnotes, mono prefix glyph |
| `--border` | `#e6e8eb` | Hairlines, URL pill border |
| `--accent` | `#FF6B1A` | The single accent word in the headline; focus rings; (no other use) |
| `--surface` | `#ffffff` | URL pill background, modal surface |

No dark mode in v1. Browser `prefers-color-scheme: dark` is ignored.

### Typography

- **Inter** (variable, 100-900) for everything UI: `nav`, `h1`, `p`, buttons, footnote.
- **JetBrains Mono** for monospaced content: the URL pill and any code in the modal.
- Both loaded from Google Fonts with `font-display: swap`.
- Headline: 56 px desktop / 36 px mobile, `font-weight: 600`, `letter-spacing: -0.02em`, `line-height: 1.05`.
- Subtitle: 17 px desktop / 15 px mobile, `font-weight: 400`, `line-height: 1.55`. Max line length ~ 74 ch (`max-width: 640px`).
- Nav / footer / footnote: 13 px, `font-weight: 500`.
- URL pill: 14 px mono.
- Accent word `<span class="accent">subway</span>` inherits font-size, only color changes.

### Decoration — route halftone

A dot pattern (1.5 px navy dots on a 12 px grid) masked into an asymmetric ellipse that sweeps horizontally across the hero region. Two overlapping radial masks give a curved "route-line" feel rather than a single oval. Opacity 0.4, behind all hero content, no interaction, no link.

CSS sketch:

```css
.hero::before {
  content: "";
  position: absolute;
  inset: 18% -120px auto -120px;
  height: 220px;
  background: radial-gradient(var(--ink) 1.5px, transparent 1.5px) 0 0 / 12px 12px;
  -webkit-mask:
    radial-gradient(ellipse 70% 32% at 22% 50%, black, transparent 70%),
    radial-gradient(ellipse 65% 28% at 78% 50%, black, transparent 70%);
  -webkit-mask-composite: source-over;
  opacity: 0.4;
  pointer-events: none;
}
```

Optional very slow drift (~30 s `translateX` loop, ±10 px) on `(prefers-reduced-motion: no-preference)`. Acceptable to ship without motion in v1 — keep the pattern static if it complicates anything.

### Spacing scale

`4, 8, 12, 16, 20, 24, 32, 48, 64` (px). Page padding: 24 px mobile / 48 px desktop. Hero gap between elements: 20 px.

## 3. Component spec

### Nav

```
[M] metro-mcp                Docs   GitHub   [Add to LLM]
```

- Left: a 20 × 20 px navy rounded-square `[M]` mark + the wordmark `metro-mcp` (Inter, 14 px, 600, slight letter-spacing).
- Right: `Docs` (anchor) · `GitHub` (anchor) · `[Add to LLM]` pill (navy bg `var(--ink)`, white text, 8 px × 14 px padding, 999px border-radius).
- `Docs` links to the GitHub README anchor that documents client setup (`#mcp-client-integration`).
- `GitHub` links to the repo.
- The `[M]` mark stays consistent with the favicon visual language — square, rounded, navy.

### Hero

- `<h1>` containing the headline with `<span class="accent">subway</span>` for the orange word.
- `<p class="subtitle">` block, centered, max-width 640 px.
- CTA row (horizontally flex-gapped 8 px on desktop; stacks vertically on widths ≤ 480 px):
  - **URL pill** — white surface, 1 px `var(--border)`, 999 px radius, mono text content `metro-mcp.anuragd.me/mcp`. Cursor pointer. Click anywhere on it copies the full URL `https://metro-mcp.anuragd.me/mcp` to clipboard.
  - **`Add to LLM` button** — navy capsule, white text, hover lifts brightness ~5 %. Opens the modal.
- Footnote (`<p class="footnote">`): muted gray (`var(--ink-3)`), 13 px, `Works with Claude · Cursor · Codex · Gemini`.

### Modal — "Add metro-mcp to your MCP client"

- Centered, max-width 560 px, white surface, 12 px border-radius, soft shadow (`0 24px 60px rgba(10,37,64,0.18)`).
- Title: 18 px Inter 600 navy ink.
- Subtitle (one line): 13 px muted gray — `Paste the snippet for your client.`
- Segmented control (radio-like tabs) with four options:
  1. **Claude Desktop**
  2. **Cursor**
  3. **Codex CLI**
  4. **Generic JSON**
- Selected tab reveals a single `<pre><code>` block (JetBrains Mono, 13 px, 16 px padding, `#0c1320` background, `#e8eef5` text, 8 px radius), with a `Copy` button at top-right of the block.
- Each snippet is the exact text a user would paste into their client's configuration. (Specific copy in §6.)
- Backdrop: `rgba(10,37,64,0.45)` with 4 px backdrop-blur. Click backdrop or press `Esc` to close.
- Close affordance: `×` at top-right of the modal panel (24 × 24 px hit area).
- Focus is moved into the modal on open; first interactive element is the first tab.

### Footer

```
© 2026 Anurag Dhungana · MIT · v4.0.0 · status: ok
```

- Single line, 13 px, `var(--ink-3)`, centered. 40 px tall.
- `v4.0.0` and the `status` chip are pulled at page-load time from `GET /` (the server-info endpoint already returns version + `status: "operational"`). The fetch is best-effort — on failure, the elements just render with their cached/initial text.

## 4. Interaction spec

| Action | Behavior |
|---|---|
| Click URL pill | Copy `https://metro-mcp.anuragd.me/mcp`. Tick icon swaps in for 1.2 s. Optional toast: "Copied" bottom-center, 1.5 s. |
| Click nav "Add to LLM" pill | Open modal. |
| Click hero "Add to LLM" button | Open modal. |
| Modal: tab change | Instant. No animation between code blocks. |
| Modal: Copy button | Copy snippet. Button label flips to `Copied`, reverts after 1.2 s. |
| Modal: click backdrop / press `Esc` | Close modal, return focus to the trigger. |
| Page load | Fetch `/` to refresh the footer's `v4.0.0` and status indicator. Failure → silent. |
| `prefers-reduced-motion: reduce` | Disable any halftone drift; modal opens with a 100 ms fade only (no scale). |

All interactive elements get a 2 px `var(--accent)` focus ring with 2 px offset. No `outline: none` without replacement.

## 5. Implementation approach

- Single file: `public/index.html`.
- Vanilla HTML + inline `<style>` + small inline `<script>` (≤ 100 lines of JS for clipboard, modal, version fetch).
- No build step. Cloudflare Workers' `[assets]` directive in `wrangler.jsonc` already serves `/public/` directly.
- Font loading: Google Fonts CDN (Inter + JetBrains Mono), `preconnect` hints in `<head>`, `font-display: swap`.
- Inline SVG for the `[M]` mark — no extra HTTP request.
- Target file size: ≤ 12 KB raw HTML (down from 68 KB).
- Lighthouse target: Performance ≥ 95, Accessibility ≥ 95, Best Practices = 100, SEO ≥ 95 — feasible given there are essentially no assets beyond two fonts.
- No analytics, no tracking, no third-party scripts.

### Assets to keep

- `public/favicon.ico` — keep
- `public/metro-mcp-slick.svg` — repurpose or replace (TBD during implementation; the SVG could become the `[M]` mark if it's small/clean enough)
- `public/og-image.png` — keep for now; **regeneration to match the new design is a separate task**, not blocking this PR
- `public/metro-mcp.png` — keep if used by any social card; otherwise drop in implementation

### Assets to discard

- Everything inside the current `<style>` block (~1,200 lines) — full replacement, not an edit.

## 6. Copy

### Hero

- **Headline:** `Plug your LLM into the subway.` (`subway` is the only `<span class="accent">` element on the page)
- **Subtitle:** `DC Metro and NYC Subway via the Model Context Protocol. Connect any MCP client to live arrivals, incidents, and 594 stations.`
- **Footnote:** `Works with Claude · Cursor · Codex · Gemini`

### Modal title and subtitle

- **Title:** `Add metro-mcp to your MCP client`
- **Subtitle:** `Paste the snippet for your client.`

### Modal snippets

**Claude Desktop** (in `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "metro-mcp": {
      "url": "https://metro-mcp.anuragd.me/mcp"
    }
  }
}
```

**Cursor** (in `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "metro-mcp": {
      "url": "https://metro-mcp.anuragd.me/mcp"
    }
  }
}
```

**Codex CLI** (run in the terminal):

```bash
codex mcp add metro-mcp https://metro-mcp.anuragd.me/mcp
```

**Generic JSON** (for any MCP client that follows the standard):

```json
{
  "name": "metro-mcp",
  "url": "https://metro-mcp.anuragd.me/mcp",
  "transport": "streamable-http"
}
```

Each snippet should be verified during implementation against each client's current docs. The exact path / file name details above are best-effort and may need correction.

### Page metadata

- `<title>` — `metro-mcp · Plug your LLM into the subway`
- `<meta name="description">` — `Connect any MCP client to live DC Metro and NYC Subway data. Real-time arrivals, incidents, and 594 stations via the Model Context Protocol.`
- Open Graph and Twitter cards updated to match. Image stays as today's `og-image.png` until that's regenerated.

## 7. Accessibility

- Single `<h1>` on the page (the headline).
- All buttons are real `<button>` elements with visible focus.
- Modal traps focus while open; `Esc` closes; `aria-modal="true"`; labeled by `aria-labelledby` referencing the title.
- Tabs in the modal use the `role="tablist"` / `role="tab"` / `role="tabpanel"` pattern with arrow-key navigation.
- The halftone decoration has no semantic meaning — `aria-hidden="true"` (or set via the `::before` pseudo-element which is invisible to assistive tech by default).
- Color contrast: navy `#0a2540` on `#fafbfc` is 13.1:1 (AAA). Subtitle `#5b6470` on `#fafbfc` is 5.3:1 (AA). Accent `#FF6B1A` on `#fafbfc` is 3.1:1 — fails AA for body text, which is why it's used **only** on the single headline word (large text, where 3:1 is sufficient under WCAG 2.1).

## 8. Out of scope (explicit non-goals for this PR)

- **OG image regeneration** — defer to a follow-up. Current image works.
- **Dark mode** — single light theme by design.
- **Per-client install deep links** (e.g., `claude://...`) — modal copy/paste is sufficient.
- **Animation polish beyond what's listed** — slow halftone drift is optional.
- **Localization** — English only, no i18n infrastructure.
- **Analytics / tracking** — none.
- **`/install` or `/docs` standalone pages** — not built. `Docs` nav link points at the existing GitHub README.
- **Replacing the existing favicon or `metro-mcp-slick.svg` art** — optional during implementation; not required by this spec.

## 9. Migration plan

1. Branch `feat/landing-redesign` off `main`.
2. Replace `public/index.html` wholesale with the new ~250-line file.
3. Update `<title>`, `<meta>` tags, OG/Twitter cards.
4. Keep `favicon.ico`, `og-image.png`. Re-evaluate `metro-mcp.png` and `metro-mcp-slick.svg` usage.
5. Verify locally: `wrangler dev` and confirm the page renders, the URL pill copies, the modal opens, tabs switch.
6. Open PR.
7. Manual smoke after merge: visit `metro-mcp.anuragd.me`, copy the URL, paste into a real MCP client (Claude Desktop), confirm the connection.

The redesign is independent of Phase 1 (PR #9) and Phase 2 (PR #10). It does not depend on either landing.

## 10. Open implementation questions (resolve while building, not now)

- Exact `metro-mcp-slick.svg` reuse vs. inline SVG — decide once we see both side by side in the implementation.
- Whether to ship the halftone drift animation in v1 — default is "no" if anything else slips.
- Modal snippet path details — verify each client's current documentation links during implementation.

---

**Approval status:** Approved by user 2026-06-03.
**Next step:** invoke `superpowers:writing-plans` to turn this spec into an implementation plan.
