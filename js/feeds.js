// Live event feeds: football via ESPN's public site API, F1 via OpenF1.
// Everything runs in the browser (both APIs send CORS headers). Parsers are pure and unit-tested.
import { COMPETITIONS } from './config.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const OF1 = 'https://api.openf1.org/v1';
const MIN = 60000;

export class FeedError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function getJSON(url, { timeout = 15000, fetchImpl = fetch } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetchImpl(url, ctl ? { signal: ctl.signal } : {});
    if (!res.ok) throw new FeedError(`HTTP ${res.status}`, res.status);
    return await res.json();
  } catch (e) {
    if (e instanceof FeedError) throw e;
    throw new FeedError(e && e.name === 'AbortError' ? 'Timed out' : 'Network error', 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------- small cache (localStorage) ---------------- */

function cacheGet(key, maxAge) {
  try {
    const raw = localStorage.getItem('pulse.cache.' + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Date.now() - v.t < maxAge ? v.data : null;
  } catch {
    return null;
  }
}
function cacheSet(key, data) {
  try {
    localStorage.setItem('pulse.cache.' + key, JSON.stringify({ t: Date.now(), data }));
  } catch {
    /* quota */
  }
}
async function cached(key, maxAge, fn) {
  const hit = cacheGet(key, maxAge);
  if (hit) return hit;
  const data = await fn();
  cacheSet(key, data);
  return data;
}

/* ---------------- Football fixtures ---------------- */

const scoreOf = (s) => (s == null ? null : typeof s === 'object' ? s.displayValue ?? s.value : s);
const logoOf = (t) => t.logo || (t.logos && t.logos[0] && t.logos[0].href) || '';

function teamOf(c) {
  const t = c.team || {};
  return {
    id: String(t.id),
    name: t.displayName || t.name,
    short: t.shortDisplayName || t.displayName,
    abbr: t.abbreviation,
    logo: logoOf(t),
    score: scoreOf(c.score),
  };
}

export function normalizeEspnEvent(e, leagueSlug, leagueName) {
  const comp = e.competitions && e.competitions[0];
  if (!comp) return null;
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const st = (comp.status || e.status || {}).type || {};
  const slug = (e.league && e.league.slug) || leagueSlug;
  return {
    key: `espn:${e.id}`,
    source: 'espn',
    id: String(e.id),
    league: slug,
    competition: COMPETITIONS[slug] || (e.league && e.league.name) || leagueName || '',
    date: Date.parse(e.date),
    state: st.state || 'pre',
    detail: st.shortDetail || st.detail || '',
    home: teamOf(home),
    away: teamOf(away),
  };
}

function monthStr(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function leagueFixtures(slug, now) {
  const d = new Date(now);
  const months = [monthStr(d)];
  const later = new Date(now + 9 * 24 * 3600 * 1000);
  if (monthStr(later) !== months[0]) months.push(monthStr(later));
  const urls = [`${ESPN}/${slug}/scoreboard`, ...months.map((m) => `${ESPN}/${slug}/scoreboard?dates=${m}`)];
  const out = [];
  const res = await Promise.allSettled(urls.map((u, i) => (i === 0 ? getJSON(u) : cached(`sb:${slug}:${months[i - 1]}`, 30 * MIN, () => getJSON(u)))));
  for (const r of res) {
    if (r.status !== 'fulfilled') continue;
    const name = r.value.leagues && r.value.leagues[0] && r.value.leagues[0].name;
    for (const e of r.value.events || []) {
      const n = normalizeEspnEvent(e, slug, name);
      if (n) out.push(n);
    }
  }
  return out;
}

async function teamFixtures(team) {
  const urls = [`${ESPN}/all/teams/${team.id}/schedule?fixture=true`, `${ESPN}/all/teams/${team.id}/schedule`];
  const out = [];
  const res = await Promise.allSettled(urls.map((u, i) => cached(`team:${team.id}:${i}`, 10 * MIN, () => getJSON(u))));
  for (const r of res) {
    if (r.status !== 'fulfilled') continue;
    for (const e of r.value.events || []) {
      const n = normalizeEspnEvent(e, e.league && e.league.slug);
      if (n) out.push(n);
    }
  }
  return out;
}

/* ---------------- F1 schedule ---------------- */

async function f1Fixtures(now) {
  const year = new Date(now).getFullYear();
  const [sessions, meetings] = await Promise.all([
    cached(`f1s:${year}`, 6 * 60 * MIN, () => getJSON(`${OF1}/sessions?year=${year}`)),
    cached(`f1m:${year}`, 12 * 60 * MIN, () => getJSON(`${OF1}/meetings?year=${year}`)),
  ]);
  const mById = new Map(meetings.map((m) => [m.meeting_key, m]));
  return sessions
    .filter((s) => s.session_name === 'Race' || s.session_name === 'Sprint')
    .map((s) => {
      const m = mById.get(s.meeting_key) || {};
      const start = Date.parse(s.date_start);
      const end = Date.parse(s.date_end) || start + 2 * 60 * MIN;
      const state = now < start ? 'pre' : now <= end + 30 * MIN ? 'in' : 'post';
      return {
        key: `f1:${s.session_key}`,
        source: 'openf1',
        id: String(s.session_key),
        sessionKey: s.session_key,
        sessionName: s.session_name,
        meetingName: m.meeting_name || `${s.location} Grand Prix`,
        competition: 'Formula 1',
        flag: m.country_flag || '',
        location: s.location,
        date: start,
        end,
        state,
        detail: s.session_name,
      };
    });
}

/**
 * Upcoming/live events for the things you follow.
 * Window: live now, finished within the last 4 h, or starting within 9 days.
 */
export async function loadFixtures(follow, now = Date.now()) {
  const jobs = [];
  for (const slug of follow.competitions || []) jobs.push(leagueFixtures(slug, now));
  for (const t of follow.teams || []) jobs.push(teamFixtures(t));
  if (follow.f1) jobs.push(f1Fixtures(now));
  const res = await Promise.allSettled(jobs);
  const errors = res.filter((r) => r.status === 'rejected').length;
  const byKey = new Map();
  for (const r of res) if (r.status === 'fulfilled') for (const ev of r.value) {
    const prev = byKey.get(ev.key);
    // prefer the freshest state (live scoreboard beats cached schedule)
    if (!prev || (ev.state === 'in' && prev.state !== 'in') || (prev.state === 'pre' && ev.state === 'post')) byKey.set(ev.key, ev);
  }
  const teamIds = new Set((follow.teams || []).map((t) => String(t.id)));
  const list = [...byKey.values()]
    .filter((e) => e.state === 'in' || (e.date > now - 4 * 60 * MIN && e.date < now + 9 * 24 * 60 * MIN))
    .map((e) => {
      if (e.source === 'espn') {
        e.mine = teamIds.has(e.home.id) ? 'home' : teamIds.has(e.away.id) ? 'away' : null;
      }
      return e;
    })
    .sort((a, b) => (b.state === 'in') - (a.state === 'in') || a.date - b.date);
  return { events: list, errors, total: jobs.length };
}

/* ---------------- Team & driver search ---------------- */

export async function searchableTeams(leagues) {
  const out = [];
  const res = await Promise.allSettled(
    leagues.map((slug) => cached(`teams:${slug}`, 7 * 24 * 60 * MIN, () => getJSON(`${ESPN}/${slug}/teams`)).then((d) => [slug, d])),
  );
  for (const r of res) {
    if (r.status !== 'fulfilled') continue;
    const [slug, d] = r.value;
    const teams = (((d.sports || [])[0] || {}).leagues || [])[0]?.teams || [];
    for (const { team: t } of teams) out.push({ id: String(t.id), name: t.displayName, league: slug, logo: logoOf(t) });
  }
  const seen = new Set();
  return out.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
}

export async function currentDrivers() {
  const d = await cached('f1drivers', 24 * 60 * MIN, () => getJSON(`${OF1}/drivers?session_key=latest`));
  return d.map((x) => ({ name: titleName(x.full_name), last: String(x.last_name || '').toUpperCase(), number: x.driver_number, team: x.team_name, colour: x.team_colour }));
}

function titleName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

/* ================= Football event parsing ================= */

const GOAL_RE = /(\d+),\s*[^.]*?\s(\d+)\./;

function minuteLabel(clock) {
  const v = clock && clock.displayValue;
  if (!v) return '';
  return v.replace(/'\+/, '+').replace(/''/g, "'");
}

function playerAndTeam(text) {
  const m = String(text || '').match(/([A-ZÀ-ÖØ-Þ][^()!.,:]*?)\s\(([^)]+)\)/);
  return m ? { player: m[1].trim(), team: m[2].trim() } : { player: '', team: '' };
}

/**
 * Parse an ESPN soccer summary into status, score, phases (feed times) and moments.
 * Moment: { fid, ft (ms, real time of the event), est (time estimated), cat, side?, label }
 */
export function parseEspnSummary(d, { mine = null } = {}) {
  const comp = d.header && d.header.competitions && d.header.competitions[0];
  const comps = (comp && comp.competitors) || [];
  const H = comps.find((c) => c.homeAway === 'home');
  const A = comps.find((c) => c.homeAway === 'away');
  const home = H ? teamOf(H) : { name: 'Home', short: 'Home' };
  const away = A ? teamOf(A) : { name: 'Away', short: 'Away' };
  const st = (comp && comp.status && comp.status.type) || {};
  const status = { state: st.state || 'pre', detail: st.shortDetail || st.detail || '', completed: !!st.completed };
  const score = { home: Number(home.score) || 0, away: Number(away.score) || 0 };

  const ke = d.keyEvents || [];
  const wc = (x) => (x && x.wallclock ? Date.parse(x.wallclock) : null);
  const phases = {};
  for (const k of ke) {
    const t = k.type && k.type.type;
    const w = wc(k);
    if (!w) continue;
    if (t === 'kickoff' && !phases.kickoff) phases.kickoff = w;
    else if (t === 'halftime' && !phases.halftime) phases.halftime = w;
    else if (t === 'start-2nd-half' && !phases.secondhalf) phases.secondhalf = w;
    else if (/^end-(regular-time|extra-time|match|game)|^full-?time|shootout-end|^end-of-match/.test(t || '')) phases.fulltime = w;
  }
  if (status.state !== 'post') delete phases.fulltime;

  const estimate = (period, clock) => {
    const v = clock && clock.value;
    if (v == null) return null;
    if ((period || 1) <= 1 && phases.kickoff) return phases.kickoff + v * 1000;
    if (period === 2 && phases.secondhalf) return phases.secondhalf + (v - 2700) * 1000;
    return null;
  };
  const timeOf = (play) => {
    const w = wc(play);
    if (w) return { ft: w, est: false };
    const e = estimate(play.period && play.period.number, play.clock);
    return e ? { ft: e, est: true } : null;
  };

  const moments = [];
  let prev = { h: 0, a: 0 };
  const sideOfTeam = (name) => {
    if (!name) return null;
    const n = name.toLowerCase();
    if ([home.name, home.short].some((x) => x && (x.toLowerCase() === n || n.includes(x.toLowerCase()) || x.toLowerCase().includes(n)))) return 'home';
    if ([away.name, away.short].some((x) => x && (x.toLowerCase() === n || n.includes(x.toLowerCase()) || x.toLowerCase().includes(n)))) return 'away';
    return null;
  };
  const goalCat = (side) => (mine ? (side === mine ? 'goalMine' : 'goalTheirs') : side === 'home' ? 'goalHome' : 'goalAway');

  for (const k of ke) {
    const type = (k.type && k.type.type) || '';
    const text = k.text || '';
    const min = minuteLabel(k.clock);
    const tm = timeOf(k);
    if (!tm) continue;
    const fid = `k${k.id || type + min}`;
    const isGoal = /^goal/.test(type) || type === 'own-goal' || type === 'penalty---scored' || (k.scoringPlay && !/shootout/.test(type));
    if (isGoal) {
      let side = null;
      const m = text.match(GOAL_RE);
      if (m) {
        const h = Number(m[1]);
        const a = Number(m[2]);
        side = h > prev.h ? 'home' : a > prev.a ? 'away' : null;
        prev = { h, a };
      }
      if (!side) {
        side = sideOfTeam(k.team && k.team.displayName);
        if (side) prev = { ...prev, [side === 'home' ? 'h' : 'a']: prev[side === 'home' ? 'h' : 'a'] + 1 };
      }
      let scorer = '';
      if (type === 'own-goal') {
        const og = text.match(/Own Goal by ([^,]+)/i);
        scorer = og ? `${og[1].trim()} (own goal)` : 'own goal';
      } else {
        const after = m ? text.slice(text.indexOf(m[0]) + m[0].length) : text;
        scorer = playerAndTeam(after).player || (k.participants && k.participants[0] && k.participants[0].athlete && k.participants[0].athlete.displayName) || '';
      }
      if (type === 'penalty---scored') scorer += scorer ? ' (pen)' : 'penalty';
      const teamName = side === 'home' ? home.short : side === 'away' ? away.short : (k.team && k.team.displayName) || '';
      moments.push({
        fid,
        ...tm,
        cat: side ? goalCat(side) : 'key',
        side,
        label: `${min} Goal ${teamName} (${prev.h}–${prev.a})${scorer ? ': ' + scorer : ''}`,
      });
    } else if (type === 'red-card') {
      const pt = playerAndTeam(text);
      moments.push({ fid, ...tm, cat: 'card', label: `${min} Red card: ${pt.player || 'player'}${pt.team ? ` (${pt.team})` : ''}` });
    } else if (/penalty/.test(type) && !/scored/.test(type)) {
      const pt = playerAndTeam(text);
      const what = /saved/.test(type) ? 'saved' : 'missed';
      moments.push({ fid, ...tm, cat: 'key', label: `${min} Penalty ${what}${pt.player ? ': ' + pt.player : ''}` });
    } else if (/extra-time/.test(type) && /start/.test(type)) {
      moments.push({ fid, ...tm, cat: 'key', label: 'Extra time begins' });
    } else if (/shootout/.test(type) && /start|begin/.test(type)) {
      moments.push({ fid, ...tm, cat: 'key', label: 'Penalty shoot-out' });
    }
  }

  // Commentary: VAR decisions and woodwork
  const seen = new Set();
  for (const c of d.commentary || []) {
    const text = c.text || '';
    const play = c.play || {};
    const clock = c.time || play.clock;
    const min = minuteLabel(clock);
    let label = null;
    if (/^VAR Decision/i.test(text)) label = `${min} VAR: ${text.replace(/^VAR Decision:\s*/i, '').replace(/\.$/, '')}`;
    else {
      const w = text.match(/hits the (left post|right post|post|bar|crossbar)/i);
      if (w) {
        const pt = playerAndTeam(text);
        label = `${min} Off the ${w[1].replace(/left |right /, '')}: ${pt.player}${pt.team ? ` (${pt.team})` : ''}`;
      }
    }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const tm = timeOf({ ...play, clock, period: play.period });
    if (!tm) continue;
    moments.push({ fid: `c${c.sequence ?? play.id ?? label}`, ...tm, cat: 'key', label });
  }

  if (phases.fulltime) {
    moments.push({
      fid: 'ft',
      ft: phases.fulltime,
      est: false,
      cat: 'finish',
      label: `Full time: ${home.short} ${score.home}–${score.away} ${away.short}`,
    });
  }
  moments.sort((a, b) => a.ft - b.ft);
  return { status, score, home, away, phases, moments, bands: [] };
}

export async function syncEspn(event, opts = {}) {
  const d = await getJSON(`${ESPN}/${event.league || 'all'}/summary?event=${event.id}`, opts);
  return parseEspnSummary(d, { mine: event.mine || null });
}

/* ================= F1 parsing ================= */

const surname = (d) => titleName(d ? d.last_name || String(d.full_name || '').split(' ').slice(-1)[0] : '?');

/**
 * data: { rc, drivers, leaders, laps (mine), pits (mine), myPos, result, session }
 * Returns { status, moments, bands, phases, myDriver, result }
 */
export function parseOpenF1(data, myLast, now = Date.now()) {
  const drivers = new Map((data.drivers || []).map((d) => [d.driver_number, d]));
  const me = (data.drivers || []).find((d) => String(d.last_name || d.full_name || '').toUpperCase().includes(String(myLast || '').toUpperCase()));
  const myNum = me ? me.driver_number : null;
  const myName = me ? titleName(me.first_name || surname(me)) : null;
  const nameOf = (n) => (n === myNum ? myName : surname(drivers.get(n)));
  const t = (s) => Date.parse(s);

  const laps = (data.laps || []).filter((l) => l.date_start).sort((a, b) => t(a.date_start) - t(b.date_start));
  const rc = (data.rc || []).slice().sort((a, b) => t(a.date) - t(b.date));
  const lapAt = (ms) => {
    let lap = null;
    for (const l of laps) if (t(l.date_start) <= ms) lap = l.lap_number;
    if (lap == null) {
      for (const m of rc) if (t(m.date) <= ms && m.lap_number) lap = m.lap_number;
    }
    return lap || 1;
  };

  const moments = [];
  const bands = [];
  const lightsOut = laps.length ? t(laps[0].date_start) : data.session ? t(data.session.date_start) : null;
  const chequered = rc.find((m) => m.flag === 'CHEQUERED');
  const finishT = chequered ? t(chequered.date) : null;

  if (lightsOut) {
    const myStart = (data.myPos || []).slice().sort((a, b) => t(a.date) - t(b.date)).filter((p) => t(p.date) <= lightsOut + 5000).pop();
    moments.push({
      fid: 'start',
      ft: lightsOut,
      est: false,
      cat: 'key',
      label: `Lights out${myName ? `. ${myName} starts${myStart ? ' P' + myStart.position : ''}` : ''}`,
    });
  }

  // Lead changes, clustered
  const leaders = (data.leaders || [])
    .slice()
    .sort((a, b) => t(a.date) - t(b.date))
    .filter((p, i, arr) => i === 0 || p.driver_number !== arr[i - 1].driver_number);
  const changes = [];
  for (let i = 1; i < leaders.length; i++) {
    const at = t(leaders[i].date);
    if (lightsOut && at < lightsOut + 3000) continue;
    if (finishT && at > finishT) continue;
    changes.push({ at, from: leaders[i - 1].driver_number, to: leaders[i].driver_number });
  }
  let myLeadInvolved = false;
  // 1) collapse "B leads, A takes it back within 3 min" into one swap event
  const evs = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const n = changes[i + 1];
    if (n && n.from === c.to && n.to === c.from && n.at - c.at < 3 * MIN) {
      evs.push({ kind: 'swap', at: c.at, end: n.at, holder: c.from, challenger: c.to });
      i++;
    } else evs.push({ kind: 'change', at: c.at, end: c.at, holder: c.from, challenger: c.to });
  }
  // 2) group consecutive swaps with the same pair of drivers within 6 min
  const groups = [];
  for (const e of evs) {
    const g = groups[groups.length - 1];
    if (g && e.kind === 'swap' && g[0].kind === 'swap' && g[0].holder === e.holder && g[0].challenger === e.challenger && e.at - g[g.length - 1].end < 6 * MIN) g.push(e);
    else groups.push([e]);
  }
  groups.forEach((g, i) => {
    const e = g[0];
    const L1 = lapAt(e.at);
    const L2 = lapAt(g[g.length - 1].end);
    const A = nameOf(e.holder);
    const B = nameOf(e.challenger);
    if (myNum != null && (e.holder === myNum || e.challenger === myNum)) myLeadInvolved = true;
    let label;
    if (e.kind === 'change') {
      if (e.challenger === myNum) label = `Lap ${L1}: ${myName} takes the lead from ${A}`;
      else if (e.holder === myNum) label = `Lap ${L1}: ${B} passes ${myName} for the lead`;
      else label = `Lap ${L1}: ${B} takes the lead from ${A}`;
    } else if (g.length === 1) {
      label = `Lap ${L1}: ${B} briefly takes the lead; ${A} retakes it`;
    } else {
      label = `Laps ${L1} to ${L2}: lead swaps back and forth between ${A} and ${B}`;
    }
    moments.push({ fid: `lead${i}:${e.at}`, ft: e.at, est: false, cat: 'lead', label });
  });

  // Safety car / VSC / red flag bands
  let open = null;
  for (const m of rc) {
    const msg = String(m.message || '').toUpperCase();
    const at = t(m.date);
    if (!open) {
      let kind = null;
      if (/VIRTUAL SAFETY CAR DEPLOYED/.test(msg)) kind = 'VSC';
      else if (/SAFETY CAR DEPLOYED/.test(msg)) kind = 'SAFETY CAR';
      else if (m.flag === 'RED' || /(^|[^A-Z])RED FLAG/.test(msg)) kind = 'RED FLAG';
      if (kind) open = { kind, start: at, lap: m.lap_number || lapAt(at) };
    } else {
      let end = null;
      if (open.kind === 'SAFETY CAR' && /SAFETY CAR IN THIS LAP/.test(msg)) end = at + 90000;
      else if (open.kind === 'VSC' && /VIRTUAL SAFETY CAR ENDING/.test(msg)) end = at + 15000;
      else if (open.kind === 'RED FLAG' && (/RESUME|RESTART|GREEN LIGHT/.test(msg) || m.flag === 'GREEN')) end = at;
      if (end) {
        bands.push({ fid: `band${open.start}`, start: open.start, end, label: open.kind, cat: 'sc' });
        moments.push({ fid: `sc${open.start}`, ft: open.start, est: false, cat: 'sc', label: `Lap ${open.lap}: ${titleCaseKind(open.kind)}` });
        open = null;
      }
    }
  }
  if (open) {
    const end = Math.min(now, finishT || now);
    bands.push({ fid: `band${open.start}`, start: open.start, end, label: open.kind, cat: 'sc', open: true });
    moments.push({ fid: `sc${open.start}`, ft: open.start, est: false, cat: 'sc', label: `Lap ${open.lap}: ${titleCaseKind(open.kind)}` });
  }

  // My pit stops (merged into a safety-car moment when they happen under it)
  for (const p of data.pits || []) {
    const at = t(p.date);
    if (!at) continue;
    const dur = p.stop_duration || p.pit_duration;
    const what = `${myName} pits${dur ? ` (${Number(dur).toFixed(1)} s${p.stop_duration ? ' stop' : ' in the pit lane'})` : ''}`;
    const sc = moments.find((m) => m.cat === 'sc' && at >= m.ft && at - m.ft < 4 * MIN);
    if (sc) sc.label += `; ${what}`;
    else moments.push({ fid: `pit${at}`, ft: at, est: false, cat: 'pit', label: `Lap ${p.lap_number || lapAt(at)}: ${what}` });
  }

  // Result
  let result = null;
  if (finishT && myNum != null) {
    const res = (data.result || []).slice().sort((a, b) => (a.position || 99) - (b.position || 99));
    const mine = res.find((r) => r.driver_number === myNum);
    let label = 'Chequered flag';
    if (mine) {
      result = { position: mine.position, dnf: mine.dnf || mine.dns || mine.dsq };
      if (result.dnf) label = `${myName} did not finish`;
      else if (mine.position === 1) {
        const p2 = res.find((r) => r.position === 2);
        const gap = p2 && typeof p2.gap_to_leader === 'number' ? `${p2.gap_to_leader.toFixed(3)}s` : null;
        label = `${myName} wins${gap ? ` by ${gap}` : ''}${p2 ? ` over ${nameOf(p2.driver_number)}` : ''}`;
      } else {
        const gap = typeof mine.gap_to_leader === 'number' ? ` (+${mine.gap_to_leader.toFixed(3)}s)` : '';
        label = `${myName} finishes P${mine.position}${gap}`;
      }
    }
    moments.push({ fid: 'finish', ft: finishT, est: false, cat: 'finish', label });
  }

  const maxLap = rc.reduce((a, m) => Math.max(a, m.lap_number || 0), 0);
  const state = finishT ? 'post' : lightsOut ? 'in' : 'pre';
  moments.sort((a, b) => a.ft - b.ft);
  return {
    status: { state, detail: finishT ? 'Finished' : maxLap ? `Lap ${maxLap}` : 'Not started', completed: !!finishT },
    moments,
    bands,
    phases: {},
    myDriver: myName ? { name: myName, full: titleName(me.full_name), number: myNum, won: result && result.position === 1, leadInvolved: myLeadInvolved } : null,
    result,
  };
}

function titleCaseKind(k) {
  return k === 'VSC' ? 'Virtual safety car' : k === 'RED FLAG' ? 'Red flag' : 'Safety car';
}

export async function syncF1(event, myLast, opts = {}) {
  const k = event.sessionKey;
  const q = (ep, extra = '') => getJSON(`${OF1}/${ep}?session_key=${k}${extra}`, opts).catch((e) => {
    if (e.status === 404) return [];
    throw e;
  });
  const [rc, drivers, leaders, result, sessions] = await Promise.all([
    q('race_control'),
    q('drivers'),
    q('position', '&position=1'),
    q('session_result').catch(() => []),
    q('sessions').catch(() => []),
  ]);
  const me = drivers.find((d) => String(d.last_name || d.full_name || '').toUpperCase().includes(String(myLast || '').toUpperCase()));
  let laps = [];
  let pits = [];
  let myPos = [];
  if (me) {
    [laps, pits, myPos] = await Promise.all([
      q('laps', `&driver_number=${me.driver_number}`),
      q('pit', `&driver_number=${me.driver_number}`),
      q('position', `&driver_number=${me.driver_number}`),
    ]);
  }
  return parseOpenF1({ rc, drivers, leaders, laps, pits, myPos, result, session: sessions[0] }, myLast);
}

/** One call for any linked event. */
export async function syncEvent(event, follow, opts = {}) {
  if (event.source === 'espn') return syncEspn(event, opts);
  if (event.source === 'openf1') return syncF1(event, (event.driver && event.driver.last) || (follow.drivers[0] && follow.drivers[0].last), opts);
  throw new Error('Unknown feed');
}
