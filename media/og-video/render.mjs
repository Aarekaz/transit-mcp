// Renders launch.html frame by frame.
//   node capture.mjs first: the answers on screen are the live server's, saved to live.js.
//   node render.mjs --stills 3,10,27           → stills/<cut>-<theme>-<t>.png
//   node render.mjs [--theme light]            → out/transit-mcp-launch-<theme>.mp4 (1920×1080, 30 fps, silent)
//   node render.mjs --cut og [--theme light]   → public/og-video.mp4 for dark, out/og-light.mp4 for light (1280×720)
// Fonts and three.js load from jsDelivr, so rendering needs the network.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30, W = 1920, H = 1080;
const args = process.argv.slice(2);
const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const cut = arg('--cut') ?? 'launch', theme = arg('--theme') ?? 'dark', stills = arg('--stills');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${pathToFileURL(join(here, 'launch.html')).href}?render&cut=${cut}&theme=${theme}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
const DURATION = await page.evaluate(() => window.DURATION);
const stage = page.locator('#stage');
const shoot = async (t, path) => { await page.evaluate(t => window.seek(t), t); await stage.screenshot({ path, animations: 'disabled' }); };

if (stills) {
  const dir = join(here, 'stills'); mkdirSync(dir, { recursive: true });
  for (const t of stills.split(',').map(Number)) await shoot(t, join(dir, `${cut}-${theme}-${t}.png`));
  console.log(`stills → ${dir}`);
} else {
  const frames = join(here, 'frames'); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
  const N = Math.round(FPS * DURATION), t0 = Date.now();
  for (let f = 0; f < N; f++) {
    await shoot(f / FPS, join(frames, `${String(f).padStart(4, '0')}.png`));
    if (f % 90 === 0) console.log(`frame ${f}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const og = cut === 'og';
  const out = og ? (theme === 'dark' ? join(here, '../../public/og-video.mp4') : join(here, `out/og-${theme}.mp4`)) : join(here, `out/transit-mcp-launch-${theme}.mp4`);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%04d.png'),
    ...(og ? ['-vf', 'scale=1280:720:flags=lanczos'] : []),
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', og ? '22' : '17', '-tune', 'film', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`video → ${out}`);
}
await browser.close();
if (errors.length) { console.error('JS errors:\n' + errors.join('\n')); process.exit(1); }
