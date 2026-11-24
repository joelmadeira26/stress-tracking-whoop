// Realistic demo sessions (no strap needed).
import { SESSION_TYPES } from './config.js';
import { recomputeGoals, goalColor } from './analysis.js';
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

/* ---------------- Football: Benfica 2–1 Porto ---------------- */
export function demoSport(rest = 60) {
  const start = daysAgoAt(2, 19, 50);
  const KO = 10 * 60; // seconds after start
  const HT = KO + 47 * 60;
  const SH = HT + 15 * 60;
  const FT = SH + 50 * 60;
  const END = FT + 6 * 60;
  const m1 = (min) => KO + (min - 1) * 60 + 25; // first-half minute -> sec
  const m2 = (min) => SH + (min - 46) * 60 + 25; // second-half minute -> sec

  const events = [
    { s: m1(12), amp: 12, key: 'chance', label: 'Big chance' },
    { s: m1(23), amp: 30, key: 'goal_home', team: 'home' },
    { s: m1(31), amp: 14, key: 'var', label: 'VAR check' },
    { s: m1(38), amp: 24, key: 'goal_away', team: 'away', tau: 160 },
    { s: m2(55), amp: 20, key: 'redcard', label: 'Red card' },
    { s: m2(64), amp: 8, key: 'free', label: 'Keeper save' },
    { s: m2(77), amp: 22, key: 'penalty', label: 'Penalty' },
    { s: m2(78), amp: 26, key: 'goal_home', team: 'home', tau: 120 },
    { s: m2(90) + 3 * 60, amp: 18, key: 'var', label: 'VAR check' },
  ];

  const hrAt = (s) => {
    let base;
    if (s < KO) base = 70 + (s / KO) * 6;
    else if (s < HT) base = 80 + Math.sin(s / 300) * 2;
    else if (s < SH) base = 80 - Math.min(1, (s - HT) / 300) * 7;
    else if (s < FT) base = 81 + ((s - SH) / (FT - SH)) * 9 + Math.sin(s / 250) * 2;
    else base = 88 - Math.min(1, (s - FT) / 240) * 14;
    let v = base;
    for (const e of events) v += impulse(s - e.s, e.amp, e.tau || 90);
    if (s >= FT) v += impulse(s - FT, 10, 60);
    return v;
  };

  const session = baseSession('sport', 'Benfica v Porto', start, {
    teams: { home: 'Benfica', away: 'Porto', mine: 'home' },
    score: { home: 0, away: 0 },
    restingHr: rest,
  });
  session.samples = generate(start, END, hrAt, { seed: 7, rest, gaps: [[m2(66), m2(66) + 75]] });
  session.phases = {
    kickoff: start + KO * SEC,
    halftime: start + HT * SEC,
    secondhalf: start + SH * SEC,
    fulltime: start + FT * SEC,
  };
  const cfg = SESSION_TYPES.sport;
  session.tags = events.map((e) => {
    const def = cfg.tags.find((t) => t.key === e.key);
    return {
      id: uid(),
      t: start + e.s * SEC,
      key: e.key,
      team: e.team,
      label: e.label || (def && def.label) || 'Note',
      color: e.team ? goalColor(session, e.team) : (def && def.color) || '#e2e8f0',
    };
  });
  recomputeGoals(session);
  session.endTs = start + END * SEC;
  session.notes =
    'Tense one. Went ahead early, Porto equalised before the break and it felt like it was slipping. Their red card changed it, and the late penalty was pure nerves. The VAR check in stoppage time nearly killed me.';
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

export const DEMOS = { sport: demoSport, meeting: demoMeeting, workout: demoWorkout };
