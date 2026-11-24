// Pulse — UI, routing and live-session logic.
import { SESSION_TYPES, FREE_TAG, ICONS, COLORS } from './config.js';
import { Strap, bluetoothSupport } from './ble.js';
import { SampleAggregator } from './hr.js';
import { db, loadSettings, saveSettings, uid } from './db.js';
import {
  matchMinute,
  matchPhase,
  elapsedLabel,
  clockTime,
  minuteToTime,
  sessionStats,
  displayTitle,
  recomputeGoals,
  goalColor,
  numberedMoments,
  tensionSeries,
  sessionEnd,
} from './analysis.js';
import { chartSvg, sparklineSvg } from './chart.js';
import { generateWriteup } from './ai.js';
import { renderSessionPng, shareOrDownload, exportFileName } from './export.js';
import { DEMOS } from './demo.js';

/* ---------------- Helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => ICONS[name] || '';
const fmtDur = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
};
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const PULSE_MARK =
  '<svg viewBox="0 0 30 20" fill="none" stroke="#3da5ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M1 11h6l3-8 5 15 4-10 2 3h8"/></svg>';
const TENSION_NOTE = "Tension is Pulse's estimate from heart rate and HRV, not WHOOP's Stress Monitor.";

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function buzz(ms = 25) {
  try {
    navigator.vibrate && navigator.vibrate(ms);
  } catch {
    /* ignore */
  }
}

/** Two-tap confirm for destructive buttons. */
function armButton(btn, armedText, onConfirm) {
  const original = btn.innerHTML;
  let timer;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('armed')) {
      clearTimeout(timer);
      btn.classList.remove('armed');
      btn.innerHTML = original;
      onConfirm();
      return;
    }
    btn.classList.add('armed');
    btn.textContent = armedText;
    buzz(15);
    timer = setTimeout(() => {
      btn.classList.remove('armed');
      btn.innerHTML = original;
    }, 3500);
  });
}

function showModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  return m;
}
function hideModal() {
  const m = $('#modal');
  m.hidden = true;
  m.innerHTML = '';
}

/* ---------------- State ---------------- */

const state = {
  settings: loadSettings(),
  strapStatus: 'idle',
  strapInfo: {},
  hr: null,
  live: null, // in-progress session
  undo: [],
  wakeLock: null,
  writeupBusy: new Set(),
  historyFilter: 'all',
  endDraft: null,
};

const support = bluetoothSupport();

const aggregator = new SampleAggregator((sample, isNew) => {
  state.hr = sample.hr;
  const live = state.live;
  if (live && !live.ended) {
    if (isNew) live.samples.push(sample);
    else live.samples[live.samples.length - 1] = sample;
  }
  onHrTick();
});

const strap = new Strap({
  onStatus: (status, info) => {
    state.strapStatus = status;
    state.strapInfo = info;
    if (status !== 'connected') state.hr = null;
    renderStrapBits();
  },
  onReading: (parsed, at) => aggregator.push(parsed, at),
});

// Treat a silent strap as no reading (stale HR display).
setInterval(() => {
  if (state.hr != null && Date.now() - strap.lastReadingAt > 6000) {
    state.hr = null;
    renderStrapBits();
  }
}, 2000);

async function connectStrap(showAll = false) {
  if (!support.ok) {
    toast(support.isIOS ? 'iPhone Safari has no Web Bluetooth.' : 'This browser has no Web Bluetooth.');
    return;
  }
  try {
    await strap.pick({ showAll });
  } catch (e) {
    if (e && e.name === 'NotFoundError') toast(showAll ? 'No device chosen.' : 'No strap found. Is Heart Rate Broadcast on?');
    else toast(e && e.message ? e.message : 'Could not connect');
  }
}

function strapLabel() {
  switch (state.strapStatus) {
    case 'connected':
      return strap.deviceName || 'Strap connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return `Reconnecting… (try ${state.strapInfo.attempt || 1})`;
    case 'disconnected':
      return 'Strap disconnected';
    default:
      return 'No strap connected';
  }
}

/* ---------------- Router ---------------- */

const routes = [
  [/^#?\/?$/, renderHome, 'home'],
  [/^#\/history$/, renderHistory, 'history'],
  [/^#\/settings$/, renderSettings, 'settings'],
  [/^#\/start\/(\w+)$/, renderStart, 'home'],
  [/^#\/live$/, renderLive, null],
  [/^#\/end$/, renderEnd, null],
  [/^#\/session\/([\w-]+)$/, renderSession, 'history'],
];

let cleanup = null;
async function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const hash = location.hash || '#/';
  for (const [re, fn, tab] of routes) {
    const m = hash.match(re);
    if (m) {
      $$('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
      document.body.classList.toggle('live', hash === '#/live' || hash === '#/end');
      window.scrollTo(0, 0);
      await fn(...m.slice(1));
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ---------------- Shared fragments ---------------- */

function strapCardHtml() {
  const unsupported = !support.ok;
  return `
  <div class="card strap" id="strapCard">
    <div class="bpm" id="strapBpm">--<small>bpm</small></div>
    <div class="info">
      <div><span class="dot ${state.strapStatus}" id="strapDot"></span><span id="strapText">${esc(strapLabel())}</span></div>
      <div class="small muted" id="strapSub">${unsupported ? 'Bluetooth not available in this browser' : 'WHOOP → Heart Rate Broadcast'}</div>
      ${
        unsupported
          ? ''
          : `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">
        <button class="btn small primary" data-act="connect">${state.strapStatus === 'connected' ? 'Change strap' : 'Connect strap'}</button>
        <button class="linkbtn small" data-act="connect-all">Show all devices</button>
      </div>`
      }
    </div>
  </div>`;
}

function bindStrapCard(root = view) {
  $$('[data-act="connect"]', root).forEach((b) => b.addEventListener('click', () => connectStrap(false)));
  $$('[data-act="connect-all"]', root).forEach((b) => b.addEventListener('click', () => connectStrap(true)));
}

function renderStrapBits() {
  const dot = $('#strapDot');
  if (dot) dot.className = `dot ${state.strapStatus}`;
  const txt = $('#strapText');
  if (txt) txt.textContent = strapLabel();
  const bpm = $('#strapBpm');
  if (bpm) bpm.innerHTML = `${state.hr ?? '--'}<small>bpm</small>`;
  const cbtn = $('[data-act="connect"]');
  if (cbtn) cbtn.textContent = state.strapStatus === 'connected' ? 'Change strap' : 'Connect strap';
  const pill = $('#livePill');
  if (pill) {
    pill.innerHTML = `<span class="dot ${state.strapStatus}"></span>${esc(
      state.strapStatus === 'connected' ? 'Live' : state.strapStatus === 'reconnecting' ? `Reconnecting (${state.strapInfo.attempt || 1})` : state.strapStatus === 'connecting' ? 'Connecting' : 'Connect strap',
    )}`;
  }
  const lb = $('#liveBpm');
  if (lb) lb.innerHTML = `${state.hr ?? '--'}<small>bpm</small>`;
}

function onHrTick() {
  renderStrapBits();
}

function bannerHtml() {
  if (support.ok) return '';
  if (support.isIOS) {
    return `<div class="banner warn"><b>iPhone / iPad can't connect.</b> Safari (and every iOS browser) has no Web Bluetooth, so Pulse can't read your strap here. Use Chrome on Android or a desktop computer. You can still explore the demo sessions.</div>`;
  }
  return `<div class="banner warn"><b>No Web Bluetooth in this browser.</b> Open Pulse in Chrome on Android (or desktop Chrome / Edge) to connect your strap. Demo sessions still work.</div>`;
}

function typeIcon(type) {
  return icon(SESSION_TYPES[type]?.icon || 'heart');
}

function sessionListHtml(list) {
  if (!list.length) return `<div class="empty">No sessions yet. Start one above, or load a demo in Settings.</div>`;
  const rest = state.settings.restingHr;
  return `<ul class="hist">${list
    .map((s) => {
      const st = s.statsCache || sessionStats(s, rest);
      return `<li><a href="#/session/${s.id}">
      <div class="ti">${typeIcon(s.type)}</div>
      <div class="main"><div class="name">${esc(displayTitle(s))}</div>
      <div class="meta">${fmtDate(s.startTs)} · ${clockTime(s.startTs)} · ${fmtDur(st.durationMs)}</div></div>
      <div class="spark">${sparklineSvg(s, 80, 28)}</div>
      <div class="nums"><div><span class="muted">avg</span> <b>${st.avgHr ?? '--'}</b></div><div><span class="muted">peak</span> <b>${st.peakHr ?? '--'}</b></div></div>
    </a></li>`;
    })
    .join('')}</ul>`;
}

/* ---------------- Home ---------------- */

async function renderHome() {
  const sessions = await db.allSessions();
  view.innerHTML = `
    <div class="topbar"><div class="brand grow">${PULSE_MARK}PULSE</div></div>
    ${bannerHtml()}
    ${strapCardHtml()}
    <div class="section-title"><h3>Start a session</h3></div>
    <div class="starts">
      ${Object.entries(SESSION_TYPES)
        .map(
          ([key, t]) => `<button class="startbtn" data-start="${key}"><div class="ico">${icon(t.icon)}</div>
          <div><b>${esc(t.label)}</b><span class="sub">${esc(t.defaultMode === 'watching' ? 'Watching' : 'Doing')} · e.g. ${esc(t.titleHint)}</span></div></button>`,
        )
        .join('')}
    </div>
    <div class="section-title"><h3>Recent sessions</h3>${sessions.length > 4 ? '<a href="#/history" class="small">See all</a>' : ''}</div>
    ${sessionListHtml(sessions.slice(0, 4))}
  `;
  bindStrapCard();
  renderStrapBits();
  $$('[data-start]').forEach((b) => b.addEventListener('click', () => go(`#/start/${b.dataset.start}`)));
}

/* ---------------- Start ---------------- */

function renderStart(typeKey) {
  const type = SESSION_TYPES[typeKey];
  if (!type) return go('#/');
  if (state.live && !state.live.ended) return go('#/live');
  let mode = type.defaultMode;
  let mine = 'home';
  view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/" aria-label="Back">${icon('back')}</a><h1 class="grow">${esc(type.label)}</h1></div>
    ${bannerHtml()}
    <div class="card">
      <label class="field"><span>Title</span><input type="text" id="fTitle" placeholder="${esc(type.titleHint)}" maxlength="80" autocomplete="off"/></label>
      <div class="field"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Are you watching or doing?</span>
        <div class="seg" id="fMode"><button data-v="watching">Watching</button><button data-v="doing">Doing</button></div></div>
      ${
        type.teams
          ? `<div class="row2" style="margin-top:14px">
          <label class="field"><span>Home team</span><input type="text" id="fHome" placeholder="Benfica" maxlength="30"/></label>
          <label class="field"><span>Away team</span><input type="text" id="fAway" placeholder="Porto" maxlength="30"/></label></div>
          <div class="field"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Which one is your team?</span>
          <div class="seg" id="fMine"><button data-v="home">Home</button><button data-v="away">Away</button><button data-v="none">Neither</button></div></div>`
          : ''
      }
    </div>
    ${strapCardHtml()}
    <button class="btn primary block" id="fGo" style="min-height:60px;font-size:17px">Start session</button>
    <p class="hint">Keep Pulse open and on screen during the session. Android can cut Bluetooth when Chrome is in the background.</p>
  `;
  bindStrapCard();
  renderStrapBits();
  const setSeg = (el, v) => $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  const modeEl = $('#fMode');
  setSeg(modeEl, mode);
  modeEl.addEventListener('click', (e) => {
    if (e.target.dataset.v) setSeg(modeEl, (mode = e.target.dataset.v));
  });
  const mineEl = $('#fMine');
  if (mineEl) {
    setSeg(mineEl, mine);
    mineEl.addEventListener('click', (e) => {
      if (e.target.dataset.v) setSeg(mineEl, (mine = e.target.dataset.v));
    });
    const autoTitle = () => {
      const h = $('#fHome').value.trim();
      const a = $('#fAway').value.trim();
      const t = $('#fTitle');
      if (!t.dataset.touched) t.value = h && a ? `${h} v ${a}` : '';
    };
    $('#fHome').addEventListener('input', autoTitle);
    $('#fAway').addEventListener('input', autoTitle);
    $('#fTitle').addEventListener('input', (e) => (e.target.dataset.touched = '1'));
  }
  $('#fGo').addEventListener('click', async () => {
    const title = $('#fTitle').value.trim() || type.titleHint;
    const s = {
      id: uid(),
      type: typeKey,
      title,
      mode,
      startTs: Date.now(),
      endTs: null,
      restingHr: state.settings.restingHr,
      samples: [],
      tags: [],
      bands: [],
      notes: '',
      writeup: null,
    };
    if (type.teams) {
      s.teams = { home: $('#fHome').value.trim() || 'Home', away: $('#fAway').value.trim() || 'Away', mine: mine === 'none' ? null : mine };
      s.score = { home: 0, away: 0 };
      s.phases = {};
      if (!$('#fTitle').value.trim()) s.title = `${s.teams.home} v ${s.teams.away}`;
    }
    state.live = s;
    state.undo = [];
    await db.saveLive(s);
    go('#/live');
  });
}

/* ---------------- Live ---------------- */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
    }
  } catch {
    /* not allowed (e.g. battery saver) */
  }
}
function releaseWakeLock() {
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.live && !state.live.ended && location.hash === '#/live') requestWakeLock();
    strap.retryNow();
  } else if (state.live) {
    db.saveLive(state.live).catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  if (state.live) db.saveLive(state.live).catch(() => {});
});

function nextPhase(s) {
  const phases = SESSION_TYPES[s.type].phases || [];
  return phases.find((p) => !(s.phases || {})[p.key]) || null;
}

function openBand(s) {
  return (s.bands || []).find((b) => !b.end);
}

function liveClock(s, now) {
  const type = SESSION_TYPES[s.type];
  if (type.clock === 'match') {
    const mm = matchMinute(s, now);
    const ph = matchPhase(s, now);
    const p = s.phases || {};
    let sub = 'Pre-match · ' + elapsedLabel(now - s.startTs);
    if (ph === 'first') sub = '1st half · ' + elapsedLabel(now - p.kickoff);
    else if (ph === 'ht') sub = 'Half-time · ' + elapsedLabel(now - p.halftime);
    else if (ph === 'second') sub = '2nd half · ' + elapsedLabel(now - p.secondhalf + 45 * 60000);
    else if (ph === 'ft') sub = 'Full time';
    return { big: mm === 'Pre' ? '–' : mm, sub };
  }
  return { big: elapsedLabel(now - s.startTs), sub: `Started ${clockTime(s.startTs)}` };
}

function addTag(def, extra = {}) {
  const s = state.live;
  if (!s) return;
  const t = extra.t || Date.now();
  const tag = { id: uid(), t, key: def.key, label: extra.label || def.label, color: def.color || FREE_TAG.color };
  if (def.team) {
    tag.team = def.team;
    s.tags.push(tag);
    recomputeGoals(s);
  } else s.tags.push(tag);
  state.undo.push({ kind: 'tag', id: tag.id });
  buzz(30);
  const when = SESSION_TYPES[s.type].clock === 'match' ? matchMinute(s, t) : elapsedLabel(t - s.startTs);
  toast(`${tag.label} · ${when}`);
  db.saveLive(s).catch(() => {});
  refreshLive(true);
}

function renderLive() {
  const s = state.live;
  if (!s) return go('#/');
  if (s.ended) return go('#/end');
  const type = SESSION_TYPES[s.type];
  requestWakeLock();

  const tagButtons = type.tags
    .map((d) => {
      if (d.team) {
        return `<button class="tagbtn big" data-tag="${d.key}"><span class="sw" style="background:${goalColor(s, d.team)}"></span>Goal ${esc(s.teams[d.team])}</button>`;
      }
      return `<button class="tagbtn" data-tag="${d.key}"><span class="sw" style="background:${d.color}"></span>${esc(d.label)}</button>`;
    })
    .join('');

  view.innerHTML = `
    <div class="live-head">
      <button class="pill" id="livePill"></button>
      <div class="live-title">${esc(s.title)}</div>
    </div>
    <div class="live-main">
      <div><div class="live-bpm" id="liveBpm">--<small>bpm</small></div>
      <div class="tension-chip" id="liveTension">Tension –</div></div>
      <div class="live-clock"><div class="big" id="liveClock">0:00</div><div class="sub" id="liveClockSub"></div></div>
    </div>
    ${
      type.teams
        ? `<div class="score"><span class="team home ${s.teams.mine === 'home' ? 'mine' : ''}">${esc(s.teams.home)}</span><span class="goals" id="liveScore">0–0</span><span class="team ${s.teams.mine === 'away' ? 'mine' : ''}">${esc(s.teams.away)}</span></div>`
        : ''
    }
    <div class="card tight"><div class="chartbox" id="liveChart"></div>
      <div class="key"><span><i style="background:${COLORS.hr}"></i>Heart rate</span><span><i style="background:${COLORS.tension}"></i>Tension (0–3)</span></div>
    </div>
    <div class="ctrl">
      ${type.phases ? `<button class="btn block" id="phaseBtn" style="min-height:60px;font-size:17px"></button>` : ''}
      ${type.toggle ? `<button class="btn block togglebtn" id="toggleBtn" style="min-height:60px;font-size:17px;color:${type.toggle.color}"></button>` : ''}
    </div>
    <div class="tags">${tagButtons}</div>
    <form class="freetag" id="freeForm"><input type="text" id="freeText" placeholder="Something else… (free text)" maxlength="60" autocomplete="off"/><button class="btn" type="submit">Tag</button></form>
    <div class="live-foot">
      <button class="btn" id="undoBtn">Undo last</button>
      <button class="btn danger" id="endBtn">End session</button>
    </div>
    <p class="hint">Keep Pulse open and on screen. Android can cut Bluetooth when Chrome is in the background. The screen stays on during a session.</p>
    <p class="note-estimate" style="text-align:center">${TENSION_NOTE}</p>
  `;

  $('#livePill').addEventListener('click', () => {
    if (state.strapStatus !== 'connected') connectStrap(false);
  });
  $$('[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const def = type.tags.find((d) => d.key === b.dataset.tag);
      addTag(def);
    }),
  );
  $('#freeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#freeText').value.trim();
    if (!v) return;
    addTag(FREE_TAG, { label: v });
    $('#freeText').value = '';
    $('#freeText').blur();
  });
  const phaseBtn = $('#phaseBtn');
  if (phaseBtn) {
    phaseBtn.addEventListener('click', () => {
      const np = nextPhase(s);
      if (!np) return;
      s.phases[np.key] = Date.now();
      state.undo.push({ kind: 'phase', key: np.key });
      buzz(40);
      toast(np.label);
      db.saveLive(s).catch(() => {});
      refreshLive(true);
    });
  }
  const toggleBtn = $('#toggleBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const ob = openBand(s);
      if (ob) ob.end = Date.now();
      else {
        s.bands.push({ key: type.toggle.key, label: type.toggle.label, color: type.toggle.color, start: Date.now(), end: null });
        state.undo.push({ kind: 'band' });
      }
      buzz(30);
      db.saveLive(s).catch(() => {});
      refreshLive(true);
    });
  }
  $('#undoBtn').addEventListener('click', () => {
    const last = state.undo.pop();
    if (!last) {
      // after a resume there is no undo stack: undo the latest tag
      const lt = [...s.tags].sort((a, b) => b.t - a.t)[0];
      if (!lt) return toast('Nothing to undo');
      s.tags = s.tags.filter((g) => g !== lt);
      recomputeGoals(s);
      toast(`Removed: ${lt.label}`);
    } else if (last.kind === 'tag') {
      const g = s.tags.find((x) => x.id === last.id);
      s.tags = s.tags.filter((x) => x.id !== last.id);
      recomputeGoals(s);
      toast(`Removed: ${g ? g.label : 'tag'}`);
    } else if (last.kind === 'phase') {
      delete s.phases[last.key];
      toast('Phase undone');
    } else if (last.kind === 'band') {
      const b = s.bands.pop();
      toast(`Removed: ${b ? b.label : 'band'}`);
    }
    db.saveLive(s).catch(() => {});
    refreshLive(true);
  });
  armButton($('#endBtn'), 'Tap again to end', () => {
    const now = Date.now();
    s.endTs = now;
    const ob = openBand(s);
    if (ob) ob.end = now;
    s.ended = true;
    db.saveLive(s).catch(() => {});
    releaseWakeLock();
    go('#/end');
  });

  refreshLive(true);
  renderStrapBits();
  const tick = setInterval(() => refreshLive(false), 1000);
  const chartTick = setInterval(() => refreshLive(true), 5000);
  const autosave = setInterval(() => db.saveLive(s).catch(() => {}), 5000);
  const ro = new ResizeObserver(() => drawLiveChart());
  ro.observe($('#liveChart'));
  cleanup = () => {
    clearInterval(tick);
    clearInterval(chartTick);
    clearInterval(autosave);
    ro.disconnect();
    db.saveLive(s).catch(() => {});
  };
}

let lastChartW = 0;
function drawLiveChart() {
  const box = $('#liveChart');
  if (!box || !state.live) return;
  const w = Math.floor(box.clientWidth);
  if (!w) return;
  lastChartW = w;
  const h = w < 500 ? 220 : 280;
  box.innerHTML = chartSvg(state.live, w, h, { restingHr: state.settings.restingHr, now: Date.now() });
}

function refreshLive(withChart) {
  const s = state.live;
  if (!s || !$('#liveClock')) return;
  const now = Date.now();
  const c = liveClock(s, now);
  $('#liveClock').textContent = c.big;
  $('#liveClockSub').textContent = c.sub;
  if (s.score && $('#liveScore')) $('#liveScore').textContent = `${s.score.home}–${s.score.away}`;
  const pb = $('#phaseBtn');
  if (pb) {
    const np = nextPhase(s);
    pb.textContent = np ? `▶ ${np.button}` : 'Full time ✓';
    pb.disabled = !np;
    pb.classList.toggle('primary', !!np && np.key === 'kickoff');
  }
  const tb = $('#toggleBtn');
  if (tb) {
    const ob = openBand(s);
    const t = SESSION_TYPES[s.type].toggle;
    tb.classList.toggle('on', !!ob);
    tb.textContent = ob ? `■ ${t.label} · ${elapsedLabel(now - ob.start)} (tap to stop)` : `● ${t.button}`;
  }
  if (withChart) {
    drawLiveChart();
    const ten = tensionSeries(s, state.settings.restingHr).series.filter((p) => p.value != null);
    const last = ten[ten.length - 1];
    $('#liveTension').textContent = last ? `Tension ${last.value.toFixed(1)}` : 'Tension –';
  }
}

/* ---------------- End: "What happened?" ---------------- */

function renderEnd() {
  const s = state.live;
  if (!s) return go('#/');
  if (!s.ended) return go('#/live');
  const type = SESSION_TYPES[s.type];
  const rest = state.settings.restingHr;
  const st = sessionStats(s, rest);
  const tagDefs = [...type.tags, FREE_TAG];
  const isMatch = type.clock === 'match';

  view.innerHTML = `
    <div class="topbar"><h1 class="grow">What happened?</h1></div>
    <p class="muted" style="margin-top:-6px">${esc(displayTitle(s))} · ${fmtDur(st.durationMs)}</p>
    <div class="card">
      <h3 style="margin-bottom:10px">Quick stats</h3>
      <div class="stats">
        <div class="stat"><div class="v">${fmtDur(st.durationMs)}</div><div class="k">Duration</div></div>
        <div class="stat"><div class="v">${st.avgHr ?? '--'}<small>bpm</small></div><div class="k">Average HR</div></div>
        <div class="stat"><div class="v">${st.peakHr ?? '--'}<small>bpm</small></div><div class="k">Peak HR${st.peakT ? ' · ' + esc(isMatch ? matchMinute(s, st.peakT) : clockTime(st.peakT)) : ''}</div>${st.peakContext ? `<div class="ctx">During: ${esc(st.peakContext)}</div>` : ''}</div>
        <div class="stat"><div class="v">${fmtDur(st.aboveCalmMs)}</div><div class="k">Above calm (&gt;${st.calmCeiling} bpm)</div></div>
      </div>
    </div>
    <div class="card">
      <label class="field" style="margin:0"><span>Describe it in your own words</span>
      <textarea id="eNotes" placeholder="${esc(isMatch ? 'How did it feel? What were the big moments?' : 'What happened? How did it feel?')}">${esc(s.notes || '')}</textarea></label>
    </div>
    <div class="card">
      <h3>Add a moment you forgot to tag</h3>
      <div class="row3" style="margin-top:10px">
        <input type="text" id="eMin" inputmode="${isMatch ? 'text' : 'numeric'}" placeholder="${isMatch ? "67 / 45+2" : 'min'}" aria-label="${isMatch ? 'Match minute' : 'Minutes from start'}"/>
        <select id="eKind" aria-label="Kind">${tagDefs
          .map((d) => `<option value="${d.key}">${esc(d.team ? `Goal ${s.teams[d.team]}` : d.key === 'free' ? 'Other (type below)' : d.label)}</option>`)
          .join('')}</select>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="eLabel" placeholder="Label (optional)" maxlength="60"/><button class="btn" id="eAdd">Add</button></div>
      <p class="small muted" style="margin:8px 0 0">${isMatch ? 'Match minute, e.g. 67 or 90+3.' : 'Minutes after the start, e.g. 12.'}</p>
      <ul class="added" id="eList"></ul>
    </div>
    <button class="btn primary block" id="eSave" style="min-height:60px;font-size:17px">Save & get write-up</button>
    <div style="display:flex;justify-content:space-between;margin-top:10px">
      <button class="linkbtn" id="eResume">← Back to live</button>
      <button class="linkbtn" id="eDiscard" style="color:var(--theirs)">Discard session</button>
    </div>
  `;

  const renderAdded = () => {
    const manual = s.tags.filter((g) => g.manual);
    $('#eList').innerHTML = manual
      .map(
        (g) =>
          `<li><span class="dot" style="background:${g.color}"></span><b class="num" style="font-size:16px">${esc(isMatch ? matchMinute(s, g.t) : elapsedLabel(g.t - s.startTs))}</b> ${esc(g.label)} <button class="linkbtn" data-rm="${g.id}" style="margin-left:auto">Remove</button></li>`,
      )
      .join('');
    $$('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        s.tags = s.tags.filter((g) => g.id !== b.dataset.rm);
        recomputeGoals(s);
        db.saveLive(s).catch(() => {});
        renderAdded();
      }),
    );
  };
  renderAdded();

  $('#eNotes').addEventListener('input', (e) => {
    s.notes = e.target.value;
  });
  $('#eAdd').addEventListener('click', () => {
    const t = minuteToTime(s, $('#eMin').value);
    if (t == null) return toast(isMatch ? 'Enter a minute like 67 or 45+2' : 'Enter minutes from the start');
    const def = tagDefs.find((d) => d.key === $('#eKind').value);
    const label = $('#eLabel').value.trim() || (def.key === 'free' ? 'Note' : def.label);
    const tag = { id: uid(), t, key: def.key, label, color: def.color || FREE_TAG.color, manual: true };
    if (def.team) {
      tag.team = def.team;
    }
    s.tags.push(tag);
    recomputeGoals(s);
    db.saveLive(s).catch(() => {});
    $('#eMin').value = '';
    $('#eLabel').value = '';
    renderAdded();
    toast('Moment added');
  });
  $('#eResume').addEventListener('click', () => {
    s.ended = false;
    s.endTs = null;
    go('#/live');
  });
  armButton($('#eDiscard'), 'Tap again to discard', async () => {
    state.live = null;
    await db.clearLive();
    go('#/');
  });
  $('#eSave').addEventListener('click', async () => {
    s.notes = $('#eNotes').value.trim();
    const saved = finalize(s);
    await db.saveSession(saved);
    await db.clearLive();
    state.live = null;
    runWriteup(saved.id, true);
    go(`#/session/${saved.id}`);
  });
}

function finalize(s) {
  const out = { ...s };
  delete out.ended;
  out.restingHr = state.settings.restingHr;
  out.endTs = s.endTs || Date.now();
  recomputeGoals(out);
  return out;
}

/* ---------------- Session detail ---------------- */

async function renderSession(id) {
  const s = await db.getSession(id);
  if (!s) {
    view.innerHTML = `<div class="topbar"><a class="iconbtn" href="#/history">${icon('back')}</a><h1>Not found</h1></div>`;
    return;
  }
  const type = SESSION_TYPES[s.type];
  const rest = state.settings.restingHr;
  const st = sessionStats(s, rest);
  const moments = numberedMoments(s);
  const end = sessionEnd(s);

  view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/history" aria-label="Back">${icon('back')}</a>
      <div class="grow"><div class="small muted">${esc(type.label)} · ${s.mode === 'doing' ? 'Doing' : 'Watching'}${s.demo ? ' · Demo' : ''}</div>
      <h1 style="font-size:26px">${esc(displayTitle(s))}</h1></div></div>
    <p class="muted" style="margin:-8px 0 12px">${new Date(s.startTs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${clockTime(s.startTs)}–${clockTime(end)}</p>
    <div class="card tight"><div class="chartbox" id="dChart"></div>
      <div class="key"><span><i style="background:${COLORS.hr}"></i>Heart rate (10 s avg)</span><span><i style="background:${COLORS.tension}"></i>Tension (0–3)</span></div>
      <p class="note-estimate">${TENSION_NOTE}</p>
      ${
        moments.length
          ? `<ul class="legend">${moments
              .map((m) => `<li><span class="n" style="background:${m.color}">${m.n}</span><span class="t">${esc(m.timeLabel)}</span><span>${esc(m.label)}</span></li>`)
              .join('')}</ul>`
          : '<p class="small muted">No tagged moments.</p>'
      }
    </div>
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><div class="v">${fmtDur(st.durationMs)}</div><div class="k">Duration</div></div>
      <div class="stat"><div class="v">${st.avgHr ?? '--'}<small>bpm</small></div><div class="k">Average HR</div></div>
      <div class="stat"><div class="v">${st.peakHr ?? '--'}<small>bpm</small></div><div class="k">Peak HR</div>${st.peakContext ? `<div class="ctx">${esc(st.peakContext)}</div>` : ''}</div>
      <div class="stat"><div class="v">${fmtDur(st.aboveCalmMs)}</div><div class="k">Above calm (&gt;${st.calmCeiling})</div></div>
    </div>
    <div class="card"><h3 style="margin-bottom:10px">AI write-up</h3><div id="wBody" class="writeup"></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn small" id="wRegen">Regenerate</button></div></div>
    <div class="card"><h3 style="margin-bottom:8px">My notes</h3>
      <textarea id="dNotes" placeholder="Add notes…">${esc(s.notes || '')}</textarea>
      <button class="btn small" id="dSaveNotes" style="margin-top:8px">Save notes</button></div>
    <div style="display:grid;gap:8px">
      <button class="btn primary block" id="dShare">${icon('share')} Share chart</button>
      <button class="btn danger block" id="dDelete">Delete session</button>
    </div>
  `;

  const drawDetail = () => {
    const box = $('#dChart');
    if (!box) return;
    const w = Math.floor(box.clientWidth);
    if (!w) return;
    box.innerHTML = chartSvg(s, w, w < 500 ? 280 : 380, { restingHr: rest });
  };
  drawDetail();
  const ro = new ResizeObserver(drawDetail);
  ro.observe($('#dChart'));
  cleanup = () => ro.disconnect();

  renderWriteupBody(s);
  $('#wRegen').addEventListener('click', () => runWriteup(s.id, false));
  $('#dSaveNotes').addEventListener('click', async () => {
    const fresh = await db.getSession(s.id);
    fresh.notes = $('#dNotes').value.trim();
    await db.saveSession(fresh);
    s.notes = fresh.notes;
    toast('Notes saved');
  });
  $('#dShare').addEventListener('click', async () => {
    const btn = $('#dShare');
    btn.disabled = true;
    try {
      const blob = await renderSessionPng(s, rest);
      const res = await shareOrDownload(blob, exportFileName(s), displayTitle(s));
      if (res === 'downloaded') toast('Image saved to Downloads');
    } catch (e) {
      toast('Could not create image: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  armButton($('#dDelete'), 'Tap again to delete', async () => {
    await db.deleteSession(s.id);
    toast('Session deleted');
    go('#/history');
  });
}

function renderWriteupBody(s) {
  const el = $('#wBody');
  if (!el) return;
  const regen = $('#wRegen');
  if (state.writeupBusy.has(s.id)) {
    el.innerHTML = '<p class="muted" style="font-family:var(--txt);font-size:15px;font-weight:400"><span class="spinner"></span>Writing your recap…</p>';
    if (regen) regen.disabled = true;
    return;
  }
  if (regen) regen.disabled = false;
  if (s.writeupError) {
    el.innerHTML = `<p class="error" style="font-family:var(--txt);font-size:15px;font-weight:400">${esc(s.writeupError)}</p>${
      s.writeupErrorKind === 'nokey' || s.writeupErrorKind === 'auth' ? '<a href="#/settings" class="btn small">Open Settings</a>' : ''
    }`;
    return;
  }
  if (s.writeup && s.writeup.text) {
    el.innerHTML =
      s.writeup.text
        .split(/\n\s*\n/)
        .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('') + `<p class="small muted" style="font-family:var(--txt);font-size:12px;font-weight:400">Written by ${esc(s.writeup.model)} · ${new Date(s.writeup.createdAt).toLocaleString()}</p>`;
    if (regen) regen.textContent = 'Regenerate';
    return;
  }
  el.innerHTML = `<p class="muted" style="font-family:var(--txt);font-size:15px;font-weight:400">${
    state.settings.apiKey ? 'No write-up yet.' : 'Add your Anthropic API key in Settings to get an AI write-up of this session.'
  }</p>`;
  if (regen) regen.textContent = 'Generate write-up';
}

async function runWriteup(id, auto) {
  if (state.writeupBusy.has(id)) return;
  const s = await db.getSession(id);
  if (!s) return;
  if (auto && !state.settings.apiKey) {
    renderWriteupBody(s);
    return;
  }
  state.writeupBusy.add(id);
  renderWriteupBody(s);
  try {
    const w = await generateWriteup(s, state.settings);
    const fresh = await db.getSession(id);
    fresh.writeup = w;
    delete fresh.writeupError;
    delete fresh.writeupErrorKind;
    await db.saveSession(fresh);
    state.writeupBusy.delete(id);
    if (location.hash === `#/session/${id}`) renderWriteupBody(fresh);
  } catch (e) {
    const fresh = (await db.getSession(id)) || s;
    state.writeupBusy.delete(id);
    // keep any previous write-up; show the error alongside
    const shown = { ...fresh, writeupError: e.message, writeupErrorKind: e.kind };
    if (!fresh.writeup) {
      fresh.writeupError = e.message;
      fresh.writeupErrorKind = e.kind;
      await db.saveSession(fresh);
      if (location.hash === `#/session/${id}`) renderWriteupBody(shown);
    } else {
      toast(e.message);
      if (location.hash === `#/session/${id}`) renderWriteupBody(fresh);
    }
  }
}

/* ---------------- History ---------------- */

async function renderHistory() {
  const all = await db.allSessions();
  const rest = state.settings.restingHr;
  for (const s of all) s.statsCache = sessionStats(s, rest);
  const f = state.historyFilter;
  const list = f === 'all' ? all : all.filter((s) => s.type === f);

  // Comparison: average peak HR and average tension per type
  const byType = Object.keys(SESSION_TYPES)
    .map((k) => {
      const ss = all.filter((s) => s.type === k && s.statsCache.peakHr);
      if (!ss.length) return null;
      const avgPeak = Math.round(ss.reduce((a, s) => a + s.statsCache.peakHr, 0) / ss.length);
      const ts = ss.filter((s) => s.statsCache.avgTension != null);
      const avgTen = ts.length ? ts.reduce((a, s) => a + s.statsCache.avgTension, 0) / ts.length : null;
      return { k, label: SESSION_TYPES[k].label, n: ss.length, avgPeak, avgTen };
    })
    .filter(Boolean);
  const maxPeak = Math.max(1, ...byType.map((x) => x.avgPeak));
  let compareHtml = '';
  if (byType.length >= 2) {
    const sorted = [...byType].sort((a, b) => b.avgPeak - a.avgPeak);
    compareHtml = `<div class="card compare"><h3>Average peak heart rate</h3>
      ${byType
        .map(
          (x) => `<div class="rowc"><span>${esc(x.label)} <span class="muted small">(${x.n})</span></span>
          <div><div class="bar" style="width:${Math.round((x.avgPeak / maxPeak) * 100)}%"></div></div><span class="num">${x.avgPeak}</span></div>`,
        )
        .join('')}
      <p class="small muted" style="margin:6px 0 0">Your average peak is highest when ${esc(sorted[0].label.toLowerCase())} (${sorted[0].avgPeak} bpm) vs ${esc(
        sorted[sorted.length - 1].label.toLowerCase(),
      )} (${sorted[sorted.length - 1].avgPeak} bpm).${
        byType.every((x) => x.avgTen != null)
          ? ' Average tension: ' + byType.map((x) => `${x.label.toLowerCase()} ${x.avgTen.toFixed(1)}`).join(', ') + '.'
          : ''
      }</p></div>`;
  }

  view.innerHTML = `
    <div class="topbar"><h1 class="grow">History</h1></div>
    <div class="chips" id="chips">
      <button class="chip ${f === 'all' ? 'on' : ''}" data-f="all">All</button>
      ${Object.entries(SESSION_TYPES)
        .map(([k, t]) => `<button class="chip ${f === k ? 'on' : ''}" data-f="${k}">${esc(t.short || t.label)}</button>`)
        .join('')}
    </div>
    ${compareHtml}
    ${sessionListHtml(list)}
  `;
  $$('#chips [data-f]').forEach((b) =>
    b.addEventListener('click', () => {
      state.historyFilter = b.dataset.f;
      renderHistory();
    }),
  );
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  const st = state.settings;
  view.innerHTML = `
    <div class="topbar"><h1 class="grow">Settings</h1></div>
    <div class="card">
      <label class="field"><span>Resting heart rate (copy it from WHOOP)</span>
        <input type="number" id="sRest" min="30" max="120" inputmode="numeric" value="${esc(st.restingHr)}"/></label>
      <p class="small muted" style="margin:-6px 0 0">Used for tension and your "calm" zone (resting + 15 bpm).</p>
    </div>
    <div class="card">
      <h3 style="margin-bottom:10px">AI write-up</h3>
      <label class="field"><span>Anthropic API key</span>
        <div style="display:flex;gap:8px"><input type="password" id="sKey" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" value="${esc(st.apiKey)}"/>
        <button class="btn small" id="sShow" type="button">Show</button></div></label>
      <div class="banner info small" style="margin-bottom:12px">🔒 Your key is stored only on this device (in this browser) and is sent only to api.anthropic.com when you ask for a write-up. Each write-up costs a small amount on your Anthropic account (typically around one US cent). Get a key at console.anthropic.com.</div>
      <label class="field" style="margin:0"><span>AI model</span><input type="text" id="sModel" value="${esc(st.model)}" spellcheck="false" autocomplete="off"/></label>
    </div>
    <button class="btn primary block" id="sSave">Save settings</button>

    <div class="section-title"><h3>Demo sessions</h3></div>
    <div class="card">
      <p class="small muted" style="margin-top:0">Realistic sample sessions so you can see the full flow without the strap.</p>
      <div style="display:grid;gap:8px">
        ${Object.entries(SESSION_TYPES)
          .filter(([k]) => DEMOS[k])
          .map(([k, t]) => `<button class="btn block" data-demo="${k}">${icon(t.icon)} Load ${esc(t.label.toLowerCase())} demo</button>`)
          .join('')}
      </div>
    </div>

    <div class="section-title"><h3>Your data</h3></div>
    <div class="card" style="display:grid;gap:8px">
      <button class="btn block" id="sExport">Export all data (JSON)</button>
      <button class="btn danger block" id="sClear">Clear all data</button>
      <p class="small muted" style="margin:4px 0 0">Everything lives on this device only (IndexedDB). Nothing is uploaded.</p>
    </div>
    <p class="note-estimate">${TENSION_NOTE}</p>
    <p class="small muted">Pulse · <a href="https://github.com/joelmadeira26/stress-tracking-whoop">source</a></p>
  `;
  $('#sShow').addEventListener('click', () => {
    const k = $('#sKey');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#sShow').textContent = k.type === 'password' ? 'Show' : 'Hide';
  });
  $('#sSave').addEventListener('click', () => {
    const rest = parseInt($('#sRest').value, 10);
    if (!(rest >= 30 && rest <= 120)) return toast('Resting HR should be between 30 and 120');
    state.settings = {
      ...state.settings,
      restingHr: rest,
      apiKey: $('#sKey').value.trim(),
      model: $('#sModel').value.trim() || 'claude-sonnet-5-5',
    };
    saveSettings(state.settings);
    toast('Settings saved');
  });
  $$('[data-demo]').forEach((b) =>
    b.addEventListener('click', async () => {
      const s = DEMOS[b.dataset.demo](state.settings.restingHr);
      await db.saveSession(s);
      toast('Demo loaded');
      go(`#/session/${s.id}`);
    }),
  );
  $('#sExport').addEventListener('click', async () => {
    const all = await db.allSessions();
    const settings = { ...state.settings, apiKey: state.settings.apiKey ? '(not exported)' : '' };
    const blob = new Blob([JSON.stringify({ app: 'Pulse', exportedAt: new Date().toISOString(), settings, sessions: all }, null, 1)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pulse-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  armButton($('#sClear'), 'Tap again to delete everything', async () => {
    await db.clearSessions();
    await db.clearLive();
    state.live = null;
    toast('All sessions deleted');
    renderSettings();
  });
}

/* ---------------- Boot ---------------- */

$$('#tabbar [data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

async function boot() {
  let live = null;
  try {
    live = await db.getLive();
  } catch {
    /* IndexedDB unavailable */
  }
  if (live) {
    state.live = live;
    if (live.ended) {
      if (location.hash !== '#/end') location.hash = '#/end';
    } else {
      const m = showModal(`
        <h2>Resume your session?</h2>
        <p class="muted">"${esc(live.title)}" started at ${clockTime(live.startTs)} (${fmtDur(Date.now() - live.startTs)} ago) with ${live.samples.length} heart-rate readings and ${live.tags.length} moments saved.</p>
        <div class="actions">
          <button class="btn primary" data-r="resume">Resume</button>
          <button class="btn" data-r="end">End it and review</button>
          <button class="btn danger" data-r="discard">Discard</button>
        </div>`);
      m.addEventListener('click', async (e) => {
        const r = e.target.closest('[data-r]')?.dataset.r;
        if (!r) return;
        hideModal();
        if (r === 'resume') go('#/live');
        else if (r === 'end') {
          live.ended = true;
          live.endTs = live.samples.length ? live.samples[live.samples.length - 1].t : Date.now();
          const ob = openBand(live);
          if (ob) ob.end = live.endTs;
          await db.saveLive(live);
          go('#/end');
        } else {
          state.live = null;
          await db.clearLive();
          go('#/');
        }
      });
    }
  } else if (location.hash === '#/live' || location.hash === '#/end') {
    location.hash = '#/';
  }
  route();
}
boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for automated tests / debugging.
window.__pulse = { state, strap, db, aggregator };
