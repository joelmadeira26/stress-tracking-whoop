import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate, SampleAggregator } from '../js/hr.js';
import {
  rmssd, tensionSeries, matchMinute, minuteToTime, sessionStats, recomputeGoals,
  bucketHr, findGaps, numberedMoments, displayTitle,
} from '../js/analysis.js';
import { staggerMarkers, chartSvg, monotonePath } from '../js/chart.js';
import { buildRequest, generateWriteup, cleanText, API_URL } from '../js/ai.js';
import { demoSport, demoMeeting, demoF1 } from '../js/demo.js';
import { parseEspnSummary, parseOpenF1, normalizeEspnEvent } from '../js/feeds.js';
import { applyFeed, categoryLabels, legendCategories } from '../js/analysis.js';
import fs from 'node:fs';
const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

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
  for (const d of [demoSport(60), demoMeeting(60), demoF1(60)]) {
    const st = sessionStats(d, 60);
    assert.ok(st.avgHr > 60 && st.avgHr < 140, `${d.type} avg ${st.avgHr}`);
    assert.ok(st.peakHr > st.avgHr);
    assert.ok(st.avgTension > 0 && st.avgTension < 3);
    assert.ok(numberedMoments(d).length >= 5);
  }
  const sport = demoSport(60);
  assert.equal(displayTitle(sport), 'Sporting CP 2–1 FC Porto');
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
    assert.equal((svg.match(/<circle/g) || []).length, numberedMoments(s).length);
    assert.ok(svg.includes('stroke-dasharray'));
    assert.ok(svg.includes('linearGradient'), 'stress line uses green→yellow gradient');
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
  assert.ok(data.series30s.some((p) => p.stress != null));
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
  const s = demoMeeting(60);
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

/* ---------- Live feeds (real recorded data) ---------- */
test('ESPN summary: Liverpool 4–0 Man Utd parsed into moments with real times', () => {
  const r = parseEspnSummary(fixture('espn-liv-mun.json'), { mine: 'away' });
  assert.deepEqual(r.score, { home: 4, away: 0 });
  assert.equal(r.status.state, 'post');
  assert.ok(r.phases.kickoff && r.phases.halftime && r.phases.secondhalf && r.phases.fulltime);
  const goals = r.moments.filter((m) => /Goal/.test(m.label));
  assert.equal(goals.length, 4);
  assert.ok(goals.every((g) => g.cat === 'goalTheirs' && g.side === 'home'));
  assert.equal(goals[0].label, "10' Goal Liverpool (1–0): Dominik Szoboszlai");
  assert.equal(goals[3].label.slice(0, 26), "82' Goal Liverpool (4–0): ");
  const red = r.moments.find((m) => m.cat === 'card');
  assert.match(red.label, /^8' Red card: Leny Yoro \(Manchester United\)/);
  assert.ok(r.moments.every((m) => Number.isFinite(m.ft)));
  assert.equal(r.moments.at(-1).cat, 'finish');
  // no favourite → home/away colours
  const n = parseEspnSummary(fixture('espn-liv-mun.json'));
  assert.ok(n.moments.filter((m) => /Goal/.test(m.label)).every((g) => g.cat === 'goalHome'));
});

test('ESPN goal side detection from running score (incl. own goals)', () => {
  const d = {
    header: { competitions: [{ status: { type: { state: 'in' } }, competitors: [
      { homeAway: 'home', score: '2', team: { id: '1', displayName: 'Sporting CP', shortDisplayName: 'Sporting CP' } },
      { homeAway: 'away', score: '1', team: { id: '2', displayName: 'Manchester United', shortDisplayName: 'Man United' } }] }] },
    keyEvents: [
      { id: 'a', type: { type: 'kickoff' }, wallclock: '2026-11-25T20:00:00Z', period: { number: 1 }, clock: { value: 0 } },
      { id: 'b', type: { type: 'goal' }, wallclock: '2026-11-25T20:10:00Z', clock: { value: 600, displayValue: "11'" }, text: 'Goal! Sporting CP 1, Manchester United 0. Luis Suárez (Sporting CP) right footed shot.' },
      { id: 'c', type: { type: 'own-goal' }, wallclock: '2026-11-25T20:30:00Z', clock: { value: 1800, displayValue: "31'" }, text: 'Own Goal by Ousmane Diomande, Sporting CP. Sporting CP 1, Manchester United 1.' },
      { id: 'd', type: { type: 'penalty---scored' }, clock: { value: 2400, displayValue: "41'" }, period: { number: 1 }, text: 'Goal! Sporting CP 2, Manchester United 1. Luis Suárez (Sporting CP) converts the penalty.' },
    ],
    commentary: [{ sequence: 9, time: { value: 2000, displayValue: "34'" }, text: 'VAR Decision: No Penalty Sporting CP.', play: { wallclock: '2026-11-25T20:34:00Z' } }],
  };
  const r = parseEspnSummary(d, { mine: 'home' });
  const labels = r.moments.filter((m) => !['ko', 'ht', 'sh'].includes(m.fid)).map((m) => `${m.cat}|${m.label}`);
  assert.deepEqual(labels, [
    "goalMine|11' Goal Sporting CP (1–0): Luis Suárez",
    "goalTheirs|31' Goal Man United (1–1): Ousmane Diomande (own goal)",
    "key|34' VAR: No Penalty Sporting CP",
    "goalMine|41' Goal Sporting CP (2–1): Luis Suárez (pen)",
  ]);
  const pen = r.moments.find((m) => /pen/.test(m.label));
  assert.equal(pen.est, true, 'no wallclock → estimated from kick-off + clock');
  assert.equal(pen.ft, Date.parse('2026-11-25T20:00:00Z') + 2400 * 1000);
});

test('OpenF1: Las Vegas GP 2026 story for Max', () => {
  const r = parseOpenF1(fixture('f1-lasvegas-2026.json'), 'VERSTAPPEN');
  assert.equal(r.myDriver.name, 'Max');
  assert.equal(r.myDriver.won, true);
  const labels = r.moments.map((m) => m.label);
  assert.equal(labels[0], 'Lights out. Max starts P1');
  assert.ok(labels.includes('Lap 2: Russell briefly takes the lead; Max retakes it'));
  assert.ok(labels.some((l) => /^Lap 19: Safety car; Max pits \(2\.\d s stop\)$/.test(l)));
  assert.equal(labels.at(-1), 'Max wins by 0.639s over Norris');
  assert.equal(r.bands.length, 1);
  assert.equal(r.bands[0].label, 'SAFETY CAR');
  assert.ok(!labels.some((l) => /Red flag/.test(l)), '"CHEQUERED FLAG" must not be read as a red flag');
  assert.ok(r.moments.filter((m) => m.cat === 'lead').length <= 10, 'lead changes are grouped');
});

test('applyFeed: TV delay shifts moments, hides future ones, clips to session', () => {
  const t0 = Date.parse('2026-11-25T20:00:00Z');
  const s = { type: 'sport', startTs: t0 + 5 * 60000, endTs: null, samples: [], tags: [{ id: 'm', t: t0 + 20 * 60000, label: 'So nervous', cat: 'reaction', color: '#d946ef' }], bands: [],
    teams: { home: 'Sporting CP', away: 'Man United', mine: 'home' }, delayMs: 40000,
    feed: { score: { home: 1, away: 0 }, phases: { kickoff: t0 }, bands: [], moments: [
      { fid: 'early', ft: t0 + 60000, cat: 'key', label: 'before you started' },
      { fid: 'g', ft: t0 + 10 * 60000, cat: 'goalMine', label: "11' Goal" },
      { fid: 'late', ft: t0 + 29 * 60000 + 30000, cat: 'card', label: 'not on TV yet' },
    ] } };
  applyFeed(s, t0 + 30 * 60000);
  const auto = s.tags.filter((g) => g.auto);
  assert.deepEqual(auto.map((g) => g.label), ['before you started', "11' Goal"], 'whole-match context, even before you joined');
  assert.equal(auto[1].t, t0 + 10 * 60000 + 40000);
  assert.equal(auto[1].est, true, 'uncalibrated delay → "~"');
  assert.equal(auto[1].catLabel, 'Goal Sporting CP');
  assert.equal(s.phases.kickoff, t0 + 40000);
  assert.equal(s.tags.filter((g) => !g.auto).length, 1, 'manual reactions kept');
  assert.deepEqual(s.score, { home: 1, away: 0 });
  applyFeed(s, t0 + 31 * 60000);
  assert.equal(s.tags.filter((g) => g.auto).length, 3, 'card appears once it would be on your stream');
});

test('F1 demo legend categories match the reference', () => {
  const s = demoF1(60);
  assert.deepEqual(legendCategories(s).map((c) => c.label), ['Your reaction', 'Key moment', 'Max loses and retakes the lead', 'Safety car', 'Max wins']);
  assert.equal(categoryLabels(s).finish, 'Max wins');
  const svg = chartSvg(s, 360, 300, { restingHr: 60 });
  assert.ok(svg.includes('SAFETY CAR'));
});

test('normalizeEspnEvent', () => {
  const e = normalizeEspnEvent({ id: 1, date: '2026-11-25T20:00Z', league: { slug: 'uefa.champions' }, competitions: [{ status: { type: { state: 'pre', shortDetail: '8:00 PM' } }, competitors: [
    { homeAway: 'home', team: { id: 2250, displayName: 'Sporting CP', logos: [{ href: 'x.png' }] } }, { homeAway: 'away', team: { id: 360, displayName: 'Manchester United' } }] }] });
  assert.equal(e.competition, 'Champions League');
  assert.equal(e.home.logo, 'x.png');
  assert.equal(e.away.id, '360');
});

/* ---------- Stream sync ---------- */
import { parseMatchClock, calibrationRealTime, resolveCalibration } from '../js/analysis.js';

test('parseMatchClock handles stream clock formats', () => {
  assert.deepEqual(parseMatchClock('67:23'), { sec: 4043, period: 2, exact: true });
  assert.deepEqual(parseMatchClock('12:05'), { sec: 725, period: 1, exact: true });
  assert.deepEqual(parseMatchClock('45+2:10'), { sec: 2830, period: 1, exact: true });
  assert.deepEqual(parseMatchClock('90+3:05'), { sec: 5585, period: 2, exact: true });
  assert.equal(parseMatchClock("67'").sec, 4050);
  assert.equal(parseMatchClock('12.30').sec, 750);
  assert.equal(parseMatchClock('abc'), null);
  assert.equal(parseMatchClock('5:70'), null);
});

test('football stream sync: typed clock → delay', () => {
  const KO = Date.parse('2026-11-25T20:00:00Z');
  const SH = KO + 62 * 60000;
  const feed = { phases: { kickoff: KO, secondhalf: SH }, moments: [], bands: [] };
  // stream showed 12:00 at KO + 12 min + 55 s → 55 s behind
  const s = { feed, calib: { kind: 'clock', sec: 720, period: 1, at: KO + 12 * 60000 + 55000 } };
  assert.equal(resolveCalibration(s), 55000);
  assert.equal(s.delayCalibrated, true);
  // second half: 67:30 shown at SH + 22:30 + 72 s
  s.calib = { kind: 'clock', sec: 4050, period: 2, at: SH + (4050 - 2700) * 1000 + 72000 };
  assert.equal(resolveCalibration(s), 72000);
  // second half unknown yet → pending
  const p = { feed: { phases: { kickoff: KO } }, calib: { kind: 'clock', sec: 4050, period: 2, at: SH } };
  assert.equal(resolveCalibration(p), null);
  assert.equal(p.calib.pending, true);
});

test('F1 stream sync by lap on real Las Vegas lap times, pending until data arrives', () => {
  const f = parseOpenF1(fixture('f1-lasvegas-2026.json'), 'VERSTAPPEN');
  assert.ok(f.lapStarts[23] > f.lapStarts[22]);
  const s = { startTs: f.lightsOut - 10 * 60000, samples: [], tags: [], bands: [], delayMs: 60000,
    calib: { kind: 'lap', lap: 23, at: f.lapStarts[23] + 48000 } };
  s.feed = { moments: [], bands: [], phases: {} }; // live data not published yet
  applyFeed(s, s.calib.at);
  assert.equal(s.calib.pending, true);
  assert.equal(s.delayMs, 60000);
  s.feed = f; // published after the race
  applyFeed(s, f.lapStarts[50]);
  assert.equal(s.calib.pending, false);
  assert.equal(s.delayMs, 48000);
  assert.equal(calibrationRealTime({ kind: 'lap', lap: 1 }, f), f.lightsOut);
  const lead = s.tags.find((g) => /^Lap 2:/.test(g.label));
  assert.ok(lead && lead.t === f.moments.find((m) => /^Lap 2:/.test(m.label)).ft + 48000);
});

/* ---------- v4: automatic match story, sync accuracy, AI analysis ---------- */
import { pickNewer } from '../js/feeds.js';
import { chartDomain, detectReactions } from '../js/analysis.js';
import { parseAnalysis } from '../js/ai.js';

test('Galatasaray 1–0 Aston Villa: phases, big chances, added time in the right half', () => {
  const r = parseEspnSummary(fixture('espn-gal-avl.json'), { mine: 'home' });
  const by = (re) => r.moments.find((m) => re.test(m.label));
  assert.ok(by(/^Kick-off: Galatasaray v Aston Villa$/));
  assert.ok(by(/^Half-time: Galatasaray 0–0 Aston Villa$/));
  assert.ok(by(/^Second half under way$/));
  const chance = by(/^27' Big chance: Taylor Harwood-Bellis \(Aston Villa\) header from close range missed$/);
  assert.ok(chance && chance.cat === 'chance' && chance.detail.startsWith('Attempt missed'));
  const goal = by(/^77' Goal Galatasaray \(1–0\): Deniz Gül$/);
  assert.equal(goal.cat, 'goalMine');
  const added = by(/\+5 min added time$/);
  assert.ok(added.ft > goal.ft, 'added-time message without a period is placed in the second half');
  assert.ok(r.context.length > 10 && r.context.some((c) => /Corner/.test(c)), 'raw lines kept for the AI');
  const times = r.moments.map((m) => m.ft);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('fixtures: a fresh "FT" beats a stale cached "LIVE 79\'" (Bodø/Glimt v LASK bug)', () => {
  const now = Date.now();
  const stale = { key: 'espn:1', state: 'in', detail: "79'", home: { score: '0' }, away: { score: '0' }, at: now - 20 * 60000 };
  const fresh = { key: 'espn:1', state: 'post', detail: 'FT', home: { score: '1' }, away: { score: '0' }, at: now };
  assert.equal(pickNewer(stale, fresh).detail, 'FT');
  assert.equal(pickNewer(fresh, stale).detail, 'FT');
  // same fetch moment: further along wins
  assert.equal(pickNewer({ ...stale, at: now }, { ...fresh, at: now }).state, 'post');
  // a fresh live score beats an older cached pre-match entry
  assert.equal(pickNewer({ key: 'k', state: 'pre', at: now - 600000 }, { key: 'k', state: 'in', at: now }).state, 'in');
});

test('chart range covers the match even if you joined at 87\'', () => {
  const t0 = Date.parse('2026-11-24T17:45:00Z');
  const s = { type: 'sport', startTs: t0 + 100 * 60000, endTs: t0 + 101 * 60000, samples: [], tags: [{ t: t0, auto: true }, { t: t0 + 77 * 60000, auto: true }], bands: [] };
  const d = chartDomain(s);
  assert.ok(d.start <= t0 - 60000 && d.end >= s.endTs);
  const far = { ...s, tags: [{ t: s.startTs - 5 * 3600 * 1000, auto: true }] };
  assert.ok(chartDomain(far).start >= far.startTs - 3 * 3600 * 1000, 'capped at 3 h before you started');
});

test('heart-rate reactions: unexplained spikes become "Your reaction" moments', () => {
  const t0 = Date.parse('2026-11-24T18:00:00Z');
  const samples = [];
  for (let i = 0; i < 40 * 60; i++) {
    let hr = 72;
    if (i >= 600 && i < 720) hr = 72 + Math.min(30, (i - 600) / 2); // spike at 10 min, no event
    if (i >= 1800 && i < 1920) hr = 72 + Math.min(30, (i - 1800) / 2); // spike at 30 min, right after a goal
    samples.push({ t: t0 + i * 1000, hr });
  }
  const s = { type: 'sport', startTs: t0, endTs: t0 + 40 * 60000, samples, tags: [{ t: t0 + 1795 * 1000, auto: true, cat: 'goalMine' }], bands: [] };
  const r = detectReactions(s, 60);
  assert.equal(r.length, 1, 'the spike explained by the goal is not repeated');
  assert.ok(Math.abs(r[0].t - (t0 + 600 * 1000)) < 90 * 1000);
  assert.match(r[0].label, /Your heart rate jumps to 10\d bpm/);
});

test('AI analysis JSON maps captions back to moments and reactions', () => {
  const a = parseAnalysis(JSON.stringify({
    headline: '**Pure nerves**', writeup: 'Para one.\n\nTakeaway: breathe.', caption: 'I tracked my heart rate… #WHOOP',
    moments: [{ id: 'f:ko', text: "Kick-off. Your heart rate already 84" }, { id: 'r:p123', text: 'Corner to Villa. Heart rate jumps' }, { id: 'zzz', text: 'ignored' }],
  }), 'claude-sonnet-5-5');
  assert.equal(a.text, 'Pure nerves\n\nPara one.\n\nTakeaway: breathe.');
  assert.deepEqual(a.ai.moments, { ko: 'Kick-off. Your heart rate already 84' });
  assert.deepEqual(a.ai.reactions, { p123: 'Corner to Villa. Heart rate jumps' });
  assert.equal(a.ai.caption, 'I tracked my heart rate… #WHOOP');
  const plain = parseAnalysis('Just text', 'm');
  assert.equal(plain.ai, null);
  assert.equal(plain.text, 'Just text');
});

test('AI request asks for structured JSON with every moment id', () => {
  const s = demoSport(60);
  const req = buildRequest(s, { apiKey: 'sk-ant-x', model: 'claude-sonnet-5-5', restingHr: 60 });
  assert.equal(req.body.output_config.format.type, 'json_schema');
  const data = JSON.parse(req.body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
  const ids = data.moments.map((m) => m.id);
  assert.ok(ids.every((id) => typeof id === 'string'));
  assert.ok(data.moments.some((m) => m.source === 'live data') && data.moments.some((m) => m.source === 'you'));
  assert.ok(data.moments.some((m) => m.maxHrNext2min > 0));
});

test('applyFeed uses AI captions when present', () => {
  const s = demoF1(60);
  const fid = s.feed.moments[1].fid;
  s.ai = { moments: { [fid]: 'Lap 2: Russell passes Max; Max retakes it around the outside' }, reactions: {} };
  applyFeed(s, Date.now());
  assert.ok(s.tags.some((g) => g.label === 'Lap 2: Russell passes Max; Max retakes it around the outside' && g.baseLabel));
});
