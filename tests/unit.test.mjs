import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate, SampleAggregator } from '../js/hr.js';
import {
  rmssd, tensionSeries, matchMinute, minuteToTime, sessionStats, recomputeGoals,
  bucketHr, findGaps, numberedMoments, displayTitle,
} from '../js/analysis.js';
import { staggerMarkers, chartSvg, monotonePath } from '../js/chart.js';
import { buildRequest, generateWriteup, cleanText, API_URL } from '../js/ai.js';
import { demoSport, demoMeeting, demoWorkout } from '../js/demo.js';

/* ---------- Heart-rate parser ---------- */
test('8-bit HR, no RR', () => {
  const r = parseHeartRate([0x00, 72]);
  assert.equal(r.hr, 72);
  assert.deepEqual(r.rr, []);
  assert.equal(r.energy, null);
  assert.equal(r.contact, null);
});
test('16-bit HR', () => {
  const r = parseHeartRate([0x01, 0x2c, 0x01]); // 300
  assert.equal(r.hr, 300);
});
test('8-bit HR with contact + RR intervals', () => {
  // flags: RR present (0x10) + contact supported (0x04) + detected (0x02)
  const r = parseHeartRate([0x16, 75, 0x00, 0x04, 0x33, 0x03]); // 1024 → 1000 ms, 819 → 800 ms
  assert.equal(r.hr, 75);
  assert.equal(r.contact, true);
  assert.deepEqual(r.rr, [1000, 800]);
});
test('16-bit HR with energy expended and RR', () => {
  // flags 0x19 = uint16 + energy + RR
  const r = parseHeartRate([0x19, 0x8c, 0x00, 0x10, 0x27, 0x00, 0x02]); // hr 140, energy 10000, rr 512 → 500 ms
  assert.equal(r.hr, 140);
  assert.equal(r.energy, 10000);
  assert.deepEqual(r.rr, [500]);
});
test('8-bit HR with energy but no RR', () => {
  const r = parseHeartRate([0x08, 90, 0x05, 0x00]);
  assert.equal(r.hr, 90);
  assert.equal(r.energy, 5);
  assert.deepEqual(r.rr, []);
});
test('accepts DataView input and ignores a dangling odd RR byte', () => {
  const buf = new Uint8Array([0x10, 60, 0x00, 0x04, 0x01]).buffer;
  const r = parseHeartRate(new DataView(buf));
  assert.deepEqual(r.rr, [1000]);
});
test('too-short packet throws', () => {
  assert.throws(() => parseHeartRate([0x00]));
});
test('aggregator keeps one sample per second and merges RR', () => {
  const out = [];
  const agg = new SampleAggregator((s, isNew) => (isNew ? out.push(s) : (out[out.length - 1] = s)));
  agg.push({ hr: 70, rr: [850] }, 10_000);
  agg.push({ hr: 72, rr: [830] }, 10_600);
  agg.push({ hr: 74, rr: [] }, 11_100);
  assert.equal(out.length, 2);
  assert.equal(out[0].hr, 71);
  assert.deepEqual(out[0].rr, [850, 830]);
  assert.equal(out[1].t, 11_000);
});

/* ---------- Tension ---------- */
test('rmssd basic and artefact rejection', () => {
  const rr = [];
  for (let i = 0; i < 30; i++) rr.push(i % 2 ? 820 : 780);
  assert.ok(Math.abs(rmssd(rr) - 40) < 0.01);
  assert.equal(rmssd([800, 810]), null); // too few
  const withSpike = [...rr.slice(0, 15), 1600, ...rr.slice(15)];
  assert.ok(Math.abs(rmssd(withSpike) - 40) < 0.01);
});
test('tension formula: HR part only when no RR', () => {
  const start = 0;
  const samples = [];
  for (let s = 0; s < 120; s++) samples.push({ t: s * 1000, hr: 90 });
  const ses = { type: 'meeting', startTs: start, endTs: 120000, samples, tags: [], bands: [] };
  const { series } = tensionSeries(ses, 60);
  const v = series.find((p) => p.t === 60000).value;
  assert.equal(v, 2); // (90-60)/15
});
test('tension: HRV part = 1.5*log2(base/cur)+1, averaged with HR part', () => {
  const samples = [];
  // first 5 min: RMSSD 40 (baseline), HR 60
  for (let s = 0; s < 300; s++) samples.push({ t: s * 1000, hr: 60, rr: [s % 2 ? 1020 : 980] });
  // next 2 min: RMSSD 20, HR 75
  for (let s = 300; s < 420; s++) samples.push({ t: s * 1000, hr: 75, rr: [s % 2 ? 810 : 790] });
  const ses = { type: 'workout', startTs: 0, endTs: 420000, samples, tags: [], bands: [] };
  const { series, baseline } = tensionSeries(ses, 60);
  assert.ok(Math.abs(baseline - 40) < 0.01);
  const p = series.find((x) => x.t === 420000);
  assert.equal(p.hrPart, 1); // (75-60)/15
  assert.ok(Math.abs(p.hrvPart - 2.5) < 0.01); // 1.5*log2(2)+1
  assert.ok(Math.abs(p.value - 1.75) < 0.01);
});

/* ---------- Match clock ---------- */
test('match minute labels', () => {
  const KO = 1_000_000;
  const s = { type: 'sport', startTs: KO - 600000, phases: { kickoff: KO, halftime: KO + 47 * 60000, secondhalf: KO + 62 * 60000, fulltime: KO + 112 * 60000 } };
  assert.equal(matchMinute(s, KO - 1), 'Pre');
  assert.equal(matchMinute(s, KO + 10), "1'");
  assert.equal(matchMinute(s, KO + 22 * 60000 + 5), "23'");
  assert.equal(matchMinute(s, KO + 45 * 60000 + 5), "45+1'");
  assert.equal(matchMinute(s, KO + 50 * 60000), 'HT');
  assert.equal(matchMinute(s, KO + 62 * 60000 + 1000), "46'");
  assert.equal(matchMinute(s, KO + 62 * 60000 + 44 * 60000 + 1), "90'");
  assert.equal(matchMinute(s, KO + 62 * 60000 + 47 * 60000 + 1), "90+3'");
  assert.equal(matchMinute(s, KO + 113 * 60000), 'FT');
});
test('minuteToTime round-trips with matchMinute', () => {
  const KO = 5_000_000;
  const s = { type: 'sport', startTs: KO - 600000, phases: { kickoff: KO, halftime: KO + 47 * 60000, secondhalf: KO + 62 * 60000, fulltime: KO + 113 * 60000 } };
  for (const m of ['1', '23', '45', '45+2', '46', '67', '90', '90+3']) {
    assert.equal(matchMinute(s, minuteToTime(s, m)), `${m}'`);
  }
  assert.equal(minuteToTime(s, 'abc'), null);
  const e = { type: 'meeting', startTs: 0 };
  assert.equal(minuteToTime(e, '12'), 12 * 60000);
});

/* ---------- Goals / score ---------- */
test('goal labels show running score; undo recomputes', () => {
  const s = { type: 'sport', teams: { home: 'Benfica', away: 'Porto', mine: 'home' }, score: { home: 0, away: 0 }, tags: [
    { id: 'a', t: 1, team: 'home' }, { id: 'b', t: 2, team: 'away' }, { id: 'c', t: 3, team: 'home' } ] };
  recomputeGoals(s);
  assert.deepEqual(s.tags.map((g) => g.label), ['Goal Benfica (1–0)', 'Goal Porto (1–1)', 'Goal Benfica (2–1)']);
  assert.equal(s.tags[0].color, '#2ed47a');
  assert.equal(s.tags[1].color, '#ff4d5e');
  assert.equal(displayTitle(s), 'Benfica 2–1 Porto');
  s.tags = s.tags.filter((g) => g.id !== 'b');
  recomputeGoals(s);
  assert.equal(s.tags[1].label, 'Goal Benfica (2–0)');
});

/* ---------- Buckets, gaps, stats ---------- */
test('10 s buckets and gaps', () => {
  const samples = [];
  for (let s = 0; s < 60; s++) samples.push({ t: s * 1000, hr: 60 + s });
  for (let s = 120; s < 180; s++) samples.push({ t: s * 1000, hr: 80 });
  const b = bucketHr(samples, 0, 180000, 10000);
  assert.equal(b.length, 18);
  assert.equal(b[0].avg, 64.5);
  assert.equal(b[7].avg, null);
  const gaps = findGaps(samples, 0, 180000);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].start, 59000);
  assert.equal(gaps[0].end, 120000);
});
test('demo sessions produce sensible stats', () => {
  for (const d of [demoSport(60), demoMeeting(60), demoWorkout(60)]) {
    const st = sessionStats(d, 60);
    assert.ok(st.avgHr > 60 && st.avgHr < 140, `${d.type} avg ${st.avgHr}`);
    assert.ok(st.peakHr > st.avgHr);
    assert.ok(st.avgTension > 0 && st.avgTension < 3);
    assert.ok(numberedMoments(d).length >= 5);
  }
  const sport = demoSport(60);
  assert.equal(displayTitle(sport), 'Benfica 2–1 Porto');
  assert.ok(findGaps(sport.samples, sport.startTs, sport.endTs).length === 1, 'sport demo has one signal gap');
  const st = sessionStats(sport, 60);
  assert.ok(st.peakContext, 'peak has context');
});

/* ---------- Chart ---------- */
test('markers stagger into max 3 rows', () => {
  assert.deepEqual(staggerMarkers([0, 5, 10, 100, 104], 9, 3), [0, 1, 2, 0, 1]);
  const rows = staggerMarkers([0, 1, 2, 3, 4], 9, 3);
  assert.ok(rows.every((r) => r >= 0 && r < 3));
});
test('monotone path never overshoots', () => {
  const pts = [[0, 100], [10, 0], [20, 0], [30, 100]];
  const cmds = monotonePath(pts);
  for (const c of cmds.filter((c) => c[0] === 'C')) {
    for (const y of [c[2], c[4], c[6]]) assert.ok(y >= -0.001 && y <= 100.001);
  }
});
test('chart SVG renders at 360 px and desktop widths', () => {
  const s = demoSport(60);
  for (const w of [360, 1200]) {
    const svg = chartSvg(s, w, w < 500 ? 280 : 380, { restingHr: 60 });
    assert.match(svg, new RegExp(`width="${w}"`));
    assert.ok((svg.match(/<circle/g) || []).length === numberedMoments(s).length);
    assert.ok(svg.includes('stroke-dasharray'));
    assert.ok(svg.includes('Half-time'));
    assert.ok(!svg.includes('NaN'));
  }
});

/* ---------- AI request (mocked) ---------- */
test('buildRequest has required headers and data', () => {
  const s = demoMeeting(60);
  const req = buildRequest(s, { apiKey: ' sk-ant-test ', model: 'claude-sonnet-5-5', restingHr: 60 });
  assert.equal(req.url, API_URL);
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.equal(req.body.temperature, undefined);
  const data = JSON.parse(req.body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
  assert.equal(data.sessionType, 'Meeting');
  assert.ok(data.series30s.length > 80);
  assert.ok(data.series30s.some((p) => p.tension != null));
  assert.ok(data.moments.length === 5);
  assert.ok(data.bands.length === 5);
  assert.ok(data.myNotes.length > 10);
  assert.equal(data.restingHr, 60);
});
test('generateWriteup parses a mocked response and strips markdown', async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '**Nerves of steel at the death**\n\n- Your HR peaked at 128.' }],
    }), { status: 200 });
  };
  const w = await generateWriteup(demoSport(60), { apiKey: 'sk-ant-x', model: 'claude-sonnet-5-5', restingHr: 60 }, fakeFetch);
  assert.equal(captured.url, API_URL);
  assert.equal(captured.init.method, 'POST');
  assert.equal(w.text, 'Nerves of steel at the death\n\nYour HR peaked at 128.');
});
test('generateWriteup error handling', async () => {
  const s = demoWorkout(60);
  const st = { apiKey: 'sk-ant-bad', model: 'claude-sonnet-5-5', restingHr: 60 };
  await assert.rejects(generateWriteup(s, { ...st, apiKey: '' }), (e) => e.kind === 'nokey');
  await assert.rejects(generateWriteup(s, st, async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })), (e) => e.kind === 'auth');
  await assert.rejects(generateWriteup(s, st, async () => { throw new TypeError('Failed to fetch'); }), (e) => e.kind === 'network');
  await assert.rejects(generateWriteup(s, st, async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })), (e) => e.kind === 'refusal');
  // retries without fallbacks if the option is rejected
  let calls = 0;
  const w = await generateWriteup(s, st, async (u, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.fallbacks) return new Response(JSON.stringify({ error: { message: 'fallbacks: unknown beta' } }), { status: 400 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
  });
  assert.equal(calls, 2);
  assert.equal(w.text, 'ok');
});
test('cleanText', () => {
  assert.equal(cleanText('# Head\n* one\n__two__'), 'Head\none\ntwo');
});
