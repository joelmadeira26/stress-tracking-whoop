// Renders Pulse's Android launcher icons (all densities) with the pre-installed Chromium.
const { chromium } = require('playwright');
const res = 'android-app/android/app/src/main/res';
const line = (scale) => `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)"><path d="M70 280h92l40-110 66 200 50-130 26 40h98" fill="none" stroke="#3da5ff" stroke-width="34" stroke-linejoin="round" stroke-linecap="round"/><circle cx="442" cy="280" r="22" fill="#f5c242"/></g>`;
const bg = `<defs><radialGradient id="g" cx="25%" cy="0%" r="110%"><stop offset="0" stop-color="#16325e"/><stop offset="1" stop-color="#070d1c"/></radialGradient></defs>`;
const full = (round) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${bg}${round ? '<circle cx="256" cy="256" r="256" fill="url(#g)"/>' : '<rect width="512" height="512" rx="112" fill="url(#g)"/>'}${line(0.9)}</svg>`;
const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${line(0.62)}</svg>`;
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (svg, size, file) => {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: file, omitBackground: true });
  };
  for (const [d, k] of Object.entries(dens)) {
    await shot(full(false), Math.round(48 * k), `${res}/mipmap-${d}/ic_launcher.png`);
    await shot(full(true), Math.round(48 * k), `${res}/mipmap-${d}/ic_launcher_round.png`);
    await shot(fg, Math.round(108 * k), `${res}/mipmap-${d}/ic_launcher_foreground.png`);
  }
  await b.close();
  console.log('android icons written');
})();
