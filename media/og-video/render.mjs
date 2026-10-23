// Renders teaser.html frame by frame.
//   node render.mjs --stills 1,3,5     → stills/t-<t>.png
//   node render.mjs                    → public/og-video.mp4 (1280×720, 30 fps, silent)
// Fonts and three.js load from jsDelivr, so rendering needs the network.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30, W = 1280, H = 720;
const args = process.argv.slice(2);
const stills = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL(join(here, 'teaser.html')).href + '?render');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
const DURATION = await page.evaluate(() => window.DURATION);
const stage = page.locator('#stage');
const shoot = async (t, path) => { await page.evaluate(t => window.seek(t), t); await stage.screenshot({ path, animations: 'disabled' }); };

if (stills) {
  const dir = join(here, 'stills'); mkdirSync(dir, { recursive: true });
  for (const t of stills.split(',').map(Number)) await shoot(t, join(dir, `t-${t}.png`));
  console.log(`stills → ${dir}`);
} else {
  const frames = join(here, 'frames'); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
  const N = Math.round(FPS * DURATION), t0 = Date.now();
  for (let f = 0; f < N; f++) {
    await shoot(f / FPS, join(frames, `${String(f).padStart(4, '0')}.png`));
    if (f % 60 === 0) console.log(`frame ${f}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%04d.png'),
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '21', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(here, '../../public/og-video.mp4')], { stdio: 'inherit' });
  console.log('video → public/og-video.mp4');
}
await browser.close();
if (errors.length) { console.error('JS errors:\n' + errors.join('\n')); process.exit(1); }
