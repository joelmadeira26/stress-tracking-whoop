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

/* ---------- fake live feeds (ESPN + OpenF1) ---------- */
const T0 = Date.parse('2026-11-25T20:00:00Z'); // kick-off of the live match
const feed = { goals: [], halftime: false };
const team = (id, name, short, ha, score) => ({ homeAway: ha, score: String(score), team: { id, displayName: name, shortDisplayName: short, abbreviation: short.slice(0, 3).toUpperCase(), logo: '' } });
function scoreboardEvent(id, date, state, detail, h, a) {
  return { id, date, competitions: [{ status: { type: { state, shortDetail: detail } }, competitors: [team('2250', 'Sporting CP', 'Sporting CP', 'home', h), team('360', 'Manchester United', 'Man United', 'away', a)] }] };
}
function summary() {
  const h = feed.goals.filter((g) => g.side === 'home').length;
  const a = feed.goals.filter((g) => g.side === 'away').length;
  const ke = [{ id: 'ko', type: { type: 'kickoff' }, wallclock: new Date(T0).toISOString(), period: { number: 1 }, clock: { value: 0, displayValue: '' } }];
  let hh = 0, aa = 0;
  for (const g of feed.goals) {
    g.side === 'home' ? hh++ : aa++;
    ke.push({ id: 'g' + g.min, type: { type: 'goal' }, wallclock: new Date(g.at).toISOString(), clock: { value: g.min * 60, displayValue: `${g.min}'` }, period: { number: 1 },
      text: `Goal! Sporting CP ${hh}, Manchester United ${aa}. ${g.who} (${g.side === 'home' ? 'Sporting CP' : 'Manchester United'}) right footed shot.` });
  }
  if (feed.halftime) ke.push({ id: 'ht', type: { type: 'halftime' }, wallclock: new Date(feed.halftime).toISOString(), clock: { value: 2700, displayValue: "45'+2'" } });
  return { header: { competitions: [{ status: { type: { state: 'in', shortDetail: feed.halftime ? 'HT' : "30'" } }, competitors: [team('2250', 'Sporting CP', 'Sporting CP', 'home', h), team('360', 'Manchester United', 'Man United', 'away', a)] }] }, keyEvents: ke, commentary: [] };
}
async function mockFeeds(ctx) {
  await ctx.route('https://site.api.espn.com/**', async (route) => {
    const u = new URL(route.request().url());
    let body = { events: [] };
    if (u.pathname.endsWith('/summary')) body = summary();
    else if (u.pathname.includes('/uefa.champions/scoreboard')) body = { leagues: [{ name: 'UEFA Champions League' }], events: [scoreboardEvent('777', new Date(T0).toISOString(), 'in', "30'", 1, 0)] };
    else if (u.pathname.includes('/por.1/scoreboard')) body = { leagues: [{ name: 'Liga Portugal' }], events: [{ ...scoreboardEvent('778', '2026-11-29T20:30Z', 'pre', 'Sun 8:30 PM', 0, 0), competitions: [{ status: { type: { state: 'pre' } }, competitors: [team('2250', 'Sporting CP', 'Sporting CP', 'home', 0), team('437', 'FC Porto', 'FC Porto', 'away', 0)] }] }] };
    else if (u.pathname.endsWith('/teams')) body = { sports: [{ leagues: [{ teams: [{ team: { id: '1929', displayName: 'Benfica', logos: [] } }, { team: { id: '437', displayName: 'FC Porto', logos: [] } }] }] }] };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.route('https://api.openf1.org/**', async (route) => {
    const u = new URL(route.request().url());
    let body = [];
    if (u.pathname.endsWith('/sessions')) body = [{ session_key: 11428, session_name: 'Race', location: 'Lusail', meeting_key: 1301, date_start: '2026-11-29T16:00:00+00:00', date_end: '2026-11-29T18:00:00+00:00' }];
    else if (u.pathname.endsWith('/meetings')) body = [{ meeting_key: 1301, meeting_name: 'Qatar Grand Prix', country_flag: '' }];
    else if (u.pathname.endsWith('/drivers')) body = [{ driver_number: 3, full_name: 'Max VERSTAPPEN', first_name: 'Max', last_name: 'Verstappen', team_name: 'Red Bull Racing' }, { driver_number: 1, full_name: 'Lando NORRIS', first_name: 'Lando', last_name: 'Norris', team_name: 'McLaren' }];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

const browser = await chromium.launch();
const apiCalls = [];
async function newPhone(opts = {}) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  await ctx.addInitScript(FAKE_BLE);
  await mockFeeds(ctx);
  await ctx.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData());
    apiCalls.push({ headers: req.headers(), body });
    const data = JSON.parse(body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
    const out = {
      headline: 'Ice-cold until the penalty, then pure nerves',
      writeup: 'Your heart rate peaked at 112 bpm right after the second goal.\n\nTakeaway: breathe out slowly during VAR checks.',
      caption: 'I tracked my heart rate and stress during the match. Peak 112 bpm 🫀 #WHOOP #Pulse',
      moments: data.moments.map((m) => ({ id: m.id, text: `AI · ${m.label}` })),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }),
    });
  });
  return ctx;
}
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()));
};

try {
  /* ---------- 1. Home with fixtures, demos, detail, export ---------- */
  const ctx = await newPhone();
  const page = await ctx.newPage();
  watch(page);
  await page.clock.install({ time: new Date(T0 + 30 * 60000) });
  await page.goto(BASE);
  await page.waitForSelector('.fx');
  check('Meeting + Other match on top, no Workout', (await page.locator('.others.two .otherbtn').count()) === 2 && (await page.locator('[data-start="workout"]').count()) === 0);
  check('games grouped under Sports', (await page.locator('.section-title h3', { hasText: 'Sports' }).count()) === 1);
  check('live match card shown first', (await page.locator('.fxlist').first().innerText()).includes('Sporting CP') && (await page.locator('.livebadge').count()) === 1);
  check('"Your teams & driver" group', (await page.locator('.subhead', { hasText: 'Your teams' }).count()) === 1);
  check('my team highlighted', (await page.locator('.fx-row.mine').first().innerText()).includes('Sporting'));
  check('F1 race listed', (await page.locator('.fx', { hasText: 'Qatar Grand Prix' }).count()) === 1);
  check('upcoming Clássico listed', (await page.locator('.fx', { hasText: 'FC Porto' }).count()) === 1);
  await page.screenshot({ path: 'tests/screens/01-home-phone.png', fullPage: true });

  await page.goto(BASE + '#/settings');
  await page.fill('#sKey', 'sk-ant-test-key');
  await page.fill('#sRest', '58');
  await page.click('#sSave');
  check('no workout demo', (await page.locator('[data-demo="workout"]').count()) === 0);
  for (const k of ['sport', 'f1', 'meeting']) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-demo="${k}"]`);
    await page.waitForSelector('#dHero img');
  }
  await page.goto(BASE + '#/history');
  await page.waitForSelector('.hist li');
  check('history lists 3 demos', (await page.locator('.hist li').count()) === 3);
  check('history comparison shown', (await page.locator('.compare').count()) === 1);
  await page.click('.chip[data-f="meeting"]');
  await page.waitForSelector('.chip.on[data-f="meeting"]');
  check('filter by type', (await page.locator('.hist li').count()) === 1);
  await page.click('.chip[data-f="all"]');
  await page.screenshot({ path: 'tests/screens/02-history-phone.png', fullPage: true });

  // F1 demo detail = the reference look
  await page.locator('.hist li a', { hasText: 'Las Vegas' }).click();
  await page.waitForSelector('#dHero img');
  check('session page shows the shareable chart image (reference layout)', (await page.locator('#dHero img').getAttribute('alt')).startsWith("Max Verstappen's race, Las Vegas Grand Prix"));
  const heroW = await page.evaluate(() => document.querySelector('#dHero img').naturalWidth);
  check(`hero image is the Classic export (${heroW} px)`, heroW === 1520);
  check('no horizontal overflow on phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'tests/screens/03-f1-detail-phone.png', fullPage: true });
  await page.click('#dShare');
  await page.waitForSelector('#shPrev img');
  check('share sheet opens on Classic with a preview', (await page.locator('#shFmt button.on').innerText()).includes('Classic'));
  check('caption pre-written', (await page.inputValue('#shCap')).startsWith('I tracked my heart rate and stress during the Las Vegas Grand Prix'));
  await page.screenshot({ path: 'tests/screens/04a-share-sheet.png' });
  const dims = { classic: [1520, null], post: [1080, 1350], story: [1080, 1920] };
  for (const f of ['classic', 'post', 'story']) {
    await page.click(`#shFmt [data-f="${f}"]`);
    await page.waitForSelector(`#shPrev[data-f="${f}"] img`);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#shSave')]);
    const fp = `tests/screens/04-export-f1-${f}.png`;
    await d.saveAs(fp);
    const b = fs.readFileSync(fp);
    const [ew, eh] = dims[f];
    const gw = b.readUInt32BE(16);
    const gh = b.readUInt32BE(20);
    check(`${f} image size ${gw}×${gh}`, gw === ew && (eh ? gh === eh : gh > 1000));
  }
  await page.click('#shClose');

  // Football demo detail + write-up + export
  await page.goto(BASE + '#/history');
  await page.locator('.hist li a', { hasText: 'Sporting CP 2–1' }).click();
  await page.waitForSelector('#dHero img');
  check('title shows the score', (await page.locator('h1').innerText()).includes('Sporting CP 2–1 FC Porto'));
  await page.click('#wRegen');
  await page.waitForSelector('.writeup p:first-child:has-text("Ice-cold")');
  await page.waitForSelector('#dHero img');
  const aiTags = await page.evaluate(async () => (await window.__pulse.db.allSessions()).find((x) => x.type === 'sport').tags.filter((g) => /^AI · /.test(g.label)).length);
  check(`AI rewrote the chart captions (${aiTags})`, aiTags >= 8);
  check('AI suggested post shown', (await page.locator('.ai-caption').innerText()).includes('I tracked my heart rate'));
  const call = apiCalls.at(-1);
  check('API headers', call.headers['x-api-key'] === 'sk-ant-test-key' && call.headers['anthropic-version'] === '2023-06-01' && call.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  check('API model default', call.body.model === 'claude-sonnet-5-5');
  const sent = JSON.parse(call.body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
  check('API payload: resting HR, score, moment ids, structured output', sent.restingHr === 58 && sent.finalScore === '2-1' && sent.moments.every((m) => typeof m.id === 'string') && call.body.output_config.format.type === 'json_schema');
  await page.screenshot({ path: 'tests/screens/05-football-detail-phone.png', fullPage: true });
  await page.click('#dShare');
  await page.waitForSelector('#shPrev img');
  check('share caption defaults to the AI post', (await page.inputValue('#shCap')).startsWith('I tracked my heart rate and stress during the match. Peak 112 bpm'));
  await page.click('#shFmt [data-f="classic"]');
  await page.waitForSelector('#shPrev[data-f="classic"] img');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#shSave')]);
  await dl.saveAs('tests/screens/06-export-football.png');
  for (const f of ['post', 'story']) {
    await page.click(`#shFmt [data-f="${f}"]`);
    await page.waitForSelector(`#shPrev[data-f="${f}"] img`);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#shSave')]);
    await d.saveAs(`tests/screens/06-export-football-${f}.png`);
  }
  await page.evaluate(() => {
    window.__shared = null;
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = async (d) => { window.__shared = { n: d.files.length, type: d.files[0].type, name: d.files[0].name, text: d.text }; };
  });
  await page.fill('#shCap', 'Clássico nerves 😅 #SportingCP');
  await page.click('#shGo');
  await page.waitForFunction(() => window.__shared);
  const shared = await page.evaluate(() => window.__shared);
  check('Web Share gets the PNG and the edited caption', shared.n === 1 && shared.type === 'image/png' && shared.name.endsWith('-story.png') && shared.text === 'Clássico nerves 😅 #SportingCP');
  await page.click('#shClose');
  await page.waitForTimeout(200);
  check('edited caption saved with the session', (await page.evaluate(async () => (await window.__pulse.db.allSessions()).find((x) => x.type === 'sport').shareCaption)) === 'Clássico nerves 😅 #SportingCP');

  // Delay adjust on a saved session
  const tBefore = await page.evaluate(async () => (await window.__pulse.db.allSessions()).find((x) => x.type === 'sport').tags.find((g) => g.auto).t);
  await page.click('[data-delay="10"]');
  await page.waitForSelector('.delaycard .num:has-text("10 s")');
  const tAfter = await page.evaluate(async () => (await window.__pulse.db.allSessions()).find((x) => x.type === 'sport').tags.find((g) => g.auto).t);
  check('delay +10 s re-times saved moments by 10 s', tAfter - tBefore === 10000);

  /* ---------- 2. Following ---------- */
  await page.goto(BASE + '#/following');
  check('default follows', (await page.locator('.fchip').count()) === 3 && (await page.locator('.fchip').first().innerText()).includes('Sporting CP'));
  check('competitions on', await page.isChecked('[data-comp="uefa.champions"]') && await page.isChecked('[data-comp="eng.1"]') && await page.isChecked('[data-comp="por.1"]'));
  await page.focus('#teamSearch');
  await page.waitForFunction(() => !document.querySelector('#teamResults .spinner'));
  await page.fill('#teamSearch', 'benf');
  await page.click('[data-addteam="1929"]');
  check('team added', (await page.locator('.fchip').count()) === 4);
  await page.waitForFunction(() => document.querySelectorAll('#driverSel option').length > 1);
  check('driver select defaults to Max', (await page.locator('#driverSel').inputValue()) === 'VERSTAPPEN');
  await page.screenshot({ path: 'tests/screens/07-following-phone.png', fullPage: true });

  /* ---------- 3. Watching a live match: auto moments + TV-delay sync ---------- */
  const lctx = await newPhone();
  const lp = await lctx.newPage();
  watch(lp);
  feed.goals = [{ side: 'home', min: 11, at: T0 + 10 * 60000 + 20000, who: 'Luis Suárez' }];
  await lp.clock.install({ time: new Date(T0 + 30 * 60000) }); // join mid-match (30')
  await lp.goto(BASE);
  await lp.evaluate(() => localStorage.setItem('pulse.settings', JSON.stringify({ restingHr: 60, apiKey: 'sk-ant-live', model: 'claude-sonnet-5-5', delaySec: 40 })));
  await lp.reload();
  await lp.waitForSelector('.fx.is-live');
  await lp.click('#strapChip');
  await lp.click('[data-s="pick"]');
  await lp.clock.runFor(3000);
  check('strap connects via chip (heart_rate filter)', JSON.stringify(await lp.evaluate(() => window.__lastRequest)) === JSON.stringify({ filters: [{ services: ['heart_rate'] }] }));
  await lp.click('.fx.is-live [data-watch]');
  await lp.waitForSelector('#wGo');
  check('watch sheet pre-selects my team', (await lp.locator('#wMine button.on').innerText()) === 'Sporting CP');
  await lp.click('#wGo');
  await lp.waitForSelector('#liveBpm');
  await lp.clock.runFor(25000);
  check('score from live data', (await lp.locator('#liveScore').innerText()) === '1–0');
  check('match clock from feed kick-off (31\')', /^3[01]'$/.test(await lp.locator('#liveClock').innerText()));
  const liveLabels = async () => lp.$$eval('#liveMoments li .l', (els) => els.map((e) => e.textContent));
  check('match context shown even though I joined at 30\' (kick-off + 11\' goal)', (await liveLabels()).some((l) => l.startsWith("11' Goal Sporting CP")) && (await liveLabels()).some((l) => l.startsWith('Kick-off')));
  check('no manual reaction buttons, free text or undo', (await lp.locator('[data-react], #freeText, #undoBtn').count()) === 0);
  await lp.clock.runFor(4 * 60000);
  await lp.evaluate(() => (window.__fakeHR.hr = 112));
  feed.goals.push({ side: 'away', min: 35, at: await lp.evaluate(() => Date.now()), who: 'Bruno Fernandes' });
  await lp.clock.runFor(21000); // next poll picks it up; not on TV yet (40 s delay)
  check('new goal not shown before it reaches the stream', !(await liveLabels()).some((l) => l.startsWith("35'")));
  check('"Just saw it" offered', (await lp.locator('#calBtn').count()) === 1);
  await lp.clock.runFor(9000); // the TV shows it ~30 s after the feed
  await lp.click('#calBtn');
  check('delay calibrated to ~30 s', /stream delay 30 s \(synced\)/.test(await lp.locator('#feedLine').innerText()));
  check('goal appears with exact time', (await lp.locator('#liveMoments li .l').first().innerText()).startsWith("35' Goal Man United (1–1)"));
  check('score 1–1', (await lp.locator('#liveScore').innerText()) === '1–1');
  // Stream sync by typing the match clock: stream is 75 s behind → shows (now − 75 s − kick-off)
  const nowMs = await lp.evaluate(() => Date.now());
  const shown = Math.floor((nowMs + 5000 - 75000 - T0) / 1000); // typed 5 s ahead of the stream
  const typed = `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, '0')}`;
  await lp.click('#syncBtn');
  await lp.fill('#syVal', typed);
  await lp.clock.runFor(5000); // ...and tap Sync when the stream reaches it
  await lp.click('#syGo');
  const d = await lp.evaluate(() => window.__pulse.state.live.delayMs);
  check(`typed clock ${typed} → stream delay ≈75 s (${d} ms)`, d >= 75000 && d < 76000 && /stream delay 7[56] s \(synced\)/.test(await lp.locator('#feedLine').innerText()));
  const goal35 = () => lp.evaluate(() => window.__pulse.state.live.tags.find((g) => /^35'/.test(g.label)));
  check('goal hidden again until it reaches the (later) stream', !(await goal35()));
  await lp.clock.runFor(50000);
  check('goal re-appears at feed time + new delay', (await goal35()).t === feed.goals[1].at + d);
  check('sync remembered as default', Math.abs((await lp.evaluate(() => JSON.parse(localStorage.getItem('pulse.settings')).delaySec)) - 75) <= 1);
  await lp.click('#syncBtn');
  await lp.fill('#syVal', '9x');
  await lp.click('#syGo');
  check('bad clock rejected, modal stays', (await lp.locator('#syVal').count()) === 1);
  await lp.click('#syCancel');
  await lp.clock.runFor(60000);
  await lp.evaluate(() => (window.__fakeHR.hr = 84));
  await lp.clock.runFor(10 * 60000);
  feed.halftime = await lp.evaluate(() => Date.now());
  await lp.clock.runFor(60000);
  check('half-time not shown before it reaches the stream', (await lp.locator('#liveClock').innerText()) !== 'HT');
  await lp.clock.runFor(30000);
  check('half-time from live data', (await lp.locator('#liveClock').innerText()) === 'HT');
  await lp.screenshot({ path: 'tests/screens/08-live-linked-phone.png', fullPage: true });
  await lp.click('#syncBtn');
  await lp.fill('#syVal', '47:30');
  await lp.screenshot({ path: 'tests/screens/08b-sync-sheet.png' });
  await lp.click('#syCancel');

  // reload → resume
  await lp.clock.runFor(6000);
  const nBefore = await lp.evaluate(() => window.__pulse.state.live.samples.length);
  await lp.reload();
  await lp.waitForSelector('#modal .sheet h2');
  check('resume prompt after reload', (await lp.locator('#modal h2').innerText()).includes('Resume'));
  await lp.click('[data-r="resume"]');
  await lp.waitForSelector('#liveBpm');
  const nAfter = await lp.evaluate(() => window.__pulse.state.live.samples.length);
  check(`autosave kept samples (${nAfter}/${nBefore})`, nAfter >= nBefore - 6 && nAfter > 900);
  await lp.click('#livePill');
  await lp.clock.runFor(5 * 60000);
  await lp.click('#endBtn');
  check('end needs a second tap', (await lp.locator('#endBtn').innerText()).includes('again'));
  await lp.click('#endBtn');
  await lp.waitForSelector('#eNotes');
  await lp.fill('#eNotes', 'Got nervous after their equaliser.');
  await lp.click('#eSave');
  await lp.waitForSelector('.writeup p:first-child:has-text("Ice-cold")', { timeout: 15000 });
  check('saved: title with live score', (await lp.locator('h1').innerText()).includes('Sporting CP 1–1 Man United'));
  await lp.waitForSelector('#dHero img');
  check('saved: chart story mentions kick-off', (await lp.locator('#dHero img').getAttribute('alt')).includes('kick-off'));
  const saved = await lp.evaluate(async () => (await window.__pulse.db.allSessions())[0].tags.map((g) => g.label));
  check(`saved: whole match story (${saved.length} moments)`, saved.length >= 4 && saved.every((l) => /^AI · /.test(l)));
  check('live autosave cleared after save', !(await lp.evaluate(() => window.__pulse.db.getLive())));
  await lp.screenshot({ path: 'tests/screens/09-saved-linked.png', fullPage: true });

  /* ---------- 4. Manual meeting with toggle ---------- */
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
  check('speaking band drawn', (await lp.locator('#liveChart svg').innerHTML()).includes('SPEAKING'));
  await lp.click('#endBtn');
  await lp.click('#endBtn');
  await lp.click('#eDiscard');
  await lp.click('#eDiscard');
  await lp.waitForSelector('.otherbtn');

  /* ---------- 5. Desktop widths ---------- */
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await dctx.addInitScript(FAKE_BLE);
  await mockFeeds(dctx);
  const dp = await dctx.newPage();
  watch(dp);
  await dp.goto(BASE + '#/settings');
  await dp.click('[data-demo="f1"]');
  await dp.waitForSelector('#dHero img');
  const dw = await dp.evaluate(() => document.querySelector('#dHero img').getBoundingClientRect().width);
  check(`desktop chart width (${dw})`, dw > 650);
  await dp.screenshot({ path: 'tests/screens/10-detail-desktop.png', fullPage: true });
  await dp.setViewportSize({ width: 360, height: 800 });
  await dp.waitForTimeout(400);
  const rw = await dp.evaluate(() => document.querySelector('#dHero img').getBoundingClientRect().width);
  check(`chart fits a 360 px phone (${rw})`, rw <= 330 && rw > 300);
  check('no overflow at 360', await dp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await dp.screenshot({ path: 'tests/screens/11-detail-360.png', fullPage: true });

  /* ---------- 6. iPhone Safari ---------- */
  const ictx = await browser.newContext({ ...devices['iPhone 14'] });
  await mockFeeds(ictx);
  const ip = await ictx.newPage();
  await ip.goto(BASE);
  await ip.waitForSelector('.brand');
  check('iOS banner explains no Web Bluetooth', (await ip.locator('.banner.warn').innerText()).includes('iPhone'));

  /* ---------- 7. PWA basics ---------- */
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
