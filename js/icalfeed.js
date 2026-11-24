// Calendar from a private iCal address (Google Calendar → Settings → "Secret address in iCal format").
// Used inside the Android app, where Google sign-in isn't allowed. Read-only; no account needed.
// Handles time zones, recurring meetings (DAILY/WEEKLY/MONTHLY with INTERVAL, BYDAY, UNTIL, COUNT),
// cancelled instances (EXDATE), moved instances (RECURRENCE-ID) and attendees.

function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

function parseProps(line) {
  const i = line.indexOf(':');
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...params] = head.split(';');
  const p = {};
  for (const kv of params) {
    const j = kv.indexOf('=');
    if (j > 0) p[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value };
}

/** UTC ms for a wall-clock time in an IANA zone. */
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    for (let k = 0; k < 2; k++) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
      const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
      guess += Date.UTC(y, mo - 1, d, h, mi, s) - asUtc;
    }
  } catch {
    /* unknown zone: treat as UTC */
  }
  return guess;
}

function parseTime(prop) {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { t: Date.UTC(+y, +mo - 1, +d), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  if (prop.params.TZID) return { t: zonedToUtc(+y, +mo, +d, +h, +mi, +s, prop.params.TZID), allDay: false, tz: prop.params.TZID };
  return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function nameOf(prop) {
  if (prop.params.CN) return prop.params.CN.trim();
  const local = prop.value.replace(/^mailto:/i, '').split('@')[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseIcs(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') cur = { attendees: [], exdates: [], props: {} };
    else if (raw === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur && raw.includes(':')) {
      const p = parseProps(raw);
      if (p.name === 'ATTENDEE') cur.attendees.push(p);
      else if (p.name === 'EXDATE') for (const v of p.value.split(',')) cur.exdates.push(parseTime({ ...p, value: v }));
      else cur.props[p.name] = p;
    }
  }
  return events;
}

/** Expand into meetings overlapping [from, to]. selfEmail (optional) skips you in attendees and declined events. */
export function expandIcs(text, from, to, { selfEmail = '' } = {}) {
  const raw = parseIcs(text);
  const me = selfEmail.toLowerCase();
  const overrides = new Map(); // uid|start → event
  for (const e of raw) {
    if (e.props['RECURRENCE-ID'] && e.props.UID) {
      const rid = parseTime(e.props['RECURRENCE-ID']);
      if (rid) overrides.set(`${e.props.UID.value}|${rid.t}`, e);
    }
  }
  const out = [];
  const push = (e, start, end, idSuffix) => {
    if (end <= from || start >= to) return;
    const atts = e.attendees.filter((a) => {
      const email = a.value.replace(/^mailto:/i, '').toLowerCase();
      if (me && email === me) return false;
      return (a.params.CUTYPE || 'INDIVIDUAL') === 'INDIVIDUAL';
    });
    const self = me && e.attendees.find((a) => a.value.replace(/^mailto:/i, '').toLowerCase() === me);
    if (self && self.params.PARTSTAT === 'DECLINED') return;
    out.push({
      id: `${(e.props.UID && e.props.UID.value) || 'ev'}${idSuffix}`,
      title: (e.props.SUMMARY && e.props.SUMMARY.value.replace(/\\,/g, ',').replace(/\\n/g, ' ')) || '(No title)',
      start,
      end,
      attendees: atts.map(nameOf).filter(Boolean),
    });
  };
  for (const e of raw) {
    if (e.props['RECURRENCE-ID']) continue;
    if (e.props.STATUS && e.props.STATUS.value === 'CANCELLED') continue;
    const ds = e.props.DTSTART && parseTime(e.props.DTSTART);
    if (!ds || ds.allDay) continue;
    const de = e.props.DTEND ? parseTime(e.props.DTEND) : null;
    const dur = de ? de.t - ds.t : 30 * 60000;
    if (!(dur > 0) || dur > 8 * 3600e3) continue;
    const rr = e.props.RRULE && Object.fromEntries(e.props.RRULE.value.split(';').map((kv) => kv.split('=')));
    if (!rr) {
      push(e, ds.t, ds.t + dur, '');
      continue;
    }
    const freq = rr.FREQ;
    const interval = Math.max(1, Number(rr.INTERVAL) || 1);
    const until = rr.UNTIL ? parseTime({ value: rr.UNTIL, params: {} }).t : Infinity;
    const count = rr.COUNT ? Number(rr.COUNT) : Infinity;
    const byday = rr.BYDAY ? rr.BYDAY.split(',').map((x) => DAYS.indexOf(x.slice(-2))) : null;
    const exd = new Set(e.exdates.filter(Boolean).map((x) => x.t));
    const base = new Date(ds.t);
    let n = 0;
    const occ = (t) => {
      if (t > until || n >= count) return false;
      n++;
      if (exd.has(t)) return true;
      const ov = e.props.UID && overrides.get(`${e.props.UID.value}|${t}`);
      if (ov) {
        const os = parseTime(ov.props.DTSTART);
        const oe = ov.props.DTEND ? parseTime(ov.props.DTEND) : null;
        if (os && !(ov.props.STATUS && ov.props.STATUS.value === 'CANCELLED')) push(ov.attendees.length ? ov : { ...ov, attendees: e.attendees }, os.t, oe ? oe.t : os.t + dur, `_${t}`);
      } else push(e, t, t + dur, `_${t}`);
      return true;
    };
    // wall-clock steps in the event's own time zone keep 10:00 at 10:00 across DST changes
    const tz = ds.tz;
    const wall = (dayOffset, monthOffset = 0) => {
      const local = new Date(base.getTime());
      const fmt = tz ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }) : null;
      const p = fmt ? Object.fromEntries(fmt.formatToParts(local).map((x) => [x.type, +x.value || x.value])) : { year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate(), hour: local.getHours(), minute: local.getMinutes(), second: local.getSeconds() };
      const d = new Date(Date.UTC(p.year, p.month - 1 + monthOffset, p.day + dayOffset));
      return tz
        ? zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.hour % 24, p.minute, p.second, tz)
        : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), p.hour, p.minute, p.second).getTime();
    };
    const limit = to + 864e5;
    if (freq === 'DAILY') {
      for (let k = 0; k < 2000; k++) {
        const t = wall(k * interval);
        if (t > limit || !occ(t)) break;
      }
    } else if (freq === 'WEEKLY') {
      const startDow = base.getDay();
      const days = byday && byday.every((x) => x >= 0) ? byday : [startDow];
      outer: for (let w = 0; w < 600; w++) {
        for (const dow of [...days].sort((a, b) => a - b)) {
          const off = w * 7 * interval + (dow - startDow);
          if (off < 0) continue;
          const t = wall(off);
          if (t > limit) break outer;
          if (!occ(t)) break outer;
        }
      }
    } else if (freq === 'MONTHLY') {
      for (let k = 0; k < 240; k++) {
        const t = wall(0, k * interval);
        if (t > limit || !occ(t)) break;
      }
    } else {
      push(e, ds.t, ds.t + dur, '');
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function fetchIcsEvents(url, from, to, opts = {}) {
  const u = String(url || '').trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(u)) throw new Error('Paste the iCal address that starts with https://');
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Calendar address error ${res.status}`);
  return expandIcs(await res.text(), from, to, opts);
}
