// End-to-end test in headless Chromium: fake BLE strap, mocked Anthropic API, real IndexedDB.
// Run: node tests/e2e.mjs   (screenshots land in tests/screens/)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const PORT = 8765;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const FAKE_BLE = () => {
  window.__fakeHR = { hr: 74, fail: false };
  const ch = {
    f: null,
    addEventListener(t, f) { this.f = f; },
    removeEventListener() {},
    async startNotifications() {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (!device.gatt.connected || !this.f) return;
        const hr = Math.round(window.__fakeHR.hr + (Math.random() * 4 - 2));
        const rr = Math.round(((60000 / hr) * (1 + (Math.random() - 0.5) * 0.06) * 1024) / 1000);
        const buf = new Uint8Array([0x16, hr, rr & 255, rr >> 8]);
        this.f({ target: { value: new DataView(buf.buffer) } });
      }, 1000);
    },
  };
  const device = {
    name: 'WHOOP 4C0FFEE',
    _dl: null,
    gatt: {
      connected: false,
      async connect() {
        if (window.__fakeHR.fail) throw new Error('out of range');
        this.connected = true;
        return this;
      },
      async getPrimaryService() { return { async getCharacteristic() { return ch; } }; },
      disconnect() { this.connected = false; device._dl && device._dl(); },
    },
    addEventListener(t, f) { this._dl = f; },
    removeEventListener() {},
  };
  window.__fakeDevice = device;
  Object.defineProperty(navigator, 'bluetooth', { value: { async requestDevice(opts) { window.__lastRequest = opts; return device; } } });
};

const MOCK_TEXT =
  'Ice-cold until the penalty, then pure nerves\n\nYour heart rate peaked at 112 bpm right after the second goal.\n\nTakeaway: breathe out slowly during VAR checks.';

const results = [];
const check = (name, cond) => {
  results.push([name, !!cond]);
  if (!cond) console.error('FAIL:', name);
};

const browser = await chromium.launch();
const apiCalls = [];
async function newPhone(opts = {}) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  await ctx.addInitScript(FAKE_BLE);
  await ctx.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    apiCalls.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: MOCK_TEXT }] }),
    });
  });
  return ctx;
}
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g/.test(m.text()) && errors.push(m.text()));
};

try {
  /* ---------- 1. Phone: home, settings, demos ---------- */
  const ctx = await newPhone();
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('.startbtn');
  check('home shows 3 start buttons', (await page.locator('.startbtn').count()) === 3);
  check('no iOS banner on Android', (await page.locator('.banner.warn').count()) === 0);
  await page.screenshot({ path: 'tests/screens/01-home-phone.png', fullPage: true });

  await page.goto(BASE + '#/settings');
  await page.fill('#sKey', 'sk-ant-test-key');
  await page.fill('#sRest', '58');
  await page.click('#sSave');
  for (const k of ['sport', 'meeting', 'workout']) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-demo="${k}"]`);
    await page.waitForSelector('#dChart svg');
  }
  // On the workout detail now. Open sport demo from history.
  await page.goto(BASE + '#/history');
  await page.waitForSelector('.hist li');
  check('history lists 3 demos', (await page.locator('.hist li').count()) === 3);
  check('history comparison shown', (await page.locator('.compare').count()) === 1);
  await page.screenshot({ path: 'tests/screens/02-history-phone.png', fullPage: true });
  await page.click('.chip[data-f="meeting"]');
  await page.waitForSelector('.chip.on[data-f="meeting"]');
  check('filter by type', (await page.locator('.hist li').count()) === 1);
  await page.click('.chip[data-f="all"]');
  await page.locator('.hist li a', { hasText: 'Benfica' }).click();
  await page.waitForSelector('#dChart svg');
  const vw = await page.evaluate(() => document.querySelector('#dChart svg').getAttribute('width'));
  check('chart drawn at real pixel width on phone (~380)', Number(vw) > 300 && Number(vw) < 420);
  check('legend has 9 moments', (await page.locator('.legend li').count()) === 9);
  check('title shows score', (await page.locator('h1').innerText()).includes('Benfica 2–1 Porto'));
  check('no horizontal overflow on phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.click('#wRegen');
  await page.waitForSelector('.writeup p:first-child:has-text("Ice-cold")');
  check('AI write-up rendered from mocked API', true);
  const call = apiCalls.at(-1);
  check('API headers', call.headers['x-api-key'] === 'sk-ant-test-key' && call.headers['anthropic-version'] === '2023-06-01' && call.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  check('API model default', call.body.model === 'claude-sonnet-5-5');
  const sent = JSON.parse(call.body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
  check('API payload has resting HR from settings', sent.restingHr === 58);
  check('API payload has teams & score', sent.finalScore === '2-1' && sent.teams.myTeam === 'Benfica');
  await page.screenshot({ path: 'tests/screens/03-detail-phone.png', fullPage: true });

  // Share: download fallback
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dShare')]);
  const pngPath = 'tests/screens/04-export.png';
  await dl.saveAs(pngPath);
  const png = fs.readFileSync(pngPath);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check(`PNG export 2x (${w}x${h})`, w === 1440 && h > 1000);
  // Share: Web Share API path
  await page.evaluate(() => {
    window.__shared = null;
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = async (d) => { window.__shared = { n: d.files.length, type: d.files[0].type, name: d.files[0].name }; };
  });
  await page.click('#dShare');
  await page.waitForFunction(() => window.__shared);
  const shared = await page.evaluate(() => window.__shared);
  check('Web Share API gets a PNG file', shared.n === 1 && shared.type === 'image/png' && shared.name.endsWith('.png'));

  // Meeting + workout detail screenshots
  for (const name of ['Interview', 'Leg day']) {
    await page.goto(BASE + '#/history');
    await page.locator('.hist li a', { hasText: name }).click();
    await page.waitForSelector('#dChart svg');
    await page.screenshot({ path: `tests/screens/05-detail-${name.split(' ')[0].toLowerCase()}.png`, fullPage: true });
  }

  /* ---------- 2. Live session with fake strap (clock fast-forwarded) ---------- */
  const lctx = await newPhone();
  const lp = await lctx.newPage();
  watch(lp);
  await lp.clock.install({ time: new Date('2026-11-22T19:50:00') });
  await lp.goto(BASE);
  await lp.waitForSelector('.startbtn');
  await lp.click('[data-act="connect"]');
  await lp.clock.runFor(3000);
  check('strap connects (filter by heart_rate service)', (await lp.locator('#strapText').innerText()).includes('WHOOP') &&
    JSON.stringify(await lp.evaluate(() => window.__lastRequest)) === JSON.stringify({ filters: [{ services: ['heart_rate'] }] }));
  check('home BPM visible', /\d+/.test(await lp.locator('#strapBpm').innerText()));
  await lp.click('[data-act="connect-all"]');
  await lp.clock.runFor(1500);
  check('show-all uses acceptAllDevices + optionalServices', JSON.stringify(await lp.evaluate(() => window.__lastRequest)) === JSON.stringify({ acceptAllDevices: true, optionalServices: ['heart_rate'] }));

  await lp.evaluate(() => localStorage.setItem('pulse.settings', JSON.stringify({ restingHr: 60, apiKey: 'sk-ant-live', model: 'claude-sonnet-5-5' })));
  await lp.reload();
  await lp.waitForSelector('.startbtn');
  await lp.click('[data-act="connect"]');
  await lp.clock.runFor(2000);
  await lp.click('[data-start="sport"]');
  await lp.fill('#fHome', 'Benfica');
  await lp.fill('#fAway', 'Porto');
  check('title auto-filled', (await lp.inputValue('#fTitle')) === 'Benfica v Porto');
  await lp.click('#fGo');
  await lp.waitForSelector('#liveBpm');
  await lp.clock.runFor(6 * 60 * 1000); // pre-match: 6 minutes (baseline)
  await lp.click('#phaseBtn'); // kick-off
  await lp.clock.runFor(22 * 60 * 1000 + 10000);
  check('clock shows match minute 23\'', (await lp.locator('#liveClock').innerText()) === "23'");
  await lp.evaluate(() => (window.__fakeHR.hr = 105));
  await lp.click('[data-tag="goal_home"]');
  await lp.clock.runFor(90 * 1000);
  await lp.evaluate(() => (window.__fakeHR.hr = 80));
  check('score updates to 1–0', (await lp.locator('#liveScore').innerText()) === '1–0');
  await lp.clock.runFor(5 * 60 * 1000);
  await lp.click('[data-tag="redcard"]');
  await lp.click('[data-tag="goal_away"]');
  check('score 1–1', (await lp.locator('#liveScore').innerText()) === '1–1');
  await lp.click('#undoBtn');
  check('undo removes goal', (await lp.locator('#liveScore').innerText()) === '1–0');
  await lp.fill('#freeText', 'Post hit!');
  await lp.press('#freeText', 'Enter');
  // strap drops out for ~2 minutes
  await lp.evaluate(() => { window.__fakeHR.fail = true; window.__fakeDevice.gatt.disconnect(); });
  await lp.clock.runFor(3000);
  check('reconnecting status shown', (await lp.locator('#livePill').innerText()).toLowerCase().includes('reconnecting'));
  await lp.clock.runFor(2 * 60 * 1000);
  await lp.evaluate(() => (window.__fakeHR.fail = false));
  await lp.clock.runFor(35 * 1000);
  check('reconnected after backoff', (await lp.locator('#livePill').innerText()).includes('Live'));
  await lp.clock.runFor(15 * 60 * 1000);
  await lp.click('#phaseBtn'); // half-time
  check('HT clock', (await lp.locator('#liveClock').innerText()) === 'HT');
  await lp.clock.runFor(60 * 1000);
  await lp.screenshot({ path: 'tests/screens/06-live-phone.png', fullPage: true });
  const liveSvg = await lp.locator('#liveChart svg').innerHTML();
  check('live chart has 3 markers + half-time band', (liveSvg.match(/<circle/g) || []).length === 3 && liveSvg.includes('fill-opacity="0.16"'));
  const gaps = await lp.evaluate(() => {
    const s = window.__pulse.state.live.samples; let n = 0;
    for (let i = 1; i < s.length; i++) if (s[i].t - s[i - 1].t > 15000) n++;
    return n;
  });
  check('strap drop left a gap in the samples (not interpolated)', gaps === 1);

  // Reload mid-session → resume prompt
  await lp.clock.runFor(6000); // let autosave run
  const before = await lp.evaluate(() => window.__pulse.state.live.samples.length);
  await lp.reload();
  await lp.waitForSelector('#modal .sheet');
  check('resume prompt after reload', (await lp.locator('#modal h2').innerText()).includes('Resume'));
  await lp.click('[data-r="resume"]');
  await lp.waitForSelector('#liveBpm');
  const after = await lp.evaluate(() => window.__pulse.state.live.samples.length);
  check(`autosave kept samples (${after}/${before})`, after >= before - 6 && after > 1000);
  await lp.click('#livePill'); // reconnect strap after reload (needs a tap)
  await lp.clock.runFor(10 * 60 * 1000);
  await lp.click('#phaseBtn'); // second half
  await lp.clock.runFor(30 * 60 * 1000);
  await lp.click('#phaseBtn'); // full time
  await lp.clock.runFor(60 * 1000);
  // End: needs two taps
  await lp.click('#endBtn');
  check('end needs a second tap', (await lp.locator('#endBtn').innerText()).includes('again'));
  await lp.click('#endBtn');
  await lp.waitForSelector('#eNotes');
  check('end screen stats', (await lp.locator('.stat').count()) === 4);
  await lp.fill('#eNotes', 'Great first half, nervy finish.');
  await lp.fill('#eMin', '67');
  await lp.selectOption('#eKind', 'goal_home');
  await lp.click('#eAdd');
  check('forgotten moment listed', (await lp.locator('#eList li').count()) === 1);
  await lp.screenshot({ path: 'tests/screens/07-end-phone.png', fullPage: true });
  await lp.click('#eSave');
  await lp.waitForSelector('.writeup p:first-child:has-text("Ice-cold")', { timeout: 10000 });
  check('saved session title has score 2–0', (await lp.locator('h1').innerText()).includes('Benfica 2–0 Porto'));
  check('auto write-up after save', true);
  check('legend has goal at 67\'', (await lp.locator('.legend li', { hasText: "67'" }).count()) === 1);
  const liveCleared = await lp.evaluate(() => window.__pulse.db.getLive());
  check('live autosave cleared after save', !liveCleared);
  await lp.screenshot({ path: 'tests/screens/08-saved-live-session.png', fullPage: true });

  /* ---------- 3. Meeting live toggle ---------- */
  await lp.goto(BASE + '#/start/meeting');
  await lp.fill('#fTitle', 'Interview with Zinc');
  check('meeting defaults to "doing"', (await lp.locator('#fMode button.on').innerText()) === 'Doing');
  await lp.click('#fGo');
  await lp.waitForSelector('#toggleBtn');
  await lp.clock.runFor(3 * 60 * 1000);
  await lp.click('#toggleBtn');
  await lp.clock.runFor(2 * 60 * 1000);
  check('speaking toggle on', (await lp.locator('#toggleBtn').getAttribute('class')).includes('on'));
  await lp.click('#toggleBtn');
  await lp.click('[data-tag="tough"]');
  await lp.clock.runFor(10000);
  check('speaking band drawn', (await lp.locator('#liveChart svg').innerHTML()).includes('Speaking'));
  await lp.click('#endBtn');
  await lp.click('#endBtn');
  await lp.click('#eDiscard');
  await lp.click('#eDiscard');
  await lp.waitForSelector('.startbtn');

  /* ---------- 4. Desktop widths ---------- */
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await dctx.addInitScript(FAKE_BLE);
  const dp = await dctx.newPage();
  watch(dp);
  await dp.goto(BASE + '#/settings');
  await dp.click('[data-demo="sport"]');
  await dp.waitForSelector('#dChart svg');
  const dw = await dp.evaluate(() => Number(document.querySelector('#dChart svg').getAttribute('width')));
  check(`desktop chart width (${dw})`, dw > 650);
  await dp.screenshot({ path: 'tests/screens/09-detail-desktop.png', fullPage: true });
  await dp.setViewportSize({ width: 360, height: 800 });
  await dp.waitForTimeout(300);
  const rw = await dp.evaluate(() => Number(document.querySelector('#dChart svg').getAttribute('width')));
  check(`chart redraws on resize to 360 (${rw})`, rw < 340);
  await dp.screenshot({ path: 'tests/screens/10-detail-360.png', fullPage: true });

  /* ---------- 5. iPhone Safari ---------- */
  const ictx = await browser.newContext({ ...devices['iPhone 14'] });
  const ip = await ictx.newPage();
  await ip.goto(BASE);
  await ip.waitForSelector('.startbtn');
  check('iOS banner explains no Web Bluetooth', (await ip.locator('.banner.warn').innerText()).includes('iPhone'));
  await ip.screenshot({ path: 'tests/screens/11-ios.png' });

  /* ---------- 6. PWA basics ---------- */
  const manifest = await (await fetch(BASE + 'manifest.webmanifest')).json();
  check('manifest icons 192/512', manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  const swReady = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
  check('service worker registered', swReady);

  check(`no page errors (${errors.join(' | ')})`, errors.length === 0);
} catch (e) {
  console.error(e);
  results.push(['exception: ' + e.message, false]);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r[1]);
for (const [n, ok] of results) console.log(ok ? '✓' : '✗', n);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
