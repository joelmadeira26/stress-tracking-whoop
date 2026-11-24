// Google Calendar, read-only, straight from the browser (Google Identity Services token flow).
// Needs a free OAuth client ID ("Web application", authorised JavaScript origin = the app's URL).

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_KEY = 'pulse.gcal.token';

let gisPromise = null;
function loadGis() {
  if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error("Couldn't load Google sign-in. Check your connection."));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function storedToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60000 ? t : null;
  } catch {
    return null;
  }
}

export function isConnected() {
  try {
    return !!localStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

export function disconnect() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    localStorage.removeItem(TOKEN_KEY);
    if (t && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(t.token, () => {});
  } catch {
    /* ignore */
  }
}

/** Get an access token. `interactive` must be true when called from a tap the first time. */
export async function getToken(clientId, { interactive = false } = {}) {
  const cached = storedToken();
  if (cached) return cached.token;
  if (!clientId) throw new Error('Add your Google client ID in Settings first.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: SCOPE,
      prompt: interactive ? '' : 'none',
      callback: (resp) => {
        if (!resp || resp.error || !resp.access_token) {
          reject(new Error(resp && resp.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in needed. Tap Connect Google Calendar.'));
          return;
        }
        try {
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 }));
        } catch {
          /* ignore */
        }
        resolve(resp.access_token);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed.')),
    });
    client.requestAccessToken();
  });
}

const nameOf = (a) => {
  if (a.displayName) return a.displayName.trim();
  const local = String(a.email || '').split('@')[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
};

/** Google events → Pulse meetings. Skips all-day, cancelled, declined, focus time and out-of-office. */
export function normalizeEvents(items) {
  const out = [];
  for (const e of items || []) {
    if (e.status === 'cancelled') continue;
    if (!e.start || !e.start.dateTime || !e.end || !e.end.dateTime) continue;
    if (e.eventType && e.eventType !== 'default') continue;
    const attendees = e.attendees || [];
    const me = attendees.find((a) => a.self);
    if (me && me.responseStatus === 'declined') continue;
    const start = Date.parse(e.start.dateTime);
    const end = Date.parse(e.end.dateTime);
    if (!(end > start) || end - start > 8 * 3600 * 1000) continue;
    out.push({
      id: e.id,
      title: e.summary || '(No title)',
      start,
      end,
      attendees: attendees.filter((a) => !a.self && !a.resource).map(nameOf).filter(Boolean),
      organizer: e.organizer && !e.organizer.self ? nameOf(e.organizer) : null,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function fetchEvents(token, from, to, fetchImpl = fetch) {
  const q = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const res = await fetchImpl(`${API}/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    throw new Error('Google sign-in expired. Tap Connect Google Calendar again.');
  }
  if (!res.ok) throw new Error(`Google Calendar error ${res.status}`);
  const json = await res.json();
  return normalizeEvents(json.items);
}

/** Convenience: events for a time range, signing in if needed. */
export async function calendarEvents(clientId, from, to, { interactive = false } = {}) {
  const token = await getToken(clientId, { interactive });
  return fetchEvents(token, from, to);
}
