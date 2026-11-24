// Pure data functions: bucketing, tension estimate, match clock, stats.
import { CALM_MARGIN, SESSION_TYPES, CATEGORIES, typeOf } from './config.js';

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
  const type = typeOf(session.type);
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
  const type = typeOf(session.type);
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
  return session.title || typeOf(session.type).label || 'Session';
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
  if (session.calib) resolveCalibration(session);
  const d = session.delayMs ?? 40000;
  // Show the whole event around your session — even moments from before you joined — but
  // only what has already reached your stream (feed time + delay <= now).
  const lower = session.startTs - LOOKBACK_MS;
  const upper = now;
  const labels = categoryLabels(session);
  const ai = session.ai || {};
  const aiMoments = ai.moments || {};
  const aiReactions = ai.reactions || {};
  const manual = (session.tags || []).filter((g) => !g.auto);
  const auto = (f.moments || [])
    .filter((m) => m.ft + d >= lower && m.ft + d <= upper)
    .map((m) => ({
      id: 'f:' + m.fid,
      fid: m.fid,
      t: m.ft + d,
      auto: true,
      est: !!m.est || !session.delayCalibrated,
      cat: m.cat,
      label: aiMoments[m.fid] || m.label,
      baseLabel: m.label,
      color: (CATEGORIES[m.cat] || CATEGORIES.key).color,
      catLabel: labels[m.cat] || m.cat,
    }));
  const reactions = (session.reactions || []).map((r) => ({
    id: 'r:' + r.key,
    rkey: r.key,
    t: r.t,
    auto: true,
    est: false,
    cat: 'reaction',
    label: aiReactions[r.key] || r.label,
    baseLabel: r.label,
    color: CATEGORIES.reaction.color,
    catLabel: labels.reaction,
  }));
  for (const g of manual) if (g.cat) g.catLabel = labels[g.cat] || g.catLabel;
  session.tags = [...manual, ...auto, ...reactions];
  session.bands = [
    ...(session.bands || []).filter((b) => !b.auto),
    ...(f.bands || [])
      .filter((b) => b.end + d >= lower && b.start + d <= upper)
      .map((b) => ({
        key: b.cat,
        label: b.label,
        color: (CATEGORIES[b.cat] || CATEGORIES.key).color,
        start: Math.max(b.start + d, lower),
        end: Math.min(b.end + d, upper),
        auto: true,
      })),
  ];
  const ph = f.phases || {};
  session.phases = {};
  for (const k of Object.keys(ph)) if (ph[k] + d <= upper) session.phases[k] = ph[k] + d;
  if (f.score) session.score = { ...f.score };
  return session;
}

export const LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * Time range the chart shows: your session, widened to include the event's moments
 * (so joining at 87' still shows kick-off, chances and goals), capped at 3 h before you started.
 */
export function chartDomain(session, now) {
  let start = session.startTs;
  let end = now || sessionEnd(session);
  for (const g of session.tags || []) {
    if (g.t < start - 90000) start = g.t - 90000;
    if (!now && g.t > end - 60000) end = g.t + 90000;
  }
  for (const b of session.bands || []) {
    if (b.start < start) start = b.start - 60000;
    if (!now && b.end > end) end = b.end + 60000;
  }
  start = Math.max(start, session.startTs - LOOKBACK_MS);
  if (end - start < 5 * 60000) end = start + 5 * 60000;
  return { start, end };
}

/**
 * Find heart-rate spikes that no feed event explains — your own reactions.
 * Returns up to 3: { key, t (start of the rise), bpm, rise, label }.
 */
export function detectReactions(session, restingHr) {
  const samples = session.samples || [];
  if (samples.length < 120) return [];
  const start = session.startTs;
  const end = sessionEnd(session);
  const b = bucketHr(samples, start, end, 30000);
  const cands = [];
  for (let i = 4; i < b.length; i++) {
    const v = b[i].avg;
    if (v == null) continue;
    const prev = b.slice(Math.max(0, i - 6), i).map((x) => x.avg).filter((x) => x != null);
    if (prev.length < 3) continue;
    const base = Math.min(...prev);
    const rise = v - base;
    if (rise < 10 || v < restingHr + 12) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(b.length - 1, i + 3); j++) if (b[j].avg != null && b[j].avg > v) isMax = false;
    if (!isMax) continue;
    let k = i;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      if (b[j].avg != null && b[j].avg >= base + rise * 0.3) k = j;
      else break;
    }
    cands.push({ t: b[k].t - 15000, peakT: b[i].t, bpm: b[i].max || Math.round(v), rise });
  }
  const feedTimes = (session.tags || []).filter((g) => g.auto && g.cat !== 'reaction').map((g) => g.t);
  const picked = [];
  for (const c of cands.sort((x, y) => y.rise - x.rise)) {
    if (picked.some((p) => Math.abs(p.t - c.t) < 5 * 60000)) continue;
    if (feedTimes.some((ft) => ft >= c.t - 180000 && ft <= c.peakT + 20000)) continue; // explained by an event
    picked.push(c);
    if (picked.length >= 3) break;
  }
  return picked
    .sort((x, y) => x.t - y.t)
    .map((c) => {
      const mm = session.teams ? matchMinute(session, c.t) : '';
      const pre = /\d/.test(mm) ? `${mm} ` : '';
      return { key: 'p' + Math.round(c.t / 60000), t: c.t, bpm: c.bpm, rise: Math.round(c.rise), label: `${pre}Your heart rate jumps to ${c.bpm} bpm` };
    });
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

/* ---------------- Stream sync (calibration) ---------------- */

export const MAX_DELAY_MS = 10 * 60 * 1000;

/**
 * Parse a football match clock as shown on a stream:
 * "67:23", "67", "67'", "45+2", "45+2:10", "90+3:05", "12.30".
 * Returns { sec, period } (sec = match seconds since kick-off of the match, 45:00 = 2700) or null.
 */
export function parseMatchClock(input) {
  const str = String(input || '').trim().replace(/['’]/g, '').replace(/\s+/g, '').replace('.', ':');
  let m = str.match(/^(45|90|105|120)\+(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    const base = Number(m[1]);
    const sec = base * 60 + Number(m[2]) * 60 + (m[3] != null ? Number(m[3]) : 30);
    return { sec, period: base === 45 ? 1 : 2, exact: m[3] != null };
  }
  m = str.match(/^(\d{1,3})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const min = Number(m[1]);
  const s = m[2] != null ? Number(m[2]) : 30;
  if (s > 59 || min > 130) return null;
  const sec = min * 60 + s;
  return { sec, period: sec < 2700 ? 1 : 2, exact: m[2] != null };
}

/** Real-world time (ms) of a calibration point, from the feed — or null if the feed can't place it yet. */
export function calibrationRealTime(calib, feed) {
  if (!calib || !feed) return null;
  const ph = feed.phases || {};
  if (calib.kind === 'clock') {
    if (calib.period === 2) return ph.secondhalf ? ph.secondhalf + (calib.sec - 2700) * 1000 : null;
    return ph.kickoff ? ph.kickoff + calib.sec * 1000 : null;
  }
  if (calib.kind === 'lap') {
    if (calib.lap === 1 && feed.lightsOut) return feed.lightsOut;
    return (feed.lapStarts && feed.lapStarts[calib.lap]) || null;
  }
  return null;
}

/** Apply a pending stream calibration. Returns the delay in ms, or null while waiting for data. */
export function resolveCalibration(session) {
  const c = session.calib;
  if (!c || !session.feed) return null;
  const real = calibrationRealTime(c, session.feed);
  if (real == null) {
    c.pending = true;
    return null;
  }
  const d = Math.max(0, Math.min(MAX_DELAY_MS, c.at - real));
  c.pending = false;
  c.delayMs = d;
  session.delayMs = d;
  session.delayCalibrated = true;
  return d;
}
