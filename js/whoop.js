// WHOOP official API (daily recovery, resting HR, HRV, sleep) through your own relay.
// Tokens live only on this device. WHOOP rotates refresh tokens, so refreshes are single-flight.

const TOKENS = 'pulse.whoop.tokens';
const DAYS = 'pulse.whoop.days';
const META = 'pulse.whoop.meta';

const read = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

const base = (relay) => String(relay || '').trim().replace(/\/+$/, '');

export function isConnected() {
  const t = read(TOKENS, null);
  return !!(t && t.rt);
}

export function disconnect() {
  try {
    localStorage.removeItem(TOKENS);
    localStorage.removeItem(META);
  } catch {
    /* ignore */
  }
}

/** Start sign-in (full-page redirect to WHOOP through the relay). */
export function login(relay) {
  if (!base(relay)) throw new Error('Add your relay URL first.');
  location.href = `${base(relay)}/login`;
}

/** Handle "#/whoop?at=…&rt=…&exp=…" after WHOOP sends you back. Returns { ok, error }. */
export function handleCallback(hash) {
  const q = new URLSearchParams(String(hash).split('?')[1] || '');
  if (q.get('error')) return { ok: false, error: q.get('error') };
  if (!q.get('at')) return { ok: false, error: 'missing_token' };
  write(TOKENS, { at: q.get('at'), rt: q.get('rt') || '', exp: Date.now() + Number(q.get('exp') || 3600) * 1000 });
  return { ok: true };
}

let refreshing = null;
async function accessToken(relay, fetchImpl) {
  const t = read(TOKENS, null);
  if (!t) throw Object.assign(new Error('Not connected to WHOOP.'), { kind: 'auth' });
  if (t.exp > Date.now() + 60000) return t.at;
  if (!refreshing) {
    refreshing = (async () => {
      const res = await fetchImpl(`${base(relay)}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: t.rt }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.access_token) {
        disconnect();
        throw Object.assign(new Error('WHOOP sign-in expired. Connect again in Settings.'), { kind: 'auth' });
      }
      write(TOKENS, { at: j.access_token, rt: j.refresh_token || t.rt, exp: Date.now() + (j.expires_in || 3600) * 1000 });
      return j.access_token;
    })().finally(() => (refreshing = null));
  }
  return refreshing;
}

async function getAll(relay, path, params, fetchImpl) {
  const out = [];
  let next = '';
  for (let page = 0; page < 8; page++) {
    const q = new URLSearchParams({ ...params, limit: '25', ...(next ? { nextToken: next } : {}) });
    const at = await accessToken(relay, fetchImpl);
    const res = await fetchImpl(`${base(relay)}/api/v2/${path}?${q}`, { headers: { Authorization: `Bearer ${at}` } });
    if (res.status === 401) {
      const t = read(TOKENS, null);
      if (t) write(TOKENS, { ...t, exp: 0 }); // force a refresh next time
      throw Object.assign(new Error('WHOOP rejected the token. Try again.'), { kind: 'auth' });
    }
    if (!res.ok) throw new Error(`WHOOP error ${res.status}`);
    const j = await res.json();
    out.push(...(j.records || []));
    next = j.next_token || '';
    if (!next) break;
  }
  return out;
}

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Merge WHOOP records into { 'YYYY-MM-DD': { recovery, rhr, hrv, sleepPerf, strain } } keyed by the day you woke up. */
export function mergeDays(recoveries, sleeps, cycles) {
  const sleepById = new Map(sleeps.filter((s) => !s.nap).map((s) => [s.id, s]));
  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const days = {};
  for (const r of recoveries) {
    if (r.score_state !== 'SCORED' || !r.score) continue;
    const sl = sleepById.get(r.sleep_id);
    const cy = cycleById.get(r.cycle_id);
    const when = (sl && sl.end) || (cy && cy.start) || r.created_at;
    days[dayKey(when)] = {
      recovery: r.score.recovery_score,
      rhr: r.score.resting_heart_rate,
      hrv: Math.round(r.score.hrv_rmssd_milli * 10) / 10,
      sleepPerf: sl && sl.score ? sl.score.sleep_performance_percentage : null,
      strain: cy && cy.score ? Math.round(cy.score.strain * 10) / 10 : null,
    };
  }
  return days;
}

/** Pull the last `daysBack` days. Returns { days, latest }. */
export async function sync(relay, { daysBack = 30, fetchImpl = fetch.bind(globalThis) } = {}) {
  const start = new Date(Date.now() - daysBack * 864e5).toISOString();
  const [rec, sleep, cyc] = await Promise.all([
    getAll(relay, 'recovery', { start }, fetchImpl),
    getAll(relay, 'activity/sleep', { start }, fetchImpl),
    getAll(relay, 'cycle', { start }, fetchImpl),
  ]);
  const days = { ...read(DAYS, {}), ...mergeDays(rec, sleep, cyc) };
  write(DAYS, days);
  write(META, { at: Date.now() });
  const keys = Object.keys(days).sort();
  return { days, latest: keys.length ? { day: keys[keys.length - 1], ...days[keys[keys.length - 1]] } : null };
}

export function lastSync() {
  return (read(META, {}) || {}).at || 0;
}

/** WHOOP day data for a timestamp, if synced. */
export function dayFor(t) {
  return read(DAYS, {})[dayKey(t)] || null;
}
