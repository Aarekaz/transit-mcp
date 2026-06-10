import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const publicDir = path.join(root, 'public');

function dataUri(file, mimeType) {
  return `data:${mimeType};base64,${readFileSync(path.join(publicDir, file)).toString('base64')}`;
}

const train = dataUri('train-classic-bg.jpg', 'image/jpeg');
const icon = dataUri('metro-mcp-slick.svg', 'image/svg+xml');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#06121d" flood-opacity="0.28"/>
    </filter>
    <linearGradient id="topWash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fffaf6" stop-opacity="0.88"/>
      <stop offset="0.48" stop-color="#f8fbff" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#f7f9fb" stop-opacity="0.80"/>
    </linearGradient>
    <linearGradient id="inkFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0a2540" stop-opacity="0.98"/>
      <stop offset="0.62" stop-color="#0a2540" stop-opacity="0.90"/>
      <stop offset="1" stop-color="#0a2540" stop-opacity="0.20"/>
    </linearGradient>
    <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.2" fill="#7aa0c8" opacity="0.28"/>
    </pattern>
  </defs>

  <rect width="1200" height="630" fill="#f8fafc"/>
  <image href="${train}" x="0" y="-155" width="1200" height="960" preserveAspectRatio="xMidYMid slice" opacity="0.58"/>
  <rect width="1200" height="630" fill="url(#topWash)"/>
  <rect x="0" y="296" width="1200" height="112" fill="url(#dots)" opacity="0.72"/>
  <rect x="0" y="0" width="790" height="630" fill="url(#inkFade)" opacity="0.06"/>

  <g transform="translate(76 62)">
    <image href="${icon}" x="0" y="0" width="58" height="58"/>
    <text x="76" y="38" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="700" fill="#0a2540">metro-mcp</text>
  </g>

  <g transform="translate(76 150)">
    <text font-family="Inter, Arial, sans-serif" font-size="72" font-weight="800" letter-spacing="0" fill="#0a2540">
      <tspan x="0" y="72">Plug your LLM</tspan>
      <tspan x="0" y="154">into the</tspan><tspan dx="14" fill="#ff6b1a">subway.</tspan>
    </text>
    <text x="2" y="216" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="500" fill="#34465b">
      Live DC Metro + NYC Subway data through MCP
    </text>
  </g>

  <g transform="translate(76 430)" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="650" fill="#0a2540">
    <g>
      <rect width="122" height="48" rx="24" fill="#ffffff" stroke="#dfe5ec"/>
      <circle cx="30" cy="24" r="8" fill="#35c77b"/>
      <text x="50" y="31">13 tools</text>
    </g>
    <g transform="translate(142 0)">
      <rect width="166" height="48" rx="24" fill="#ffffff" stroke="#dfe5ec"/>
      <circle cx="30" cy="24" r="8" fill="#1d5fd7"/>
      <text x="50" y="31">598 stations</text>
    </g>
    <g transform="translate(328 0)">
      <rect width="174" height="48" rx="24" fill="#ffffff" stroke="#dfe5ec"/>
      <circle cx="30" cy="24" r="8" fill="#ff6b1a"/>
      <text x="50" y="31">Cloudflare</text>
    </g>
  </g>

  <g transform="translate(700 108)" filter="url(#shadow)">
    <rect x="0" y="0" width="420" height="356" rx="26" fill="#ffffff" stroke="#dfe5ec"/>
    <rect x="0" y="0" width="420" height="72" rx="26" fill="#fbfcfd"/>
    <rect x="0" y="54" width="420" height="18" fill="#fbfcfd"/>
    <circle cx="34" cy="36" r="8" fill="#35c77b"/>
    <text x="54" y="44" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="750" fill="#0a2540">metro-mcp</text>
    <text x="150" y="44" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="500" fill="#8a93a0">connected</text>

    <text x="36" y="122" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#8a93a0">YOU</text>
    <text x="36" y="154" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="550" fill="#0a2540">Next 1 train at Times Sq?</text>

    <text x="36" y="212" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#8a93a0">TOOL</text>
    <rect x="36" y="232" width="348" height="58" rx="12" fill="#07111f"/>
    <text x="60" y="269" font-family="'JetBrains Mono', Menlo, monospace" font-size="20" font-weight="700" fill="#e8eef7">get_station_predictions</text>

    <text x="36" y="326" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" fill="#0a2540">1 train in 2 min</text>
    <circle cx="210" cy="318" r="17" fill="#ee352e"/>
    <text x="205" y="325" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800" fill="#ffffff">1</text>
  </g>

  <text x="76" y="574" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="600" fill="#596a7d">metro-mcp.anuragd.me</text>
</svg>`;

const svgPath = path.join(publicDir, 'og-image.svg');
const pngPath = path.join(publicDir, 'og-image.png');

writeFileSync(svgPath, svg);

await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(pngPath);

console.log(`Generated ${path.relative(root, pngPath)} and ${path.relative(root, svgPath)}`);
