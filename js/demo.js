// Realistic demo sessions (no strap needed).
import { SESSION_TYPES } from './config.js';
import { applyFeed } from './analysis.js';
import { CATEGORIES } from './config.js';
import { uid } from './db.js';

const SEC = 1000;
const MIN = 60 * SEC;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
}

/** Rise over ~15 s, then exponential recovery with time constant tau (s). */
function impulse(dt, amp, tau = 90) {
  if (dt < 0) return 0;
  return amp * (1 - Math.exp(-dt / 6)) * Math.exp(-Math.max(0, dt - 20) / tau);
}

/**
 * hrAt(sec) → target heart rate. Produces 1 Hz samples with AR(1) noise and RR intervals
 * whose variability shrinks as HR rises above resting (like real HRV under stress).
 */
function generate(startTs, durS, hrAt, { seed = 1, rest = 60, gaps = [] } = {}) {
  const r = rng(seed);
  const samples = [];
  let noise = 0;
  let rrPhase = 0;
  for (let s = 0; s < durS; s++) {
    if (gaps.some(([a, b]) => s >= a && s < b)) continue;
    noise = 0.85 * noise + gauss(r) * 0.9;
    const hr = Math.round(Math.max(45, hrAt(s) + noise));
    const mean = 60000 / hr;
    const stress = Math.max(0, Math.min(1.6, (hr - rest - 8) / 22));
    const target = 48 * Math.pow(2, -stress * 1.25);
    const sd = target / Math.SQRT2;
    const rr = [];
    rrPhase += hr / 60;
    while (rrPhase >= 1) {
      rrPhase -= 1;
      rr.push(Math.round(mean + gauss(r) * sd));
    }
    const sample = { t: startTs + s * SEC, hr };
    if (rr.length) sample.rr = rr;
    samples.push(sample);
  }
  return samples;
}

function daysAgoAt(days, h, m) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function baseSession(type, title, startTs, extra = {}) {
  return {
    id: uid(),
    type,
    title,
    mode: SESSION_TYPES[type].defaultMode,
    startTs,
    endTs: null,
    restingHr: 60,
    samples: [],
    tags: [],
    bands: [],
    notes: '',
    writeup: null,
    demo: true,
    ...extra,
  };
}

/* ---------------- Football: Sporting CP 2–1 FC Porto (auto moments) ---------------- */
export function demoSport(rest = 60) {
  const start = daysAgoAt(2, 20, 20);
  const KO = 10 * 60; // seconds after start
  const HT = KO + 47 * 60;
  const SH = HT + 15 * 60;
  const FT = SH + 50 * 60;
  const END = FT + 6 * 60;
  const m1 = (min) => KO + (min - 1) * 60 + 25;
  const m2 = (min) => SH + (min - 46) * 60 + 25;
  const at = (s) => start + s * SEC;

  const feedMoments = [
    { s: m1(12), amp: 10, cat: 'key', label: "12' Off the bar: Francisco Trincão (Sporting CP)" },
    { s: m1(23), amp: 30, cat: 'goalMine', label: "23' Goal Sporting CP (1–0): Luis Suárez" },
    { s: m1(31), amp: 14, cat: 'key', label: "31' VAR: Goal Sporting CP disallowed for offside" },
    { s: m1(38), amp: 24, cat: 'goalTheirs', label: "38' Goal FC Porto (1–1): Samu Aghehowa", tau: 160 },
    { s: m2(55), amp: 18, cat: 'card', label: "55' Red card: Alan Varela (FC Porto)" },
    { s: m2(76), amp: 20, cat: 'key', label: "76' VAR: Penalty Sporting CP" },
    { s: m2(78), amp: 28, cat: 'goalMine', label: "78' Goal Sporting CP (2–1): Luis Suárez (pen)", tau: 120 },
    { s: m2(90) + 3 * 60, amp: 18, cat: 'key', label: "90+3' VAR: No penalty FC Porto" },
  ];
  const reactions = [
    { s: m2(86), amp: 10, label: "86' So nervous" },
  ];

  const hrAt = (s) => {
    let base;
    if (s < KO) base = 70 + (s / KO) * 6;
    else if (s < HT) base = 80 + Math.sin(s / 300) * 2;
    else if (s < SH) base = 80 - Math.min(1, (s - HT) / 300) * 7;
    else if (s < FT) base = 81 + ((s - SH) / (FT - SH)) * 9 + Math.sin(s / 250) * 2;
    else base = 88 - Math.min(1, (s - FT) / 240) * 14;
    let v = base;
    for (const e of [...feedMoments, ...reactions]) v += impulse(s - e.s, e.amp, e.tau || 90);
    if (s >= FT) v += impulse(s - FT, 10, 60);
    return v;
  };

  const session = baseSession('sport', 'Sporting CP v FC Porto', start, {
    teams: { home: 'Sporting CP', away: 'FC Porto', mine: 'home' },
    score: { home: 2, away: 1 },
    restingHr: rest,
    event: {
      source: 'espn',
      id: 'demo',
      league: 'por.1',
      competition: 'Liga Portugal',
      home: { name: 'Sporting CP', short: 'Sporting CP', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/2250.png' },
      away: { name: 'FC Porto', short: 'FC Porto', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/437.png' },
      mine: 'home',
    },
    delayMs: 0,
    delayCalibrated: true,
  });
  session.samples = generate(start, END, hrAt, { seed: 7, rest, gaps: [[m2(66), m2(66) + 75]] });
  session.feed = {
    status: { state: 'post', detail: 'FT', completed: true },
    score: { home: 2, away: 1 },
    phases: { kickoff: at(KO), halftime: at(HT), secondhalf: at(SH), fulltime: at(FT) },
    moments: [
      ...feedMoments.map((e, i) => ({ fid: 'd' + i, ft: at(e.s), est: false, cat: e.cat, label: e.label })),
      { fid: 'ft', ft: at(FT), est: false, cat: 'finish', label: 'Full time: Sporting CP 2–1 FC Porto' },
    ],
    bands: [],
  };
  session.tags = reactions.map((r) => ({ id: uid(), t: at(r.s), key: 'reaction', cat: 'reaction', label: r.label, color: CATEGORIES.reaction.color, catLabel: 'Your reaction' }));
  session.endTs = at(END);
  applyFeed(session);
  session.notes =
    'Clássico nerves. Went ahead early, Porto equalised before the break. Their red card changed it and the late penalty was pure nerves. The VAR check in stoppage time nearly killed me.';
  return session;
}

/* ---------------- F1: Las Vegas Grand Prix (auto moments) ---------------- */
export function demoF1(rest = 60) {
  const start = daysAgoAt(3, 20, 45);
  const LO = 17 * 60; // lights out 17 min after you start watching
  const lap = 104; // seconds per lap
  const L = (n) => LO + (n - 1) * lap;
  const FIN = L(51);
  const END = FIN + 13 * 60;
  const at = (s) => start + s * SEC;
  const mom = [
    { s: LO, amp: 26, cat: 'key', label: 'Lights out. Max starts P1' },
    { s: L(2), amp: 18, cat: 'lead', label: 'Lap 2: Russell briefly takes the lead; Max retakes it' },
    { s: L(8), amp: 12, cat: 'lead', label: 'Lap 8: Hadjar briefly takes the lead; Max retakes it' },
    { s: L(10), amp: 16, cat: 'lead', label: 'Laps 10 to 18: lead swaps back and forth between Max and Russell' },
    { s: L(19), amp: 14, cat: 'sc', label: 'Lap 19: Safety car; Max pits (2.4 s stop)' },
    { s: L(26), amp: 22, cat: 'lead', label: 'Lap 26: Russell passes Max; Max retakes the lead within the lap' },
    { s: L(34), amp: 14, cat: 'lead', label: 'Lap 34: Norris briefly takes the lead; Max retakes it' },
    { s: L(37), amp: 16, cat: 'lead', label: 'Laps 37 to 47: lead swaps back and forth between Max and Antonelli' },
    { s: FIN, amp: 24, cat: 'finish', label: 'Max wins by 0.639s over Norris', tau: 70 },
  ];
  const reactions = [{ s: LO - 2 * 60, amp: 12, label: 'Formation lap. Nerves kicking in' }];
  const scStart = L(19);
  const scEnd = L(25);
  const hrAt = (s) => {
    let v = 76 + Math.min(1, s / LO) * 6;
    if (s > LO) v += 4 + Math.sin(s / 200) * 2;
    if (s > scStart && s < scEnd) v -= 7 * Math.min(1, (s - scStart) / 120) * Math.min(1, (scEnd - s) / 90);
    if (s > L(40) && s < FIN) v += 5;
    if (s > FIN) v -= Math.min(14, (s - FIN) / 30);
    for (const e of [...mom, ...reactions]) v += impulse(s - e.s, e.amp, e.tau || 100);
    return v;
  };
  const session = baseSession('f1', 'Las Vegas Grand Prix', start, {
    restingHr: rest,
    event: { source: 'openf1', id: 'demo', sessionKey: null, meetingName: 'Las Vegas Grand Prix', sessionName: 'Race', competition: 'Formula 1', driver: { name: 'Max Verstappen', last: 'VERSTAPPEN' } },
    delayMs: 0,
    delayCalibrated: true,
  });
  session.samples = generate(start, END, hrAt, { seed: 31, rest });
  session.feed = {
    status: { state: 'post', detail: 'Finished', completed: true },
    phases: {},
    moments: mom.map((e, i) => ({ fid: 'f' + i, ft: at(e.s), est: false, cat: e.cat, label: e.label })),
    bands: [{ fid: 'sc1', start: at(scStart), end: at(scEnd), label: 'SAFETY CAR', cat: 'sc' }],
    myDriver: { name: 'Max', full: 'Max Verstappen', number: 3, won: true, leadInvolved: true },
    result: { position: 1 },
  };
  session.tags = reactions.map((r) => ({ id: uid(), t: at(r.s), key: 'reaction', cat: 'reaction', label: r.label, color: CATEGORIES.reaction.color, catLabel: 'Your reaction' }));
  session.endTs = at(END);
  applyFeed(session);
  session.notes = 'Couldn’t sit still for the last 10 laps with Antonelli all over him. Safety car was a breather.';
  return session;
}

/* ---------------- Meeting: interview ---------------- */
export function demoMeeting(rest = 60) {
  const start = daysAgoAt(1, 10, 0);
  const DUR = 46 * 60;
  const speaking = [
    [90, 330],
    [540, 900],
    [1080, 1270],
    [1540, 1880],
    [2220, 2460],
  ];
  const events = [
    { s: 560, amp: 10, key: 'pitch' },
    { s: 1100, amp: 8, key: 'awkward' },
    { s: 1530, amp: 16, key: 'tough', tau: 150 },
    { s: 1900, amp: -4, key: 'well' },
    { s: 2400, amp: 9, key: 'decision' },
  ];
  const hrAt = (s) => {
    let v = 72 + (s < 120 ? (s / 120) * 6 : 6) - Math.min(4, s / 900);
    for (const [a, b] of speaking) if (s >= a && s < b) v += 7 * Math.min(1, (s - a) / 40) * Math.min(1, (b - s) / 25 + 0.2);
    for (const e of events) v += impulse(s - e.s, e.amp, e.tau || 100);
    return v;
  };
  const session = baseSession('meeting', 'Interview with Zinc', start, { restingHr: rest });
  session.samples = generate(start, DUR, hrAt, { seed: 11, rest });
  const cfg = SESSION_TYPES.meeting;
  session.bands = speaking.map(([a, b]) => ({
    key: cfg.toggle.key,
    label: cfg.toggle.label,
    color: cfg.toggle.color,
    start: start + a * SEC,
    end: start + b * SEC,
  }));
  session.tags = events.map((e) => {
    const def = cfg.tags.find((t) => t.key === e.key);
    return { id: uid(), t: start + e.s * SEC, key: e.key, label: def.label, color: def.color };
  });
  session.endTs = start + DUR * SEC;
  session.notes =
    'Second-round interview. The salary question caught me off guard, but the case study went really well. They said they would decide by Friday.';
  return session;
}

/* ---------------- Workout: leg day ---------------- */
export function demoWorkout(rest = 60) {
  const start = daysAgoAt(0, 7, 15);
  const sets = [];
  const events = [];
  let s = 6 * 60;
  events.push({ s: 30, key: 'exercise', label: 'Warm-up bike' });
  events.push({ s: s - 5, key: 'exercise', label: 'Back squat' });
  for (let i = 0; i < 4; i++) {
    sets.push([s, s + 55, 40 + i * 4]);
    if (i === 3) events.push({ s: s + 40, key: 'pb', label: 'Personal best' });
    s += 55 + 150;
  }
  events.push({ s: s - 10, key: 'exercise', label: 'Walking lunges' });
  for (let i = 0; i < 3; i++) {
    sets.push([s, s + 70, 38 + i * 3]);
    if (i === 2) events.push({ s: s + 50, key: 'hard', label: 'Felt hard' });
    s += 70 + 120;
  }
  events.push({ s: s - 10, key: 'exercise', label: 'Bike intervals' });
  for (let i = 0; i < 6; i++) {
    sets.push([s, s + 30, 55 + i * 3]);
    s += 30 + 60;
  }
  events.push({ s: s + 20, key: 'rest', label: 'Rest' });
  s += 4 * 60;
  events.push({ s, key: 'cooldown', label: 'Cool-down' });
  const DUR = s + 8 * 60;

  const hrAt = (t) => {
    let v = 68 + Math.min(1, t / 300) * 32; // warm-up to ~100
    if (t > DUR - 8 * 60) v -= Math.min(1, (t - (DUR - 8 * 60)) / 300) * 22;
    for (const [a, b, amp] of sets) {
      if (t >= a && t < b) v += amp * (1 - Math.exp(-(t - a) / 18));
      else if (t >= b) v += amp * (1 - Math.exp(-(b - a) / 18)) * Math.exp(-(t - b) / 55);
    }
    return v;
  };
  const session = baseSession('workout', 'Leg day', start, { restingHr: rest });
  session.samples = generate(start, DUR, hrAt, { seed: 23, rest });
  const cfg = SESSION_TYPES.workout;
  session.bands = sets.map(([a, b]) => ({
    key: cfg.toggle.key,
    label: cfg.toggle.label,
    color: cfg.toggle.color,
    start: start + a * SEC,
    end: start + b * SEC,
  }));
  session.tags = events.map((e) => {
    const def = cfg.tags.find((t) => t.key === e.key);
    return { id: uid(), t: start + e.s * SEC, key: e.key, label: e.label || def.label, color: def.color };
  });
  session.endTs = start + DUR * SEC;
  session.notes = 'Squats felt strong, hit a new 5-rep best on the last set. Lunges were brutal. Bike intervals at the end were all-out.';
  return session;
}

export const DEMOS = { sport: demoSport, f1: demoF1, meeting: demoMeeting, workout: demoWorkout };
