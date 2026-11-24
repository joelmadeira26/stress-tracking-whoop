// Pure data functions: bucketing, tension estimate, match clock, stats.
import { CALM_MARGIN, SESSION_TYPES, CATEGORIES } from './config.js';

const SEC = 1000;
const MIN = 60 * SEC;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function sessionStart(s) {
  return s.startTs;
}
export function sessionEnd(s) {
  const last = s.samples.length ? s.samples[s.samples.length - 1].t : s.startTs;
  return Math.max(s.endTs || 0, last, s.startTs + MIN);
}

/* ---------------- Match clock ---------------- */

export function matchPhase(session, t) {
  const p = session.phases || {};
  if (!p.kickoff || t < p.kickoff) return 'pre';
  if (p.fulltime && t >= p.fulltime) return 'ft';
  if (p.secondhalf && t >= p.secondhalf) return 'second';
  if (p.halftime && t >= p.halftime) return 'ht';
  return 'first';
}

/** Match minute label: 1'–45', 45+x', HT, 46'–90', 90+x', FT, or 'Pre'. */
export function matchMinute(session, t) {
  const p = session.phases || {};
  const phase = matchPhase(session, t);
  if (phase === 'pre') return 'Pre';
  if (phase === 'ht') return 'HT';
  if (phase === 'ft') return 'FT';
  if (phase === 'first') {
    const m = Math.floor((t - p.kickoff) / MIN) + 1;
    return m <= 45 ? `${m}'` : `45+${m - 45}'`;
  }
  const m = 45 + Math.floor((t - p.secondhalf) / MIN) + 1;
  return m <= 90 ? `${m}'` : `90+${m - 90}'`;
}

/** Convert "67", "45+2", "90+3" (sport) or elapsed minutes (others) into a timestamp. */
export function minuteToTime(session, input) {
  const str = String(input).trim().replace(/['’]/g, '');
  const m = str.match(/^(\d{1,3})(?:\s*\+\s*(\d{1,2}))?$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const extra = m[2] ? parseInt(m[2], 10) : 0;
  const type = SESSION_TYPES[session.type];
  if (type && type.clock === 'match') {
    const p = session.phases || {};
    const ko = p.kickoff || session.startTs;
    if (base <= 45 && !(base === 90 && extra)) {
      return ko + (base + extra - 1) * MIN + 30 * SEC;
    }
    const sh = p.secondhalf || ko + 60 * MIN;
    return sh + (base + extra - 46) * MIN + 30 * SEC;
  }
  return session.startTs + (base + extra) * MIN;
}

export function elapsedLabel(ms) {
  const total = Math.max(0, Math.floor(ms / SEC));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function clockTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Label used for a moment in legends: match minute for sport, clock time otherwise. */
export function momentTimeLabel(session, t, tag) {
  if (session.feed) return (tag && tag.est ? '~' : '') + clockTime(t);
  const type = SESSION_TYPES[session.type];
  if (type && type.clock === 'match') {
    const mm = matchMinute(session, t);
    return mm === 'Pre' ? clockTime(t) : mm;
  }
  return clockTime(t);
}

/* ---------------- Heart rate buckets ---------------- */

/** Average HR in fixed buckets. Returns [{t (bucket centre), avg, max, n}] with avg=null for empty buckets. */
export function bucketHr(samples, start, end, sizeMs) {
  const n = Math.max(1, Math.ceil((end - start) / sizeMs));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { t: start + i * sizeMs + sizeMs / 2, sum: 0, n: 0, max: null };
  for (const s of samples) {
    const i = Math.floor((s.t - start) / sizeMs);
    if (i < 0 || i >= n) continue;
    const b = out[i];
    b.sum += s.hr;
    b.n += 1;
    b.max = b.max == null ? s.hr : Math.max(b.max, s.hr);
  }
  return out.map((b) => ({ t: b.t, avg: b.n ? b.sum / b.n : null, max: b.max, n: b.n }));
}

/** Gaps where no samples arrived for more than `minGap` ms (strap disconnected). */
export function findGaps(samples, start, end, minGap = 15 * SEC) {
  const gaps = [];
  let prev = start;
  for (const s of samples) {
    if (s.t - prev > minGap) gaps.push({ start: prev, end: s.t });
    prev = s.t;
  }
  if (end - prev > minGap && samples.length) gaps.push({ start: prev, end });
  return gaps;
}

/* ---------------- HRV / tension ---------------- */

function cleanRR(list) {
  return list.filter((v) => v >= 300 && v <= 2000);
}

/** RMSSD (ms) of RR intervals; rejects successive differences > 20 % (ectopic / artefact). */
export function rmssd(rrList) {
  const rr = cleanRR(rrList);
  let sum = 0;
  let n = 0;
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1];
    if (Math.abs(d) > 0.2 * rr[i - 1]) continue;
    sum += d * d;
    n++;
  }
  return n >= 10 ? Math.sqrt(sum / n) : null;
}

function rrBetween(samples, a, b) {
  const out = [];
  for (const s of samples) {
    if (s.t < a) continue;
    if (s.t >= b) break;
    if (s.rr) for (const v of s.rr) out.push(v);
  }
  return out;
}

/** Baseline RMSSD: pre-kick-off window (sport, if ≥2 min) else the first 5 minutes. */
export function baselineRmssd(session) {
  const start = session.startTs;
  const ko = session.phases && session.phases.kickoff;
  let a = start;
  let b = start + 5 * MIN;
  if (ko && ko - start >= 2 * MIN) b = ko;
  return rmssd(rrBetween(session.samples, a, b));
}

/**
 * Tension 0–3 every 30 s (value describes the 60 s ending at t).
 *   HR part  = (avg HR over 60 s − resting) / 15, clamped 0–3
 *   HRV part = 1.5 × log2(baseline RMSSD / current RMSSD) + 1, clamped 0–3 (only with RR data)
 *   tension  = average of available parts
 */
export function tensionSeries(session, restingHr, { stepMs = 30 * SEC, windowMs = 60 * SEC } = {}) {
  const samples = session.samples;
  const start = session.startTs;
  const end = sessionEnd(session);
  const base = baselineRmssd(session);
  const out = [];
  let lo = 0;
  let hi = 0;
  for (let t = start + stepMs; t <= end + stepMs - 1; t += stepMs) {
    const a = t - windowMs;
    while (lo < samples.length && samples[lo].t < a) lo++;
    if (hi < lo) hi = lo;
    while (hi < samples.length && samples[hi].t < t) hi++;
    let sum = 0;
    let n = 0;
    const rr = [];
    for (let i = lo; i < hi; i++) {
      sum += samples[i].hr;
      n++;
      if (samples[i].rr) for (const v of samples[i].rr) rr.push(v);
    }
    if (n < 10) {
      out.push({ t, value: null, hrPart: null, hrvPart: null });
      continue;
    }
    const avg = sum / n;
    const hrPart = clamp((avg - restingHr) / 15, 0, 3);
    let hrvPart = null;
    if (base) {
      const cur = rmssd(rr);
      if (cur) hrvPart = clamp(1.5 * Math.log2(base / cur) + 1, 0, 3);
    }
    const value = hrvPart == null ? hrPart : (hrPart + hrvPart) / 2;
    out.push({ t, value, hrPart, hrvPart, hr: avg });
  }
  return { series: out, baseline: base };
}

/* ---------------- Bands & stats ---------------- */

/** All shaded bands: toggle bands + half-time for sport. Open bands run to `now`. */
export function allBands(session, now) {
  const bands = (session.bands || []).map((b) => ({ ...b, end: b.end || now || sessionEnd(session) }));
  const p = session.phases || {};
  if (p.halftime) {
    bands.push({
      key: 'halftime',
      label: 'Half-time',
      color: '#8a97b3',
      start: p.halftime,
      end: p.secondhalf || now || sessionEnd(session),
    });
  }
  return bands.sort((a, b) => a.start - b.start);
}

/** Vertical phase lines (kick-off, second half, full time). */
export function phaseLines(session) {
  const p = session.phases || {};
  const lines = [];
  if (p.kickoff) lines.push({ t: p.kickoff, label: 'KO' });
  if (p.fulltime) lines.push({ t: p.fulltime, label: 'FT' });
  return lines;
}

export function describeMoment(session, t) {
  const tags = (session.tags || []).filter((g) => g.t <= t + 60 * SEC && g.t >= t - 5 * MIN);
  if (tags.length) {
    const g = tags.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best));
    return `${g.label} (${momentTimeLabel(session, g.t)})`;
  }
  const band = allBands(session).find((b) => t >= b.start && t <= b.end);
  if (band) return band.label;
  return null;
}

export function sessionStats(session, restingHr) {
  const samples = session.samples;
  const start = session.startTs;
  const end = sessionEnd(session);
  const stats = {
    durationMs: end - start,
    avgHr: null,
    peakHr: null,
    peakT: null,
    peakContext: null,
    minHr: null,
    calmCeiling: restingHr + CALM_MARGIN,
    aboveCalmMs: 0,
    avgTension: null,
    peakTension: null,
    peakTensionT: null,
  };
  if (!samples.length) return stats;
  let sum = 0;
  for (const s of samples) sum += s.hr;
  stats.avgHr = Math.round(sum / samples.length);
  // Peak = highest 10-second average (robust to single-beat artefacts), reported at its max sample.
  const b10 = bucketHr(samples, start, end, 10 * SEC);
  let best = null;
  for (const b of b10) if (b.avg != null && (!best || b.avg > best.avg)) best = b;
  stats.peakHr = best ? best.max : null;
  stats.peakT = best ? best.t : null;
  stats.minHr = Math.round(Math.min(...b10.filter((b) => b.avg != null).map((b) => b.avg)));
  stats.peakContext = best ? describeMoment(session, best.t) : null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const next = samples[i + 1];
    const dt = next ? Math.min(next.t - s.t, 5 * SEC) : SEC;
    if (s.hr > stats.calmCeiling) stats.aboveCalmMs += dt;
  }
  const ten = tensionSeries(session, restingHr).series.filter((x) => x.value != null);
  if (ten.length) {
    stats.avgTension = ten.reduce((a, x) => a + x.value, 0) / ten.length;
    const pk = ten.reduce((a, x) => (x.value > a.value ? x : a));
    stats.peakTension = pk.value;
    stats.peakTensionT = pk.t;
  }
  return stats;
}

/** Title for display / export: "Benfica 2–1 Porto" for sport, otherwise the session title. */
export function displayTitle(session) {
  if (session.event && session.event.source === 'openf1') {
    return `${session.event.meetingName}${session.event.sessionName === 'Sprint' ? ' Sprint' : ''}`;
  }
  if (session.teams && session.teams.home && session.teams.away) {
    const sc = session.score || { home: 0, away: 0 };
    return `${session.teams.home} ${sc.home}–${sc.away} ${session.teams.away}`;
  }
  return session.title || SESSION_TYPES[session.type]?.label || 'Session';
}

/** Recompute score and goal labels from tags (used after undo / adding forgotten goals). */
export function recomputeGoals(session) {
  if (!session.teams || session.feed) return;
  const score = { home: 0, away: 0 };
  const tags = [...session.tags].sort((a, b) => a.t - b.t);
  for (const g of tags) {
    if (g.team === 'home' || g.team === 'away') {
      score[g.team] += 1;
      g.label = `Goal ${session.teams[g.team]} (${score.home}–${score.away})`;
      g.color = goalColor(session, g.team);
    }
  }
  session.score = score;
}

export function goalColor(session, team) {
  if (!session.teams || !session.teams.mine) return team === 'home' ? '#2ed47a' : '#ff4d5e';
  return session.teams.mine === team ? '#2ed47a' : '#ff4d5e';
}

/** Numbered moment list, sorted by time. */
export function numberedMoments(session) {
  return [...(session.tags || [])]
    .sort((a, b) => a.t - b.t)
    .map((g, i) => ({ ...g, n: i + 1, timeLabel: momentTimeLabel(session, g.t, g) }));
}

/* ---------------- Recovery after big moments (for the AI) ---------------- */

/** For each tag: HR just before, peak within 3 min after, and seconds to return halfway to pre-level. */
export function recoveryAfterTags(session) {
  const samples = session.samples;
  const res = [];
  for (const g of numberedMoments(session)) {
    const before = samples.filter((s) => s.t >= g.t - 60 * SEC && s.t < g.t);
    const after = samples.filter((s) => s.t >= g.t && s.t <= g.t + 3 * MIN);
    if (before.length < 5 || after.length < 5) continue;
    const pre = before.reduce((a, s) => a + s.hr, 0) / before.length;
    let peak = after[0];
    for (const s of after) if (s.hr > peak.hr) peak = s;
    const rise = peak.hr - pre;
    let halfBackS = null;
    if (rise >= 5) {
      const target = pre + rise / 2;
      const later = samples.filter((s) => s.t > peak.t && s.t <= peak.t + 10 * MIN);
      const hit = later.find((s) => s.hr <= target);
      if (hit) halfBackS = Math.round((hit.t - peak.t) / SEC);
    }
    res.push({
      n: g.n,
      label: g.label,
      time: g.timeLabel,
      hrBefore: Math.round(pre),
      peakAfter: peak.hr,
      rise: Math.round(rise),
      secondsToRecoverHalf: halfBackS,
    });
  }
  return res;
}

/* ---------------- Live event feed → session ---------------- */

/** Category labels for this session ("Goal Sporting CP", "Max wins", …). */
export function categoryLabels(session) {
  const L = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label]));
  const tm = session.teams;
  if (tm) {
    L.goalHome = `Goal ${tm.home}`;
    L.goalAway = `Goal ${tm.away}`;
    if (tm.mine) {
      L.goalMine = `Goal ${tm[tm.mine]}`;
      L.goalTheirs = `Goal ${tm[tm.mine === 'home' ? 'away' : 'home']}`;
    }
    L.finish = 'Full time';
  }
  const me = session.feed && session.feed.myDriver;
  if (me) {
    if (me.leadInvolved) L.lead = `${me.name} loses and retakes the lead`;
    L.pit = `${me.name} pits`;
    L.finish = me.won ? `${me.name} wins` : 'Result';
  }
  return L;
}

/**
 * Rebuild auto moments / bands / phases / score from session.feed.
 * Feed times are real-world; the TV shows them `delayMs` later.
 * Moments are shown only once they'd be on your screen, and only inside the session window.
 */
export function applyFeed(session, now = Date.now()) {
  const f = session.feed;
  if (!f) return session;
  const d = session.delayMs ?? 40000;
  const startT = session.startTs;
  const endT = session.endTs || now;
  const labels = categoryLabels(session);
  const manual = (session.tags || []).filter((g) => !g.auto);
  const auto = (f.moments || [])
    .filter((m) => m.ft + d >= startT && m.ft + d <= endT)
    .map((m) => ({
      id: 'f:' + m.fid,
      t: m.ft + d,
      auto: true,
      est: !!m.est || !session.delayCalibrated,
      cat: m.cat,
      label: m.label,
      color: (CATEGORIES[m.cat] || CATEGORIES.key).color,
      catLabel: labels[m.cat] || m.cat,
    }));
  for (const g of manual) if (g.cat) g.catLabel = labels[g.cat] || g.catLabel;
  session.tags = [...manual, ...auto];
  session.bands = [
    ...(session.bands || []).filter((b) => !b.auto),
    ...(f.bands || [])
      .filter((b) => b.end + d >= startT && b.start + d <= endT)
      .map((b) => ({
        key: b.cat,
        label: b.label,
        color: (CATEGORIES[b.cat] || CATEGORIES.key).color,
        start: Math.max(b.start + d, startT),
        end: Math.min(b.end + d, endT),
        auto: true,
      })),
  ];
  const ph = f.phases || {};
  session.phases = {};
  for (const k of Object.keys(ph)) if (ph[k] + d <= endT) session.phases[k] = ph[k] + d;
  if (f.score) session.score = { ...f.score };
  return session;
}

/** Unique legend categories in order of appearance: [{label, color}] */
export function legendCategories(session) {
  const seen = new Map();
  for (const m of numberedMoments(session)) {
    const label = m.catLabel || m.label;
    if (!seen.has(label)) seen.set(label, m.color);
  }
  const out = [...seen].map(([label, color]) => ({ label, color }));
  for (const b of allBands(session)) {
    if (b.key === 'sc' && !out.some((o) => o.label === 'Safety car')) out.push({ label: 'Safety car', color: b.color });
  }
  return out;
}
