# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `public/index.html` (currently a 1,900-line dark cyberpunk page) with a one-screen, no-scroll "business card" landing page in the visual style locked in by `docs/superpowers/specs/2026-06-03-landing-redesign-design.md`.

**Architecture:** Single static HTML file served by Cloudflare Workers' `[assets]` directive. Inline `<style>` and `<script>` blocks. No framework, no build step, no third-party JS. Two Google Fonts (Inter + JetBrains Mono). Target final size ≤ 12 KB raw HTML.

**Tech Stack:** Vanilla HTML5, CSS custom properties, ES2022 (Clipboard API, `<dialog>` element, `fetch`).

---

## File Structure

**Modified:**
- `public/index.html` — full wholesale replacement (the only file changed)

**Unchanged (kept):**
- `public/favicon.ico`
- `public/og-image.png`
- `public/metro-mcp.png`
- `public/metro-mcp-slick.svg` (not referenced from the new file but kept on disk for now)

**No new files:** The redesign is intentionally a single self-contained file.

**Verification approach:** Manual smoke checklist run against `bunx wrangler dev`. No automated tests added for the static landing page — the HTML has no business logic worth unit-testing, and the interactions (clipboard, modal) are best verified in a real browser. The existing 103-test suite (which lives on Phase 2's branch, not here) is unaffected.

---

## Task 1: Bootstrap new HTML structure

**Files:**
- Modify: `public/index.html` (full replacement)

- [ ] **Step 1: Replace `public/index.html` with the new structural scaffold**

Write the file with this exact content. This is the unstyled skeleton — all sections present, no CSS, no JS yet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>metro-mcp · Plug your LLM into the subway</title>
  <meta name="description" content="Connect any MCP client to live DC Metro and NYC Subway data. Real-time arrivals, incidents, and 594 stations via the Model Context Protocol.">
  <link rel="icon" href="/favicon.ico" type="image/x-icon">

  <!-- Open Graph / Twitter (updated for new headline; image stays as-is) -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://metro-mcp.anuragd.me/">
  <meta property="og:title" content="metro-mcp · Plug your LLM into the subway">
  <meta property="og:description" content="Connect any MCP client to live DC Metro and NYC Subway data via the Model Context Protocol.">
  <meta property="og:image" content="https://metro-mcp.anuragd.me/og-image.png">
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="https://metro-mcp.anuragd.me/">
  <meta property="twitter:title" content="metro-mcp · Plug your LLM into the subway">
  <meta property="twitter:description" content="Connect any MCP client to live DC Metro and NYC Subway data via the Model Context Protocol.">
  <meta property="twitter:image" content="https://metro-mcp.anuragd.me/og-image.png">
</head>
<body>
  <nav aria-label="Primary">
    <a class="brand" href="/">
      <svg class="mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect width="20" height="20" rx="5" fill="#0a2540"/>
        <path d="M4.5 14V6h1.8l2.7 5 2.7-5h1.8v8h-1.5V8.6L9.7 13h-1.4L5.9 8.6V14z" fill="#fff"/>
      </svg>
      <span class="wordmark">metro-mcp</span>
    </a>
    <div class="nav-links">
      <a href="https://github.com/Aarekaz/metro-mcp#mcp-client-integration">Docs</a>
      <a href="https://github.com/Aarekaz/metro-mcp">GitHub</a>
      <button type="button" class="cta-pill" data-open-install>Add to LLM</button>
    </div>
  </nav>

  <main>
    <div class="halftone" aria-hidden="true"></div>
    <section class="hero">
      <h1>Plug your LLM into the <span class="accent">subway</span>.</h1>
      <p class="subtitle">DC Metro and NYC Subway via the Model Context Protocol. Connect any MCP client to live arrivals, incidents, and 594 stations.</p>
      <div class="cta-row">
        <button type="button" class="url-pill" data-copy-url="https://metro-mcp.anuragd.me/mcp" aria-label="Copy MCP server URL">
          <span class="url-text">metro-mcp.anuragd.me/mcp</span>
          <span class="url-status" aria-hidden="true">Copy</span>
        </button>
        <button type="button" class="cta-button" data-open-install>Add to LLM</button>
      </div>
      <p class="footnote">Works with Claude · Cursor · Codex · Gemini</p>
    </section>
  </main>

  <footer>
    <span>© 2026 Anurag Dhungana</span>
    <span class="dot-sep">·</span>
    <span>MIT</span>
    <span class="dot-sep">·</span>
    <span id="server-version">v—</span>
    <span class="dot-sep">·</span>
    <span id="server-status">status: …</span>
  </footer>

  <dialog id="install-dialog" aria-labelledby="install-title">
    <div class="dialog-inner">
      <header class="dialog-header">
        <h2 id="install-title">Add metro-mcp to your MCP client</h2>
        <button type="button" class="dialog-close" data-close-install aria-label="Close">×</button>
      </header>
      <p class="dialog-subtitle">Paste the snippet for your client.</p>

      <div role="tablist" aria-label="Client" class="tabs">
        <button role="tab" aria-selected="true" aria-controls="tab-claude" id="tab-btn-claude" data-tab="claude" tabindex="0">Claude Desktop</button>
        <button role="tab" aria-selected="false" aria-controls="tab-cursor" id="tab-btn-cursor" data-tab="cursor" tabindex="-1">Cursor</button>
        <button role="tab" aria-selected="false" aria-controls="tab-codex" id="tab-btn-codex" data-tab="codex" tabindex="-1">Codex CLI</button>
        <button role="tab" aria-selected="false" aria-controls="tab-generic" id="tab-btn-generic" data-tab="generic" tabindex="-1">Generic JSON</button>
      </div>

      <div role="tabpanel" id="tab-claude" aria-labelledby="tab-btn-claude">
        <p class="tab-help">Add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></p>
        <pre><code>{
  "mcpServers": {
    "metro-mcp": {
      "url": "https://metro-mcp.anuragd.me/mcp"
    }
  }
}</code></pre>
        <button type="button" class="copy-snippet">Copy</button>
      </div>

      <div role="tabpanel" id="tab-cursor" aria-labelledby="tab-btn-cursor" hidden>
        <p class="tab-help">Add to <code>~/.cursor/mcp.json</code></p>
        <pre><code>{
  "mcpServers": {
    "metro-mcp": {
      "url": "https://metro-mcp.anuragd.me/mcp"
    }
  }
}</code></pre>
        <button type="button" class="copy-snippet">Copy</button>
      </div>

      <div role="tabpanel" id="tab-codex" aria-labelledby="tab-btn-codex" hidden>
        <p class="tab-help">Run in your terminal</p>
        <pre><code>codex mcp add metro-mcp https://metro-mcp.anuragd.me/mcp</code></pre>
        <button type="button" class="copy-snippet">Copy</button>
      </div>

      <div role="tabpanel" id="tab-generic" aria-labelledby="tab-btn-generic" hidden>
        <p class="tab-help">For any MCP client following the Streamable HTTP convention</p>
        <pre><code>{
  "name": "metro-mcp",
  "url": "https://metro-mcp.anuragd.me/mcp",
  "transport": "streamable-http"
}</code></pre>
        <button type="button" class="copy-snippet">Copy</button>
      </div>
    </div>
  </dialog>

  <div id="toast" role="status" aria-live="polite"></div>
</body>
</html>
```

- [ ] **Step 2: Verify the file parses as valid HTML5**

Run: `bunx wrangler dev` (in another terminal)
Open: `http://localhost:8787/`
Expected: The page loads with default browser styles. All text content is visible. Nav, hero, footer are stacked vertically (no CSS yet). The modal does not appear (it's a closed `<dialog>`).

No commit yet — full file ships in one commit at the end.

---

## Task 2: Add design tokens + reset + base typography

**Files:**
- Modify: `public/index.html` — insert `<style>` block at end of `<head>`

- [ ] **Step 1: Add Google Fonts preconnects + the stylesheet link inside `<head>`**

Insert these lines after the existing `<meta property="twitter:image">` line and before `</head>`:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #fafbfc;
      --ink: #0a2540;
      --ink-2: #5b6470;
      --ink-3: #8a93a0;
      --border: #e6e8eb;
      --accent: #ff6b1a;
      --surface: #ffffff;

      --radius-pill: 999px;
      --radius-card: 12px;
      --radius-input: 8px;

      --shadow-modal: 0 24px 60px rgba(10, 37, 64, 0.18);

      --font-ui: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-ui);
      font-size: 15px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    body {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    a { color: inherit; text-decoration: none; }

    button {
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      background: none;
      border: 0;
      color: inherit;
      cursor: pointer;
    }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  </style>
```

- [ ] **Step 2: Reload and verify base styles**

Reload `http://localhost:8787/`.
Expected: Off-white background. Inter font visible in the headline and body. Text is left-aligned, no layout yet. The page body fills the viewport vertically.

---

## Task 3: Style nav and footer

**Files:**
- Modify: `public/index.html` — append rules to the existing `<style>` block

- [ ] **Step 1: Append nav and footer CSS to the `<style>` block (before `</style>`)**

```css
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 24px;
      height: 64px;
      flex-shrink: 0;
    }
    @media (min-width: 720px) {
      nav { padding: 18px 48px; }
    }

    nav .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    nav .wordmark { font-size: 15px; }

    nav .nav-links {
      display: flex;
      align-items: center;
      gap: 20px;
      font-size: 14px;
      color: var(--ink-2);
    }
    nav .nav-links a:hover { color: var(--ink); }

    nav .cta-pill {
      background: var(--ink);
      color: #fff;
      padding: 7px 14px;
      border-radius: var(--radius-pill);
      font-size: 13px;
      font-weight: 500;
      transition: filter 120ms ease;
    }
    nav .cta-pill:hover { filter: brightness(1.1); }

    footer {
      flex-shrink: 0;
      padding: 14px 24px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 12px;
      color: var(--ink-3);
    }
    @media (min-width: 720px) {
      footer { padding: 14px 48px; }
    }
    footer .dot-sep { color: var(--border); }
```

- [ ] **Step 2: Reload and verify nav/footer layout**

Expected: Nav: brand on the left, `Docs` / `GitHub` / `[Add to LLM]` on the right. Pill is navy with white text. Footer: centered single line, muted gray text with dot separators. Both elements look right at desktop and mobile (resize browser to confirm).

---

## Task 4: Style hero and halftone decoration

**Files:**
- Modify: `public/index.html` — append hero rules to the `<style>` block

- [ ] **Step 1: Append hero CSS to the `<style>` block**

```css
    main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 24px;
      overflow: hidden;
    }

    .halftone {
      position: absolute;
      top: 38%;
      left: -120px;
      right: -120px;
      height: 220px;
      background: radial-gradient(var(--ink) 1.5px, transparent 1.5px) 0 0 / 12px 12px;
      -webkit-mask:
        radial-gradient(ellipse 70% 32% at 22% 50%, black, transparent 70%),
        radial-gradient(ellipse 65% 28% at 78% 50%, black, transparent 70%);
              mask:
        radial-gradient(ellipse 70% 32% at 22% 50%, black, transparent 70%),
        radial-gradient(ellipse 65% 28% at 78% 50%, black, transparent 70%);
      -webkit-mask-composite: source-over;
              mask-composite: add;
      opacity: 0.4;
      pointer-events: none;
      z-index: 0;
    }

    .hero {
      position: relative;
      z-index: 1;
      max-width: 680px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }

    .hero h1 {
      font-size: clamp(36px, 5.5vw, 56px);
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1.05;
    }
    .hero h1 .accent { color: var(--accent); }

    .hero .subtitle {
      max-width: 560px;
      font-size: clamp(15px, 1.4vw, 17px);
      line-height: 1.55;
      color: var(--ink-2);
    }

    .hero .footnote {
      font-size: 13px;
      color: var(--ink-3);
      margin-top: 4px;
    }
```

- [ ] **Step 2: Reload and verify hero**

Expected: Hero is vertically centered between nav and footer. Headline reads `Plug your LLM into the subway.` with `subway` in transit-orange. Subtitle below in muted gray, max ~640px wide. Footnote at the bottom in lighter gray. A dotted halftone pattern sweeps horizontally behind the hero at about 40% from the top, with soft edges. Headline scales smoothly when you resize the browser.

---

## Task 5: Style the CTA row (URL pill + Add to LLM button)

**Files:**
- Modify: `public/index.html` — append CTA rules to the `<style>` block

- [ ] **Step 1: Append CTA CSS to the `<style>` block**

```css
    .cta-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .url-pill {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 10px 16px;
      border-radius: var(--radius-pill);
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--ink);
      transition: border-color 120ms ease, transform 120ms ease;
    }
    .url-pill:hover { border-color: var(--ink-2); }
    .url-pill:active { transform: translateY(1px); }
    .url-pill .url-status {
      font-family: var(--font-ui);
      font-size: 12px;
      color: var(--ink-3);
      padding-left: 12px;
      border-left: 1px solid var(--border);
    }
    .url-pill[data-copied="true"] .url-status { color: var(--accent); }

    .cta-button {
      background: var(--ink);
      color: #fff;
      padding: 10px 18px;
      border-radius: var(--radius-pill);
      font-size: 14px;
      font-weight: 500;
      transition: filter 120ms ease, transform 120ms ease;
    }
    .cta-button:hover { filter: brightness(1.1); }
    .cta-button:active { transform: translateY(1px); }
```

- [ ] **Step 2: Reload and verify**

Expected: URL pill on the left of the CTA row — white background, mono URL text, a thin "Copy" affordance separated by a 1px divider. "Add to LLM" pill on the right — navy background, white text. On narrow widths (< 380 px), the two wrap onto separate lines.

---

## Task 6: Style the modal and toast

**Files:**
- Modify: `public/index.html` — append modal/toast rules to the `<style>` block

- [ ] **Step 1: Append modal + toast CSS to the `<style>` block**

```css
    dialog#install-dialog {
      border: 0;
      padding: 0;
      background: transparent;
      max-width: 560px;
      width: calc(100% - 32px);
    }
    dialog#install-dialog::backdrop {
      background: rgba(10, 37, 64, 0.45);
      backdrop-filter: blur(4px);
    }
    dialog#install-dialog[open] {
      animation: dialog-in 150ms ease-out;
    }
    @keyframes dialog-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .dialog-inner {
      background: var(--surface);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-modal);
      padding: 24px;
    }
    .dialog-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .dialog-header h2 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .dialog-close {
      font-size: 22px;
      line-height: 1;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      color: var(--ink-3);
    }
    .dialog-close:hover { background: var(--bg); color: var(--ink); }
    .dialog-subtitle {
      font-size: 13px;
      color: var(--ink-3);
      margin-top: 4px;
    }

    .tabs {
      display: flex;
      gap: 4px;
      margin: 20px 0 12px;
      padding: 4px;
      background: var(--bg);
      border-radius: var(--radius-input);
      border: 1px solid var(--border);
      overflow-x: auto;
    }
    .tabs button[role="tab"] {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--ink-2);
      white-space: nowrap;
    }
    .tabs button[role="tab"][aria-selected="true"] {
      background: var(--surface);
      color: var(--ink);
      box-shadow: 0 1px 3px rgba(10, 37, 64, 0.08);
    }

    [role="tabpanel"] .tab-help {
      font-size: 12px;
      color: var(--ink-3);
      margin-bottom: 8px;
    }
    [role="tabpanel"] .tab-help code {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg);
      padding: 2px 5px;
      border-radius: 4px;
    }

    [role="tabpanel"] pre {
      background: #0c1320;
      color: #e8eef5;
      border-radius: var(--radius-input);
      padding: 16px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.55;
      position: relative;
    }
    [role="tabpanel"] code { font-family: inherit; }

    [role="tabpanel"] .copy-snippet {
      margin-top: 10px;
      width: 100%;
      padding: 9px 14px;
      background: var(--ink);
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      border-radius: var(--radius-input);
      transition: filter 120ms ease;
    }
    [role="tabpanel"] .copy-snippet:hover { filter: brightness(1.1); }

    #toast {
      position: fixed;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ink);
      color: #fff;
      padding: 8px 16px;
      border-radius: var(--radius-pill);
      font-size: 13px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms ease;
      z-index: 100;
    }
    #toast[data-show="true"] { opacity: 1; }

    @media (prefers-reduced-motion: reduce) {
      dialog#install-dialog[open] { animation: none; }
      #toast { transition: none; }
      .halftone { /* no drift to disable in v1, but reserved */ }
    }
```

- [ ] **Step 2: Verify modal styles with dev tools**

Open dev tools console. Run: `document.getElementById('install-dialog').showModal()`
Expected: A modal appears with a navy translucent backdrop with subtle blur. "Add metro-mcp to your MCP client" title at top, close × top-right, "Paste the snippet for your client." subtitle below. Four tabs (Claude Desktop / Cursor / Codex CLI / Generic JSON) — first is selected (white pill). A dark code block with the Claude config, and a navy "Copy" button below. Pressing `Esc` closes the modal.

---

## Task 7: Add clipboard-copy JS for the URL pill

**Files:**
- Modify: `public/index.html` — add `<script>` block just before `</body>`

- [ ] **Step 1: Add the script block before `</body>`**

```html
  <script>
    (() => {
      const toast = document.getElementById('toast');
      let toastTimer = null;
      const showToast = (msg) => {
        toast.textContent = msg;
        toast.dataset.show = 'true';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.dataset.show = 'false'; }, 1500);
      };

      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          // Fallback for non-secure contexts (rare; the prod site is HTTPS).
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); return true; }
          catch { return false; }
          finally { document.body.removeChild(ta); }
        }
      };

      // URL pill: click anywhere copies the configured URL.
      document.querySelectorAll('[data-copy-url]').forEach((el) => {
        el.addEventListener('click', async () => {
          const url = el.getAttribute('data-copy-url');
          const ok = await copy(url);
          if (!ok) { showToast('Copy failed'); return; }
          el.dataset.copied = 'true';
          const status = el.querySelector('.url-status');
          if (status) status.textContent = 'Copied';
          showToast('Copied · paste into your MCP client');
          setTimeout(() => {
            delete el.dataset.copied;
            if (status) status.textContent = 'Copy';
          }, 1500);
        });
      });
    })();
  </script>
```

- [ ] **Step 2: Reload and verify URL pill copy works**

Reload. Click the URL pill once.
Expected: The "Copy" indicator on the pill changes to "Copied" in transit-orange. A toast appears bottom-center reading "Copied · paste into your MCP client" and fades after 1.5 s. Open clipboard manager / paste somewhere to verify `https://metro-mcp.anuragd.me/mcp` is on the clipboard.

---

## Task 8: Add modal open/close + tab switching + snippet copy JS

**Files:**
- Modify: `public/index.html` — extend the existing `<script>` block

- [ ] **Step 1: Add the modal + tabs logic to the existing IIFE in the `<script>` block**

Insert this code inside the `(() => { ... })()` IIFE, after the URL-pill block:

```js
      // Modal open/close.
      const dialog = document.getElementById('install-dialog');
      const openModal = () => {
        dialog.showModal();
        // Move focus to the currently-selected tab.
        const selected = dialog.querySelector('[role="tab"][aria-selected="true"]');
        if (selected) selected.focus();
      };
      const closeModal = () => dialog.close();

      document.querySelectorAll('[data-open-install]').forEach((btn) => {
        btn.addEventListener('click', openModal);
      });
      document.querySelectorAll('[data-close-install]').forEach((btn) => {
        btn.addEventListener('click', closeModal);
      });
      // <dialog> handles Esc natively. Backdrop click:
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeModal();
      });

      // Tab switching with arrow-key support.
      const tabs = Array.from(dialog.querySelectorAll('[role="tab"]'));
      const panels = Array.from(dialog.querySelectorAll('[role="tabpanel"]'));
      const selectTab = (idx) => {
        tabs.forEach((t, i) => {
          const selected = i === idx;
          t.setAttribute('aria-selected', selected ? 'true' : 'false');
          t.tabIndex = selected ? 0 : -1;
          if (selected) t.focus();
        });
        panels.forEach((p, i) => { p.hidden = i !== idx; });
      };
      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => selectTab(i));
        tab.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); selectTab((i + 1) % tabs.length); }
          if (e.key === 'ArrowLeft')  { e.preventDefault(); selectTab((i - 1 + tabs.length) % tabs.length); }
          if (e.key === 'Home')        { e.preventDefault(); selectTab(0); }
          if (e.key === 'End')         { e.preventDefault(); selectTab(tabs.length - 1); }
        });
      });

      // Snippet copy buttons inside each tabpanel.
      document.querySelectorAll('.copy-snippet').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const code = btn.parentElement.querySelector('pre code');
          if (!code) return;
          const ok = await copy(code.textContent.trim());
          const original = btn.textContent;
          btn.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => { btn.textContent = original; }, 1500);
        });
      });
```

- [ ] **Step 2: Reload and verify modal interactions**

Reload. Test each:
1. Click **Add to LLM** in nav → modal opens, focus is on the first tab (Claude Desktop).
2. Press **→** arrow → tab focus moves to Cursor; the Cursor panel is now visible.
3. Press **Esc** → modal closes.
4. Click **Add to LLM** in the hero (the navy button) → same modal opens.
5. Click the dark area outside the modal → modal closes.
6. Reopen, click the **Copy** button below the snippet → button text changes to "Copied" for 1.5 s. Paste somewhere to verify the snippet contents.

---

## Task 9: Add live version/status fetch + reduced-motion guard

**Files:**
- Modify: `public/index.html` — extend the existing `<script>` block

- [ ] **Step 1: Add the version/status fetch at the end of the IIFE**

Insert at the end of the IIFE in `<script>`:

```js
      // Pull live server version + status from `/`. Best-effort; silent on failure.
      (async () => {
        try {
          const res = await fetch('/', {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
          });
          if (!res.ok) return;
          const info = await res.json();
          const versionEl = document.getElementById('server-version');
          const statusEl  = document.getElementById('server-status');
          if (info.version) versionEl.textContent = `v${info.version}`;
          if (info.status)  statusEl.textContent  = `status: ${info.status}`;
        } catch { /* silent */ }
      })();
```

- [ ] **Step 2: Reload and verify footer updates**

Reload. Watch the footer.
Expected: For a moment the footer shows `v—` and `status: …` (the initial placeholders). Within a fraction of a second they update to the real values returned by `/` (e.g., `v4.0.0` and `status: operational` when running against the Phase 2 branch, or `v3.1.1` / `status: operational` against `main`). When `wrangler dev` returns the server-info JSON from `Router.getServerInfoResponse`, this should populate.

If `/` doesn't return JSON in your local dev environment yet (the server-info handler matches on path + GET only — that's the existing behavior), the placeholders remain — that's acceptable and silent.

---

## Task 10: Final smoke check + commit

**Files:**
- Modify: `public/index.html` (review only)

- [ ] **Step 1: Run the full smoke checklist against `bunx wrangler dev`**

Open `http://localhost:8787/` in a fresh tab.

**Visual** (no scroll on a 1280×800 viewport):
- [ ] Nav top: brand on the left with the [M] mark; `Docs`, `GitHub`, `[Add to LLM]` on the right.
- [ ] Hero centered. Headline reads "Plug your LLM into the subway." with `subway` in transit-orange.
- [ ] Subtitle is muted gray, ~640px wide.
- [ ] CTA row: white URL pill on the left, navy "Add to LLM" pill on the right.
- [ ] Footnote `Works with Claude · Cursor · Codex · Gemini` directly below.
- [ ] Halftone dots visible behind the hero, sweeping horizontally, fading at both edges.
- [ ] Footer: single muted-gray line with copyright, license, version, status.
- [ ] No scrollbar at 1280×800.

**Mobile** (resize browser to 375px wide):
- [ ] Page reflows. Nav stays single-row. CTA row may wrap to two lines — OK.
- [ ] Halftone still visible but doesn't dominate.

**Interactions:**
- [ ] Click URL pill — toast shows "Copied · paste into your MCP client". URL is in clipboard.
- [ ] Click "Add to LLM" (either nav or hero) — modal opens.
- [ ] Press `→` / `←` arrows to switch tabs.
- [ ] Click "Copy" in any panel — snippet copies, button shows "Copied".
- [ ] Press `Esc` — modal closes.
- [ ] Click outside modal — modal closes.
- [ ] Tab key cycles through interactive elements with visible focus rings.

**Accessibility quick check:**
- [ ] Open dev-tools Accessibility tree. Confirm: one `h1`. The `.halftone` element is aria-hidden. The dialog has `aria-labelledby`. Each tab has `role="tab"` and proper `aria-selected`.
- [ ] Toggle "Reduce motion" in OS settings. Reload. Modal opens with a fade-only (no scale-in).

**Source size:**
- [ ] `wc -c public/index.html` — expect ≤ 12,000 bytes.

- [ ] **Step 2: Fix anything that fails the checklist**

If anything failed: revisit the relevant task above, fix in place, re-run that section's verification, then return to the smoke check.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): redesign as one-screen business card

Replaces the 1,900-line dark cyberpunk landing page with a centered
one-screen layout per docs/superpowers/specs/2026-06-03-landing-redesign-design.md.

- Headline: 'Plug your LLM into the subway.' (orange accent on 'subway')
- Subtitle: one-line value prop
- CTA row: click-to-copy URL pill + 'Add to LLM' button that opens a
  modal with copy-paste snippets for Claude Desktop, Cursor, Codex CLI,
  and Generic JSON.
- Footer: live-pulls version + status from /.
- Halftone 'route-line' decoration sweeps behind the hero.
- Vanilla HTML + inline CSS + ~80 lines of JS. No framework, no build,
  no third-party tracking. Two Google Fonts (Inter + JetBrains Mono).
- Single light theme. \`<dialog>\` element handles the modal; arrow
  keys switch tabs; full keyboard + reduced-motion support.
- ~12 KB raw HTML, down from 68 KB."
```

- [ ] **Step 4: Push**

```bash
git push
```

Branch is `feat/landing-redesign`. The first push (already happened with the spec commit) created the remote; this is just a follow-up push.

- [ ] **Step 5: Open PR**

```bash
gh pr create --base main --head feat/landing-redesign \
  --title "feat(landing): one-screen business-card redesign" \
  --body "Implements the design in \`docs/superpowers/specs/2026-06-03-landing-redesign-design.md\`. Single-file vanilla HTML, ~250 lines (down from ~1,900). See spec for decisions, copy, and accessibility notes."
```

---

## Self-Review

**Spec coverage check** (§1–§9 of the spec):

- §1 Page architecture (nav + hero + footer, ASCII wireframe) → Tasks 1, 3, 4
- §2 Visual system (tokens, type, halftone) → Tasks 2, 4
- §3 Component spec (nav, hero, modal, footer) → Tasks 3, 4, 5, 6
- §4 Interaction spec (copy, modal open/close, tabs, reduced motion) → Tasks 7, 8, 9; reduced-motion CSS in Task 6
- §5 Implementation approach (vanilla, single file, ≤ 12 KB) → enforced in Task 10's size check
- §6 Copy (headline, subtitle, modal snippets, meta tags) → Task 1 (HTML); meta tags in Task 1's `<head>`
- §7 Accessibility (single h1, focus trap, aria-modal, contrast) → covered by `<dialog>` (native focus trap + native modal semantics), Task 8 (arrow-key tabs), Task 10 (a11y smoke)
- §8 Out of scope (OG regen, dark mode, deep links, /install page) → not in any task ✓
- §9 Migration plan (replace wholesale, keep assets) → Task 1 (wholesale replace); favicon/og-image untouched ✓

**Placeholder scan:** No `TBD`, no `TODO`, no "add appropriate error handling", no "similar to Task N". Every step has the full content.

**Type consistency:** `data-copy-url`, `data-open-install`, `data-close-install`, `data-tab` attributes used in HTML (Task 1) match the JS selectors (Tasks 7, 8). Element IDs (`install-dialog`, `server-version`, `server-status`, `toast`) match between HTML and JS. CSS class names (`.url-pill`, `.cta-button`, `.halftone`, `.cta-row`, `.tabs`, `.copy-snippet`) are consistent across the markup and stylesheet.

**Single-file note:** The spec calls for one self-contained file. The plan does not add any new files; every change happens inside `public/index.html`. The order (HTML scaffold → styles by region → JS by feature) lets each task produce a visibly-progressing artifact, which is the closest analog to TDD for a static page.
