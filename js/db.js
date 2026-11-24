// IndexedDB storage: finished sessions + the in-progress live session (autosave).
import { DEFAULT_SETTINGS } from './config.js';

const DB_NAME = 'pulse';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('live')) db.createObjectStore('live');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    else result = r;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const db = {
  saveSession: (s) => tx('sessions', 'readwrite', (st) => st.put(s)),
  getSession: (id) => tx('sessions', 'readonly', (st) => st.get(id)),
  deleteSession: (id) => tx('sessions', 'readwrite', (st) => st.delete(id)),
  allSessions: async () => {
    const list = (await tx('sessions', 'readonly', (st) => st.getAll())) || [];
    return list.sort((a, b) => b.startTs - a.startTs);
  },
  clearSessions: () => tx('sessions', 'readwrite', (st) => st.clear()),
  saveLive: (s) => tx('live', 'readwrite', (st) => st.put(s, 'current')),
  getLive: () => tx('live', 'readonly', (st) => st.get('current')),
  clearLive: () => tx('live', 'readwrite', (st) => st.delete('current')),
};

// Settings are tiny, so localStorage is fine (and stays on this device only).
const SETTINGS_KEY = 'pulse.settings';
export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// What you follow (teams, competitions, F1 drivers).
const FOLLOW_KEY = 'pulse.follow';
export function loadFollow(defaults) {
  try {
    const raw = localStorage.getItem(FOLLOW_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : JSON.parse(JSON.stringify(defaults));
  } catch {
    return JSON.parse(JSON.stringify(defaults));
  }
}
export function saveFollow(f) {
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}
