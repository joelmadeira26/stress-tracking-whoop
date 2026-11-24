// Renders the PNG app icons with the pre-installed Chromium. Run: node tools/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><radialGradient id="g" cx="25%" cy="0%" r="110%"><stop offset="0" stop-color="#16325e"/><stop offset="1" stop-color="#070d1c"/></radialGradient></defs>
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${pad ? 0.72 : 1}) translate(-256 -256)">
    <path d="M70 280h92l40-110 66 200 50-130 26 40h98" fill="none" stroke="#3da5ff" stroke-width="34" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="442" cy="280" r="22" fill="#f5c242"/>
  </g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, size, pad] of [['icon-192', 192, false], ['icon-512', 512, false], ['icon-maskable-512', 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `icons/${name}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
