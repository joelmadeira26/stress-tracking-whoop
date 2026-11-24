// Pulse — UI, routing and live-session logic.
import { SESSION_TYPES, typeOf, FREE_TAG, ICONS, COLORS, CATEGORIES, REACTIONS, COMPETITIONS, DEFAULT_FOLLOW, TEAM_SEARCH_LEAGUES } from './config.js';
import { Strap, bluetoothSupport } from './ble.js';
import { SampleAggregator } from './hr.js';
import { db, loadSettings, saveSettings, loadFollow, saveFollow, uid } from './db.js';
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
  applyFeed,
  applyAuto,
  detectReactions,
  meetingStress,
  configureAnalysis,
  personalScale,
  dataQuality,
  deskBaseline,
  peopleEffects,
  scoreDayMeetings,
  legendCategories,
  parseMatchClock,
  MAX_DELAY_MS,
} from './analysis.js';
import { chartSvg, sparklineSvg } from './chart.js';
import { generateWriteup } from './ai.js';
import { renderMeetingBoard, renderShareImage, SHARE_FORMATS, buildCaption, shareOrDownload, downloadBlob, exportFileName, chartHeading, storyLine } from './export.js';
import { DEMOS, demoMeetingWeek } from './demo.js';
import { loadFixtures, syncEvent, searchableTeams, currentDrivers, configureFeeds, backupLiveScore } from './feeds.js';
import * as whoop from './whoop.js';
import { hashPin, checkPin, isUnlocked, markUnlocked, biometricAvailable, registerBiometric, verifyBiometric } from './lock.js';
import { buildIcs, fixtureToEvent } from './ics.js';
import { calendarEvents, isConnected as gcalConnected, disconnect as gcalDisconnect } from './gcal.js';

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
  '<svg viewBox="0 0 30 20" fill="none" stroke="#8ab8ea" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M1 11h6l3-8 5 15 4-10 2 3h8"/></svg>';
const STRESS_NOTE = "Stress is Pulse's estimate from heart rate and HRV, not WHOOP's Stress Monitor.";
const img = (src, cls = 'crest', alt = '') =>
  src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
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
  m.onclick = (e) => {
    if (e.target === m) hideModal();
  };
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
  follow: loadFollow(DEFAULT_FOLLOW),
  strapStatus: 'idle',
  strapInfo: {},
  hr: null,
  live: null,
  undo: [],
  wakeLock: null,
  writeupBusy: new Set(),
  historyFilter: 'all',
  fixtures: null,
  fixturesAt: 0,
  feedStatus: { ok: null, at: 0, msg: '' },
};

const support = bluetoothSupport();

const aggregator = new SampleAggregator((sample, isNew) => {
  state.hr = sample.hr;
  const live = state.live;
  if (live && !live.ended) {
    if (isNew) live.samples.push(sample);
    else live.samples[live.samples.length - 1] = sample;
  }
  renderStrapBits();
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
      return 'Strap not connected';
  }
}

/* ---------------- Router ---------------- */

const routes = [
  [/^#?\/?$/, renderHome, 'home'],
  [/^#\/history$/, renderHistory, 'history'],
  [/^#\/following$/, renderFollowing, 'following'],
  [/^#\/settings$/, renderSettings, 'settings'],
  [/^#\/meetings$/, renderMeetings, 'home'],
  [/^#\/whoop(\?.*)?$/, renderWhoopCallback, 'settings'],
  [/^#\/start\/(\w+)$/, renderStart, 'home'],
  [/^#\/live$/, renderLive, null],
  [/^#\/end$/, renderEnd, null],
  [/^#\/session\/([\w-]+)$/, renderSession, 'history'],
];

let cleanup = null;
let routeSeq = 0; // async screens draw only if they are still the current one
async function route() {
  routeSeq++;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  hideModal();
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

/* ---------------- Strap bits ---------------- */

function strapChipHtml() {
  return `<button class="strapchip" id="strapChip" aria-label="Heart-rate strap"><span class="dot ${state.strapStatus}" id="strapDot"></span><span id="strapChipText"></span></button>`;
}

function bindStrapChip() {
  const c = $('#strapChip');
  if (!c) return;
  c.addEventListener('click', () => {
    if (!support.ok) return toast(support.isIOS ? 'iPhone Safari has no Web Bluetooth' : 'No Web Bluetooth in this browser');
    showModal(`
      <h2>Heart-rate strap</h2>
      <p class="muted">${esc(strapLabel())}${state.hr ? ` · ${state.hr} bpm` : ''}</p>
      <p class="small muted">On WHOOP: Device settings → <b>Heart Rate Broadcast</b> on. Keep Pulse open and on screen during a session.</p>
      <div class="actions">
        <button class="btn primary" data-s="pick">${state.strapStatus === 'connected' ? 'Change strap' : 'Connect strap'}</button>
        <button class="btn" data-s="all">Show all devices</button>
        ${state.strapStatus === 'connected' ? '<button class="btn ghost" data-s="off">Disconnect</button>' : ''}
      </div>`).addEventListener('click', (e) => {
      const s = e.target.closest('[data-s]')?.dataset.s;
      if (!s) return;
      hideModal();
      if (s === 'pick') connectStrap(false);
      else if (s === 'all') connectStrap(true);
      else strap.disconnect();
    });
  });
}

function renderStrapBits() {
  const dot = $('#strapDot');
  if (dot) dot.className = `dot ${state.strapStatus}`;
  const ct = $('#strapChipText');
  if (ct) ct.textContent = state.strapStatus === 'connected' ? (state.hr ? `${state.hr} bpm` : 'Strap on') : state.strapStatus === 'reconnecting' || state.strapStatus === 'connecting' ? 'Connecting…' : 'Connect strap';
  const pill = $('#livePill');
  if (pill) {
    pill.innerHTML = `<span class="dot ${state.strapStatus}"></span>${esc(
      state.strapStatus === 'connected' ? 'Strap live' : state.strapStatus === 'reconnecting' ? `Reconnecting (${state.strapInfo.attempt || 1})` : state.strapStatus === 'connecting' ? 'Connecting' : 'Connect strap',
    )}`;
  }
  const lb = $('#liveBpm');
  if (lb) lb.innerHTML = `${state.hr ?? '--'}<small>bpm</small>`;
}

function bannerHtml() {
  if (support.ok) return '';
  if (support.isIOS) {
    return `<div class="banner warn"><b>iPhone / iPad can't connect.</b> Safari (and every iOS browser) has no Web Bluetooth, so Pulse can't read your strap here. Use Chrome on Android or a desktop computer. You can still explore the demos and fixtures.</div>`;
  }
  return `<div class="banner warn"><b>No Web Bluetooth in this browser.</b> Open Pulse in Chrome on Android (or desktop Chrome / Edge) to connect your strap.</div>`;
}

function typeIcon(type) {
  return icon(typeOf(type).icon || 'heart');
}

function sessionListHtml(list) {
  if (!list.length) return `<div class="empty">No sessions yet. Tap Watch on a game above, or load a demo in Settings.</div>`;
  const rest = state.settings.restingHr;
  return `<ul class="hist">${list
    .map((s) => {
      const st = s.statsCache || sessionStats(s, rest);
      const crest = s.event && s.event.home && s.event.home.logo ? img(s.event[s.event.mine || 'home'].logo, 'ti-img') : typeIcon(s.type);
      return `<li><a href="#/session/${s.id}">
      <div class="ti">${crest}</div>
      <div class="main"><div class="name">${esc(displayTitle(s))}</div>
      <div class="meta">${fmtDate(s.startTs)} · ${clockTime(s.startTs)} · ${fmtDur(st.durationMs)}</div></div>
      <div class="spark">${sparklineSvg(s, 80, 28)}</div>
      <div class="nums"><div><span class="muted">avg</span> <b>${st.avgHr ?? '--'}</b></div><div><span class="muted">peak</span> <b>${st.peakHr ?? '--'}</b></div></div>
    </a></li>`;
    })
    .join('')}</ul>`;
}

/* ---------------- Home: live & upcoming ---------------- */

function dayShort(t) {
  const l = dayLabel(t);
  return l === 'Today' || l === 'Tomorrow' ? l : new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const tom = new Date();
  tom.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tom.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function fixtureCard(ev, withDay = false) {
  const live = ev.state === 'in';
  const done = ev.state === 'post';
  const soon = !live && !done && ev.date - Date.now() < 90 * 60000;
  const when = live
    ? `<span class="livebadge">LIVE</span> ${esc(ev.detail || '')}`
    : done
      ? esc(ev.detail || 'FT')
      : withDay
        ? `${esc(dayShort(ev.date))} ${clockTime(ev.date)}`
        : clockTime(ev.date);
  const btn = `<button class="btn ${live || soon ? 'primary' : ''} watchbtn" data-watch="${esc(ev.key)}">${icon('tv')}Watch</button>`;
  if (ev.source === 'openf1') {
    const drv = state.follow.drivers.length ? { name: state.follow.drivers.map((d) => d.name.split(' ').slice(-1)[0]).join(', ') } : null;
    return `<article class="fx ${live ? 'is-live' : ''}">
      <div class="fx-top"><span class="comp">${icon('flag')} Formula 1 · ${esc(ev.sessionName)}</span><span class="when">${when}</span></div>
      <div class="fx-body"><div class="fx-teams">
        <div class="fx-row">${img(ev.flag, 'flagimg')}<span class="tm">${esc(ev.meetingName)}</span></div>
        ${drv ? `<div class="fx-sub">${icon('star')} ${esc(drv.name)}</div>` : ''}
      </div>${btn}</div></article>`;
  }
  const row = (side) => {
    const t = ev[side];
    const mine = ev.mine === side;
    return `<div class="fx-row ${mine ? 'mine' : ''}">${img(t.logo)}<span class="tm">${esc(t.short || t.name)}</span>${
      live || done ? `<span class="sc">${esc(t.score ?? '')}</span>` : ''
    }</div>`;
  };
  return `<article class="fx ${live ? 'is-live' : ''}">
    <div class="fx-top"><span class="comp">${esc(ev.competition)}</span><span class="when">${when}</span></div>
    <div class="fx-body"><div class="fx-teams">${row('home')}${row('away')}</div>${btn}</div></article>`;
}

async function refreshFixtures(force = false) {
  if (!force && state.fixtures && Date.now() - state.fixturesAt < 60000) return state.fixtures;
  const res = await loadFixtures(state.follow);
  state.fixtures = res;
  state.fixturesAt = Date.now();
  return res;
}

function fixturesHtml(res) {
  if (!res) return `<div class="card loading"><span class="spinner"></span>Loading your games and races…</div>`;
  if (!res.events.length && res.errors && res.errors === res.total) return `<div class="empty">Couldn't load fixtures. Check your connection.</div>`;
  const isMine = (e) => e.source === 'openf1' || !!e.mine;
  const evs = res.events.filter((e) => e.state !== 'post');
  if (!evs.length) return `<div class="empty">Nothing live or coming up in the next 9 days. <a href="#/following">Edit what you follow</a></div>`;
  const live = evs.filter((e) => e.state === 'in');
  const mine = evs.filter((e) => e.state !== 'in' && isMine(e));
  const rest = evs.filter((e) => e.state !== 'in' && !isMine(e));
  let html = '';
  if (live.length) html += `<div class="subhead"><span class="livedot"></span>Live now</div><div class="fxlist">${live.map(fixtureCard).join('')}</div>`;
  if (mine.length) html += `<div class="subhead">${icon('star')}Your teams &amp; driver</div><div class="fxlist">${mine.slice(0, 8).map((e) => fixtureCard(e, true)).join('')}</div>`;
  if (rest.length) {
    const shown = state.showAllFixtures ? rest.slice(0, 40) : rest.slice(0, 4);
    html += `<div class="subhead">More from your competitions</div>`;
    let lastDay = '';
    for (const e of shown) {
      const d = dayLabel(e.date);
      if (d !== lastDay) {
        if (lastDay) html += '</div>';
        html += `<div class="dayhead">${esc(d)}</div><div class="fxlist">`;
        lastDay = d;
      }
      html += fixtureCard(e);
    }
    if (lastDay) html += '</div>';
    if (rest.length > 4) html += `<button class="linkbtn morebtn" id="fxMore">${state.showAllFixtures ? 'Show fewer' : `Show all ${rest.length} games`}</button>`;
  }
  return html;
}

async function renderHome() {
  const my = routeSeq;
  const sessions = await db.allSessions();
  if (my !== routeSeq) return;
  const liveBanner = state.live
    ? `<a class="banner info resume" href="#/${state.live.ended ? 'end' : 'live'}"><b>Session running:</b> ${esc(displayTitle(state.live))} → Return</a>`
    : '';
  view.innerHTML = `
    <div class="topbar"><div class="brand grow">${PULSE_MARK}PULSE</div>${strapChipHtml()}</div>
    ${bannerHtml()}
    ${liveBanner}
    <div class="others two">
      <button class="otherbtn" data-start="meeting">${icon('chat')}<span>Meeting</span></button>
      <button class="otherbtn" data-start="sport">${icon('ball')}<span>Other match</span></button>
    </div>
    <a class="meetcard" href="#/meetings" id="meetCard">${icon('chat')}<div class="grow"><b>Meeting stress</b><span class="small muted" id="meetSummary">See which meetings raise your heart rate</span></div><span class="chev">›</span></a>
    ${weeklyHtml(sessions)}
    <div class="section-title"><h3>Sports</h3><span><button class="linkbtn small" id="remindAll">${icon('cal')} Add to calendar</button> <a href="#/following" class="small">Edit</a></span></div>
    <div id="fixtures">${fixturesHtml(state.fixtures)}</div>
    <div class="section-title"><h3>Recent sessions</h3>${sessions.length > 4 ? '<a href="#/history" class="small">See all</a>' : ''}</div>
    ${sessionListHtml(sessions.slice(0, 4))}
  `;
  bindStrapChip();
  renderStrapBits();
  $$('[data-start]').forEach((b) => b.addEventListener('click', () => go(`#/start/${b.dataset.start}`)));
  $('#remindAll').addEventListener('click', () => {
    const evs = ((state.fixtures && state.fixtures.events) || []).filter((e) => e.state === 'pre' && (e.source === 'openf1' || e.mine));
    if (!evs.length) return toast('No upcoming games for your teams or drivers yet');
    downloadIcs(evs, 'pulse-my-games.ics');
    toast(`${evs.length} game${evs.length > 1 ? 's' : ''} ready to add to your calendar`);
  });
  {
    const ms = sessions.filter((x) => x.type === 'meeting');
    if (ms.length && state.settings.lockOn && !isUnlocked()) $('#meetSummary').textContent = `${ms.length} meetings · locked`;
    else if (ms.length) {
      const rows = meetingRows(ms);
      const top = rows.filter((r) => r.elevation != null).sort((a, b) => b.elevation - a.elevation)[0];
      $('#meetSummary').textContent = `${ms.length} meeting${ms.length > 1 ? 's' : ''}${top ? ` · highest +${top.elevation} bpm (${top.title})` : ''}`;
    }
  }
  const bindWatch = () => {
    const more = $('#fxMore');
    if (more)
      more.addEventListener('click', () => {
        state.showAllFixtures = !state.showAllFixtures;
        $('#fixtures').innerHTML = fixturesHtml(state.fixtures);
        bindWatch();
      });
    bindWatchButtons();
  };
  const bindWatchButtons = () =>
    $$('[data-watch]').forEach((b) =>
      b.addEventListener('click', () => {
        const ev = state.fixtures.events.find((e) => e.key === b.dataset.watch);
        if (ev) watchSheet(ev);
      }),
    );
  bindWatch();
  const load = async (force) => {
    try {
      const res = await refreshFixtures(force);
      const box = $('#fixtures');
      if (box) {
        box.innerHTML = fixturesHtml(res);
        bindWatch();
      }
    } catch {
      const box = $('#fixtures');
      if (box && !state.fixtures) box.innerHTML = `<div class="empty">Couldn't load fixtures. Check your connection.</div>`;
    }
  };
  load(false);
  const timer = setInterval(() => load(true), 60000);
  cleanup = () => clearInterval(timer);
}

/* ---------------- Watch an event ---------------- */

function watchSheet(ev) {
  if (state.live && !state.live.ended) {
    toast('A session is already running');
    return go('#/live');
  }
  const isF1 = ev.source === 'openf1';
  let mine = isF1 ? '0' : ev.mine || null;
  const drivers = state.follow.drivers || [];
  const title = isF1 ? `${ev.meetingName}${ev.sessionName === 'Sprint' ? ' Sprint' : ''}` : `${ev.home.short} v ${ev.away.short}`;
  const m = showModal(`
    <div class="sheet-head">${isF1 ? img(ev.flag, 'flagimg big') : `${img(ev.home.logo, 'crest big')}${img(ev.away.logo, 'crest big')}`}</div>
    <h2>${esc(title)}</h2>
    <p class="muted" style="margin-top:4px">${esc(ev.competition)} · ${ev.state === 'in' ? 'Live now' : ev.state === 'post' ? 'Finished' : `${dayLabel(ev.date)} ${clockTime(ev.date)}`}</p>
    ${
      isF1
        ? drivers.length > 1
          ? `<div class="field"><span class="muted small" style="display:block;margin:10px 0 6px;font-weight:500">Whose race is it for you?</span>
          <div class="seg" id="wMine">${drivers.map((d, i) => `<button data-v="${i}">${esc(d.name.split(' ').slice(-1)[0])}</button>`).join('')}</div></div>`
          : `<p class="small">Your driver: <b>${esc(drivers[0]?.name || 'none')}</b> <a href="#/following">change</a></p>`
        : `<div class="field"><span class="muted small" style="display:block;margin:10px 0 6px;font-weight:500">Your team</span>
          <div class="seg" id="wMine"><button data-v="home">${esc(ev.home.short)}</button><button data-v="away">${esc(ev.away.short)}</button><button data-v="">Neither</button></div></div>`
    }
    <p class="small muted">Moments (${isF1 ? 'lead changes, safety car, pit stops, result' : 'goals, red cards, VAR, woodwork'}) are added automatically from live data, ${state.settings.delaySec} s after they happen to match your stream. Tap <b>Sync stream</b> once you're watching to set your exact delay. You can start at any point, even mid-${isF1 ? 'race' : 'match'}.</p>
    ${state.strapStatus !== 'connected' && support.ok ? '<p class="small" style="color:#fbd38d">Strap not connected yet. You can connect it on the next screen.</p>' : ''}
    <div class="actions">
      <button class="btn primary" id="wGo" style="min-height:58px;font-size:17px">${icon('tv')} I'm watching, start</button>
      ${ev.state === 'pre' ? `<button class="btn" id="wRemind">${icon('cal')} Remind me ${state.settings.reminderMin} min before</button>` : ''}
      <button class="btn ghost" id="wCancel">Cancel</button>
    </div>`);
  const seg = $('#wMine', m);
  const setSeg = () => seg && $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === (mine || '')));
  setSeg();
  if (seg)
    seg.addEventListener('click', (e) => {
      if (e.target.dataset.v != null) {
        mine = e.target.dataset.v || null;
        setSeg();
      }
    });
  $('#wCancel', m).addEventListener('click', hideModal);
  const rem = $('#wRemind', m);
  if (rem)
    rem.addEventListener('click', () => {
      downloadIcs([ev], `pulse-${ev.key.replace(/[^a-z0-9]/gi, '-')}.ics`);
      toast('Open the file to add the reminder to your calendar');
    });
  $('#wGo', m).addEventListener('click', async () => {
    hideModal();
    await startLinkedSession(ev, mine);
  });
}

async function startLinkedSession(ev, mine) {
  const isF1 = ev.source === 'openf1';
  const s = {
    id: uid(),
    type: isF1 ? 'f1' : 'sport',
    title: isF1 ? `${ev.meetingName}${ev.sessionName === 'Sprint' ? ' Sprint' : ''}` : `${ev.home.short} v ${ev.away.short}`,
    mode: 'watching',
    startTs: Date.now(),
    endTs: null,
    restingHr: state.settings.restingHr,
    samples: [],
    tags: [],
    bands: [],
    notes: '',
    writeup: null,
    delayMs: state.settings.delaySec * 1000,
    delayCalibrated: false,
    event: isF1
      ? { source: 'openf1', id: ev.id, sessionKey: ev.sessionKey, meetingName: ev.meetingName, sessionName: ev.sessionName, competition: 'Formula 1', flag: ev.flag, driver: (state.follow.drivers || [])[Number(mine) || 0] || null, date: ev.date }
      : { source: 'espn', id: ev.id, league: ev.league, competition: ev.competition, home: ev.home, away: ev.away, mine, date: ev.date },
  };
  if (!isF1) {
    s.teams = { home: ev.home.short, away: ev.away.short, mine };
    s.score = { home: Number(ev.home.score) || 0, away: Number(ev.away.score) || 0 };
    s.phases = {};
  }
  state.live = s;
  state.undo = [];
  await db.saveLive(s);
  go('#/live');
}

/* ---------------- Manual start (meeting / workout / other match) ---------------- */

function renderStart(typeKey) {
  const type = SESSION_TYPES[typeKey];
  if (!type || type.feedOnly) return go('#/');
  if (state.live && !state.live.ended) return go('#/live');
  let mode = type.defaultMode;
  let mine = 'home';
  view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/" aria-label="Back">${icon('back')}</a><h1 class="grow">${esc(typeKey === 'sport' ? 'Other match' : type.label)}</h1>${strapChipHtml()}</div>
    ${bannerHtml()}
    ${typeKey === 'sport' ? '<p class="small muted" style="margin-top:-4px">For games Pulse has no live data for. You tag the moments yourself.</p>' : ''}
    <div class="card">
      <label class="field"><span>Title</span><input type="text" id="fTitle" placeholder="${esc(type.titleHint)}" maxlength="80" autocomplete="off"/></label>
      <div class="field"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Are you watching or doing?</span>
        <div class="seg" id="fMode"><button data-v="watching">Watching</button><button data-v="doing">Doing</button></div></div>
      ${
        type.teams
          ? `<div class="row2" style="margin-top:14px">
          <label class="field"><span>Home team</span><input type="text" id="fHome" placeholder="Home" maxlength="30"/></label>
          <label class="field"><span>Away team</span><input type="text" id="fAway" placeholder="Away" maxlength="30"/></label></div>
          <div class="field"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Which one is your team?</span>
          <div class="seg" id="fMine"><button data-v="home">Home</button><button data-v="away">Away</button><button data-v="none">Neither</button></div></div>`
          : ''
      }
      ${
        type.attendees
          ? `<div class="field" style="margin-top:14px"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Who's in the meeting?</span><div id="fPeople"></div></div>`
          : ''
      }
    </div>
    ${type.attendees ? '<p class="small muted" style="margin:-4px 2px 12px">Start recording 2–3 minutes before the meeting and tap <b>Meeting starts now</b> when it begins. Those first minutes are your baseline.</p>' : ''}
    <button class="btn primary block" id="fGo" style="min-height:60px;font-size:17px">Start session</button>
    <p class="hint">Keep Pulse open and on screen during the session. Android can cut Bluetooth when Chrome is in the background.</p>
  `;
  bindStrapChip();
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
  let people = null;
  if (type.attendees) {
    knownPeople().then((known) => (people = peopleInput($('#fPeople'), [], known)));
    if (state.settings.gcalClientId && gcalConnected()) {
      const now = Date.now();
      calendarEvents(state.settings.gcalClientId, now - 60 * 60000, now + 2 * 3600e3)
        .then((evs) => {
          const near = evs.filter((e) => e.end > now - 10 * 60000).slice(0, 3);
          if (!near.length) return;
          const box = document.createElement('div');
          box.className = 'calpick';
          box.innerHTML = `<div class="small muted">From your calendar</div>${near
            .map((e, i) => `<button type="button" class="chip" data-ev="${i}">${esc(clockTime(e.start))} · ${esc(e.title)}</button>`)
            .join('')}`;
          $('#fTitle').closest('.card').prepend(box);
          $$('[data-ev]', box).forEach((b) =>
            b.addEventListener('click', async () => {
              const e = near[Number(b.dataset.ev)];
              $('#fTitle').value = e.title;
              people = peopleInput($('#fPeople'), e.attendees, await knownPeople());
              $$('[data-ev]', box).forEach((x) => x.classList.toggle('on', x === b));
            }),
          );
        })
        .catch(() => {});
    }
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
    if (type.attendees) {
      s.attendees = people ? people.get() : [];
      s.phases = {};
    }
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
  const phases = typeOf(s.type).phases || [];
  return phases.find((p) => !(s.phases || {})[p.key]) || null;
}
function openBand(s) {
  return (s.bands || []).find((b) => !b.end && !b.auto);
}

function liveClock(s, now) {
  const type = typeOf(s.type);
  if (type.clock === 'match') {
    const mm = matchMinute(s, now);
    const ph = matchPhase(s, now);
    const p = s.phases || {};
    let sub = (s.event ? 'Waiting for kick-off · ' : 'Pre-match · ') + elapsedLabel(now - s.startTs);
    if (ph === 'first') sub = '1st half · ' + elapsedLabel(now - p.kickoff);
    else if (ph === 'ht') sub = 'Half-time · ' + elapsedLabel(now - p.halftime);
    else if (ph === 'second') sub = '2nd half · ' + elapsedLabel(now - p.secondhalf + 45 * 60000);
    else if (ph === 'ft') sub = 'Full time';
    return { big: mm === 'Pre' ? '–' : mm, sub };
  }
  if (s.feed && s.feed.status) return { big: elapsedLabel(now - s.startTs), sub: s.feed.status.detail || '' };
  return { big: elapsedLabel(now - s.startTs), sub: `Started ${clockTime(s.startTs)}` };
}

function addTag(def, extra = {}) {
  const s = state.live;
  if (!s) return;
  const t = extra.t || Date.now();
  let label = extra.label || def.label;
  const tag = { id: uid(), t, key: def.key, label, color: def.color || FREE_TAG.color, cat: def.cat, catLabel: def.catLabel };
  if (def.cat === 'reaction' && s.teams && s.event) {
    const mm = matchMinute(s, t);
    if (/\d/.test(mm)) tag.label = `${mm} ${label}`;
  }
  if (def.team) {
    tag.team = def.team;
    s.tags.push(tag);
    recomputeGoals(s);
  } else s.tags.push(tag);
  state.undo.push({ kind: 'tag', id: tag.id });
  buzz(30);
  const when = typeOf(s.type).clock === 'match' ? matchMinute(s, t) : elapsedLabel(t - s.startTs);
  toast(`${tag.label}${/^\d/.test(tag.label) ? '' : ' · ' + when}`);
  db.saveLive(s).catch(() => {});
  refreshLive(true);
}

const REACTION_DEF = { key: 'reaction', cat: 'reaction', color: CATEGORIES.reaction.color, catLabel: 'Your reaction' };

/* ----- live feed polling ----- */

async function pollFeed() {
  const s = state.live;
  if (!s || !s.event || s.event.id === 'demo') return;
  try {
    const f = await syncEvent(s.event, state.follow);
    s.feed = f;
    if (f.home && s.event.home) {
      s.event.home = { ...s.event.home, score: f.score.home };
      s.event.away = { ...s.event.away, score: f.score.away };
    }
    state.feedStatus = {
      ok: true,
      at: Date.now(),
      msg: s.event.source === 'openf1' && f.status.state === 'pre' && Date.now() > (s.event.date || 0) + 10 * 60000 ? 'f1wait' : '',
    };
  } catch (e) {
    state.feedStatus = { ok: false, at: state.feedStatus.at, msg: e.status === 401 || e.status === 403 ? 'f1wait' : e.message };
    try {
      const b = await backupLiveScore(s.event);
      if (b) {
        s.feed = { moments: [], bands: [], phases: {}, ...(s.feed || {}), score: b.score, status: b.status };
        state.feedStatus = { ok: true, at: Date.now(), msg: 'backup' };
      }
    } catch {
      /* backup unavailable too */
    }
  }
  if (state.live === s) {
    const wasPending = s.calib && s.calib.pending;
    applyFeed(s);
    if (wasPending && s.calib && !s.calib.pending) toast(`Stream synced: ${Math.round(s.delayMs / 1000)} s behind live`);
    refreshLive(true);
  }
}

function feedStatusText() {
  const s = state.live;
  if (!s || !s.event) return '';
  const fs = state.feedStatus;
  if (fs.msg === 'backup') return `Live score from backup source (ESPN unavailable) · stream delay ${Math.round((s.delayMs ?? 0) / 1000)} s`;
  if (fs.msg === 'f1wait') return 'F1 live timing may only be published after the race. Pulse fills in the moments when you save.';
  if (fs.ok === null) return 'Connecting to live data…';
  if (!fs.ok) return `Live data unavailable (${fs.msg}). Retrying…`;
  const ago = Math.round((Date.now() - fs.at) / 1000);
  const pend = s.calib && s.calib.pending ? ' · stream sync saved, waiting for live data to place it' : '';
  return `Live data · updated ${ago}s ago · stream delay ${Math.round((s.delayMs ?? 0) / 1000)} s${s.delayCalibrated ? ' (synced)' : ''}${pend}`;
}

/** The newest feed event that has already happened (in the feed) — used for "I just saw it". */
function calibrationCandidate(s, now) {
  if (!s.feed || !s.feed.moments) return null;
  const recent = s.feed.moments.filter((m) => m.ft <= now && now - m.ft < 4 * 60000 && m.cat !== 'finish');
  return recent.length ? recent[recent.length - 1] : null;
}

/* ----- stream sync: type the match clock or lap ----- */

function applyCalibration(s, calib) {
  s.calib = calib;
  applyFeed(s);
  if (s.calib.pending) {
    toast(s.event.source === 'openf1' ? 'Saved. Applied as soon as lap times arrive.' : 'Saved. Applied as soon as live data has the kick-off times.');
  } else {
    const d = Math.round(s.delayMs / 1000);
    toast(d >= MAX_DELAY_MS / 1000 ? 'That is over 10 min behind. Check the time you typed.' : d === 0 ? 'Synced: your stream looks live (0 s)' : `Synced: your stream is ${d} s behind live`);
    state.settings.delaySec = d;
    saveSettings(state.settings);
  }
  db.saveLive(s).catch(() => {});
  refreshLive(true);
}

function syncSheet(s) {
  const isF1 = s.event.source === 'openf1';
  const laps = isF1 && s.feed && s.feed.lapStarts ? Object.keys(s.feed.lapStarts).map(Number) : [];
  const maxLap = laps.length ? Math.max(...laps) : 0;
  const m = showModal(
    isF1
      ? `<h2>Sync with your stream</h2>
        <p class="muted small">Type the <b>next lap</b> number, then tap <b>Sync now</b> the moment your stream's lap counter changes to it.</p>
        <div class="syncin"><span class="pre">LAP</span><input type="number" id="syVal" inputmode="numeric" min="1" max="99" placeholder="${maxLap ? maxLap + 1 : 12}" /></div>
        <div class="actions">
          <button class="btn primary" id="syGo" style="min-height:62px;font-size:18px">Sync now</button>
          <button class="btn" data-q="lo">Lights out, right now</button>
          <button class="btn ghost" id="syCancel">Cancel</button>
        </div>`
      : `<h2>Sync with your stream</h2>
        <p class="muted small">Type a match clock a few seconds <b>ahead</b> of your stream (e.g. <b>67:30</b>), then tap <b>Sync now</b> the moment your stream's clock shows it. Stoppage time: <b>45+2:10</b> or <b>90+3:05</b>.</p>
        <div class="syncin"><input type="text" id="syVal" inputmode="decimal" placeholder="67:30" autocomplete="off" /></div>
        <div class="actions">
          <button class="btn primary" id="syGo" style="min-height:62px;font-size:18px">Sync now</button>
          <div class="row2"><button class="btn" data-q="ko">Kick-off now</button><button class="btn" data-q="sh">2nd half now</button></div>
          <button class="btn ghost" id="syCancel">Cancel</button>
        </div>`,
  );
  const input = $('#syVal', m);
  setTimeout(() => input.focus(), 50);
  $('#syCancel', m).addEventListener('click', hideModal);
  $('#syGo', m).addEventListener('click', () => {
    const at = Date.now();
    if (isF1) {
      const lap = parseInt(input.value, 10);
      if (!(lap >= 1 && lap <= 99)) return toast('Type a lap number');
      hideModal();
      applyCalibration(s, { kind: 'lap', lap, at });
    } else {
      const c = parseMatchClock(input.value);
      if (!c) return toast('Type the clock like 67:30');
      hideModal();
      applyCalibration(s, { kind: 'clock', sec: c.sec, period: c.period, at, input: input.value.trim() });
    }
  });
  $$('[data-q]', m).forEach((b) =>
    b.addEventListener('click', () => {
      const at = Date.now();
      const q = b.dataset.q;
      hideModal();
      if (q === 'lo') applyCalibration(s, { kind: 'lap', lap: 1, at });
      else applyCalibration(s, { kind: 'clock', sec: q === 'ko' ? 0 : 2700, period: q === 'ko' ? 1 : 2, at, input: q === 'ko' ? '0:00' : '45:00' });
    }),
  );
}

function renderLive() {
  const s = state.live;
  if (!s) return go('#/');
  if (s.ended) return go('#/end');
  const type = typeOf(s.type);
  const linked = !!s.event;
  requestWakeLock();
  if (linked) applyFeed(s);

  let header = '';
  if (linked && s.event.source === 'espn') {
    const e = s.event;
    header = `<div class="scoreboard">
      <div class="sb-team ${e.mine === 'home' ? 'mine' : ''}">${img(e.home.logo, 'crest big')}<span>${esc(e.home.short)}</span></div>
      <div class="sb-mid"><div class="sb-score" id="liveScore">0–0</div><div class="sb-comp">${esc(e.competition)}</div></div>
      <div class="sb-team ${e.mine === 'away' ? 'mine' : ''}">${img(e.away.logo, 'crest big')}<span>${esc(e.away.short)}</span></div></div>`;
  } else if (linked) {
    header = `<div class="scoreboard f1">${img(s.event.flag, 'flagimg big')}<div><div class="sb-title">${esc(displayTitle(s))}</div><div class="sb-comp">Formula 1 · ${esc(
      s.event.driver ? s.event.driver.name : '',
    )}</div></div></div>`;
  } else if (type.teams) {
    header = `<div class="score"><span class="team home ${s.teams.mine === 'home' ? 'mine' : ''}">${esc(s.teams.home)}</span><span class="goals" id="liveScore">0–0</span><span class="team ${s.teams.mine === 'away' ? 'mine' : ''}">${esc(s.teams.away)}</span></div>`;
  }

  const tagButtons = linked
    ? ''
    : type.tags
        .map((d) => {
          if (d.team) return `<button class="tagbtn big" data-tag="${d.key}"><span class="sw" style="background:${goalColor(s, d.team)}"></span>Goal ${esc(s.teams[d.team])}</button>`;
          return `<button class="tagbtn" data-tag="${d.key}"><span class="sw" style="background:${d.color}"></span>${esc(d.label)}</button>`;
        })
        .join('');

  view.innerHTML = `
    <div class="live-head">
      <button class="pill" id="livePill"></button>
      <div class="live-title">${esc(linked ? '' : s.title)}</div>
      <div class="live-clock"><div class="big" id="liveClock">0:00</div><div class="sub" id="liveClockSub"></div></div>
    </div>
    ${header}
    <div class="live-main">
      <div class="live-bpm" id="liveBpm">--<small>bpm</small></div>
      <div class="stress-chip"><div class="k">Stress</div><div class="v" id="liveTension">–</div></div>
    </div>
    <div class="chart-card tight"><div class="cc-head"><div class="cc-key"><span><i style="background:${COLORS.hr}"></i>HEART RATE</span><span><i style="background:${COLORS.stressLow}"></i>STRESS</span></div></div>
      <div class="chartbox" id="liveChart"></div></div>
    ${
      s.type === 'workday'
        ? `<div class="section-title" style="margin-top:14px"><h3>${icon('cal')} Today's meetings</h3><button class="linkbtn small" id="wdRefresh">Refresh</button></div>
      <div id="wdCal" class="card tight">Loading your calendar…</div>
      <p class="small muted" style="margin:0 2px 10px">Leave the phone on its charger with Pulse open. Every meeting is scored against your heart rate in the 90 minutes around it when you end the day.</p>
      <div class="live-foot one"><button class="btn danger" id="endBtn">End work day</button></div>`
        : ''
    }
    ${linked ? `<div class="syncrow"><p class="feedline" id="feedLine"></p><button class="btn small" id="syncBtn">${icon('tv')} Sync stream</button></div><div id="calib"></div>` : ''}
    ${
      !linked && s.type !== 'workday'
        ? `<div class="ctrl">
      ${type.phases ? `<button class="btn block" id="phaseBtn" style="min-height:60px;font-size:17px"></button>` : ''}
      ${type.toggle ? `<button class="btn block togglebtn" id="toggleBtn" style="min-height:60px;font-size:17px;color:${type.toggle.color}"></button>` : ''}
    </div>`
        : ''
    }
    ${
      linked
        ? `<div class="section-title" style="margin-top:16px"><h3>Moments · automatic</h3></div>
      <p class="small muted" style="margin:-4px 2px 10px">Goals, chances, cards and your heart-rate spikes are added for you. Just watch.</p>
      <ol class="mlist" id="liveMoments"></ol>
      <div class="live-foot one"><button class="btn danger" id="endBtn">End session</button></div>`
        : s.type === 'workday'
          ? ''
          : `<div class="tags">${tagButtons}</div>
    <form class="freetag" id="freeForm"><input type="text" id="freeText" placeholder="Something else… (free text)" maxlength="60" autocomplete="off"/><button class="btn" type="submit">Tag</button></form>
    <div class="live-foot">
      <button class="btn" id="undoBtn">Undo last</button>
      <button class="btn danger" id="endBtn">End session</button>
    </div>`
    }
    <p class="hint">Keep Pulse open and on screen. Android can cut Bluetooth when Chrome is in the background. The screen stays on during a session.</p>
    <p class="note-estimate" style="text-align:center">${STRESS_NOTE}</p>
  `;

  $('#livePill').addEventListener('click', () => {
    if (state.strapStatus !== 'connected') connectStrap(false);
  });
  if ($('#syncBtn')) $('#syncBtn').addEventListener('click', () => syncSheet(s));
  if (s.type === 'workday') {
    $('#wdRefresh').addEventListener('click', () => refreshWorkdayCalendar(s, true));
    if (s.calEvents && s.calEvents.length) $('#wdCal').innerHTML = workdayCalHtml(s, Date.now());
    else refreshWorkdayCalendar(s, false);
  }
  $$('[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const def = type.tags.find((d) => d.key === b.dataset.tag);
      addTag({ ...def, cat: def.team ? null : def.key, catLabel: def.label });
    }),
  );
  $$('[data-react]').forEach((b) => b.addEventListener('click', () => addTag({ ...REACTION_DEF, label: b.dataset.react })));
  if ($('#freeForm')) $('#freeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#freeText').value.trim();
    if (!v) return;
    addTag({ ...REACTION_DEF, label: v });
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
  if ($('#undoBtn')) $('#undoBtn').addEventListener('click', () => {
    const last = state.undo.pop();
    if (!last) {
      const lt = s.tags.filter((g) => !g.auto).sort((a, b) => b.t - a.t)[0];
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
      const idx = s.bands.map((b) => !b.auto).lastIndexOf(true);
      const b = idx >= 0 ? s.bands.splice(idx, 1)[0] : null;
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
    if (s.feed) applyFeed(s);
    db.saveLive(s).catch(() => {});
    releaseWakeLock();
    go('#/end');
  });

  refreshLive(true);
  renderStrapBits();
  const tick = setInterval(() => refreshLive(false), 1000);
  const calTimer = s.type === 'workday' && state.settings.calAutoRefresh ? setInterval(() => refreshWorkdayCalendar(s, false), 15 * 60000) : null;
  const chartTick = setInterval(() => refreshLive(true), 5000);
  const autosave = setInterval(() => db.saveLive(s).catch(() => {}), 5000);
  let feedTimer = null;
  if (linked) {
    pollFeed();
    feedTimer = setInterval(pollFeed, s.event.source === 'openf1' ? 45000 : 20000);
  }
  const ro = new ResizeObserver(() => drawLiveChart());
  ro.observe($('#liveChart'));
  cleanup = () => {
    clearInterval(tick);
    if (calTimer) clearInterval(calTimer);
    clearInterval(chartTick);
    clearInterval(autosave);
    if (feedTimer) clearInterval(feedTimer);
    ro.disconnect();
    db.saveLive(s).catch(() => {});
  };
}

function drawLiveChart() {
  const box = $('#liveChart');
  if (!box || !state.live) return;
  const w = Math.floor(box.clientWidth);
  if (!w) return;
  const h = w < 500 ? 230 : 300;
  box.innerHTML = chartSvg(state.live, w, h, { restingHr: state.settings.restingHr, now: Date.now() });
}

function momentsListHtml(s, newestFirst = false) {
  const list = numberedMoments(s);
  if (!list.length) return '<li class="muted small">No moments yet.</li>';
  return (newestFirst ? list.reverse() : list)
    .map(
      (m) =>
        `<li><span class="n" style="background:${m.color};color:${isLight(m.color) ? '#111418' : '#fff'}">${m.n}</span><span class="t" style="color:${
          isLight(m.color) ? 'var(--text)' : m.color
        }">${esc(m.timeLabel)}</span><span class="l">${esc(m.label)}</span></li>`,
    )
    .join('');
}

function isLight(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return true;
  return 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) > 150;
}

let lastMomentsKey = '';
/** Rebuild automatic moments + heart-rate reactions for a linked session. */
function refreshAuto(s, now = Date.now()) {
  return applyAuto(s, state.settings.restingHr, now);
}

function refreshLive(withChart) {
  const s = state.live;
  if (!s || !$('#liveClock')) return;
  const now = Date.now();
  if (withChart) refreshAuto(s, now);
  else if (s.feed) applyFeed(s, now);
  const c = liveClock(s, now);
  $('#liveClock').textContent = c.big;
  $('#liveClockSub').textContent = c.sub;
  if (s.score && $('#liveScore')) $('#liveScore').textContent = `${s.score.home}–${s.score.away}`;
  const pb = $('#phaseBtn');
  if (pb) {
    const np = nextPhase(s);
    const phs = typeOf(s.type).phases || [];
    pb.textContent = np ? `▶ ${np.button}` : `✓ ${phs.length ? phs[phs.length - 1].label : 'Done'}`;
    pb.disabled = !np;
    pb.classList.toggle('primary', !!np && np.key === 'kickoff');
  }
  const tb = $('#toggleBtn');
  if (tb) {
    const ob = openBand(s);
    const t = typeOf(s.type).toggle;
    tb.classList.toggle('on', !!ob);
    tb.textContent = ob ? `■ ${t.label} · ${elapsedLabel(now - ob.start)} (tap to stop)` : `● ${t.button}`;
  }
  const fl = $('#feedLine');
  if (fl) fl.textContent = feedStatusText();
  const wd = $('#wdCal');
  if (wd && s.type === 'workday' && s.calEvents && s.calEvents.length && withChart) wd.innerHTML = workdayCalHtml(s, now);
  const cal = $('#calib');
  if (cal) {
    const cand = calibrationCandidate(s, now);
    const key = cand ? cand.fid : '';
    if (cal.dataset.k !== key) {
      cal.dataset.k = key;
      cal.innerHTML = cand
        ? `<div class="calib"><div><div class="small muted">Latest from live data. Tap when your stream shows it</div><div class="calib-l">${esc(cand.label)}</div></div>
          <button class="btn small" id="calBtn">Just saw it</button></div>`
        : '';
      const b = $('#calBtn');
      if (b)
        b.addEventListener('click', () => {
          const d = Math.max(0, Math.min(MAX_DELAY_MS, Date.now() - cand.ft));
          s.calib = null;
          s.delayMs = d;
          s.delayCalibrated = true;
          state.settings.delaySec = Math.round(d / 1000);
          saveSettings(state.settings);
          applyFeed(s);
          toast(`Synced: your stream is ${Math.round(d / 1000)} s behind live`);
          db.saveLive(s).catch(() => {});
          cal.dataset.k = '';
          cal.innerHTML = '';
          refreshLive(true);
        });
    }
  }
  const ml = $('#liveMoments');
  if (ml) {
    const key = s.tags.map((g) => g.id + g.t).join();
    if (key !== lastMomentsKey) {
      lastMomentsKey = key;
      ml.innerHTML = momentsListHtml(s, true);
    }
  }
  if (withChart) {
    drawLiveChart();
    const ten = tensionSeries(s, state.settings.restingHr).series.filter((p) => p.value != null);
    const last = ten[ten.length - 1];
    $('#liveTension').textContent = last ? last.value.toFixed(1) : '–';
  }
}

/* ---------------- End: "What happened?" ---------------- */

function renderEnd() {
  const s = state.live;
  if (!s) return go('#/');
  if (!s.ended) return go('#/live');
  const type = typeOf(s.type);
  const rest = state.settings.restingHr;
  const st = sessionStats(s, rest);
  const linked = !!s.event;
  const tagDefs = linked ? [{ ...REACTION_DEF, label: 'Your reaction' }] : [...type.tags, FREE_TAG];
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
      <textarea id="eNotes" placeholder="How did it feel? What were the big moments for you?">${esc(s.notes || '')}</textarea></label>
    </div>
    <div class="card">
      <h3>${linked ? 'Add a reaction you forgot' : 'Add a moment you forgot to tag'}</h3>
      <div class="row3" style="margin-top:10px">
        <input type="text" id="eMin" inputmode="${isMatch ? 'text' : 'numeric'}" placeholder="${isMatch ? '67 / 45+2' : 'min'}" aria-label="${isMatch ? 'Match minute' : 'Minutes from start'}"/>
        <select id="eKind" aria-label="Kind">${tagDefs
          .map((d) => `<option value="${d.key}">${esc(d.team ? `Goal ${s.teams[d.team]}` : d.key === 'free' ? 'Other (type below)' : d.label)}</option>`)
          .join('')}</select>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="eLabel" placeholder="Label (optional)" maxlength="60"/><button class="btn" id="eAdd">Add</button></div>
      <p class="small muted" style="margin:8px 0 0">${isMatch ? 'Match minute, e.g. 67 or 90+3.' : 'Minutes after you started, e.g. 12.'}</p>
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
    const label = $('#eLabel').value.trim() || (def.key === 'free' ? 'Note' : linked ? 'Reaction' : def.label);
    const tag = { id: uid(), t, key: def.key, label, color: def.color || FREE_TAG.color, manual: true, cat: def.cat || (def.team ? null : def.key), catLabel: def.catLabel || def.label };
    if (linked && isMatch) tag.label = `${matchMinute(s, t)} ${label}`;
    if (def.team) tag.team = def.team;
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
    const btn = $('#eSave');
    btn.disabled = true;
    s.notes = $('#eNotes').value.trim();
    if (s.event && s.event.id !== 'demo') {
      btn.innerHTML = '<span class="spinner"></span>Fetching final moments…';
      try {
        s.feed = await Promise.race([syncEvent(s.event, state.follow), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
      } catch {
        /* keep what we have; detail page can update later */
      }
    }
    const saved = finalize(s);
    await db.saveSession(saved);
    await db.clearLive();
    state.live = null;
    if (saved.type === 'workday') {
      const r = await scoreWorkday(saved);
      toast(r.total ? `${r.scored} of ${r.total} meetings scored` : 'Work day saved. No calendar meetings to score.');
      go('#/meetings');
      return;
    }
    runWriteup(saved.id, true);
    go(`#/session/${saved.id}`);
  });
}

function finalize(s) {
  const out = { ...s };
  delete out.ended;
  out.restingHr = state.settings.restingHr;
  out.endTs = s.endTs || Date.now();
  refreshAuto(out, Date.now());
  recomputeGoals(out);
  return out;
}

/* ---------------- Session detail ---------------- */

let detailRedraw = null; // set while a session page is open, so the AI result can refresh it

async function renderSession(id) {
  const my = routeSeq;
  let s = await db.getSession(id);
  if (my !== routeSeq) return;
  if (!s) {
    view.innerHTML = `<div class="topbar"><a class="iconbtn" href="#/history">${icon('back')}</a><h1>Not found</h1></div>`;
    return;
  }
  const type = typeOf(s.type);
  const rest = state.settings.restingHr;
  const linked = !!s.event;
  let heroUrl = null;
  if ((s.type === 'meeting' || s.type === 'workday') && !(await lockGate())) return;
  if (s.manual) return renderManualMeeting(s);
  const meetingHtml = async () => {
    if (s.type !== 'meeting') return '';
    const all = (await db.allSessions()).filter((x) => x.type === 'meeting');
    const ms = meetingStress(s, rest, deskBaseline(all, rest));
    return `<div class="card meetstat"><div class="grow"><div class="small muted">Above your baseline</div>
      <div class="big ${ms.elevation >= 10 ? 'hot' : ms.elevation >= 5 ? 'warm' : 'cool'}">${ms.elevation == null ? '–' : `${ms.elevation > 0 ? '+' : ''}${ms.elevation}`}<small> bpm</small></div>
      <div class="small muted">Baseline ${ms.baseline ?? '–'} bpm (${esc(baselineText(ms.baselineSource))}) · meeting average ${ms.avgHr ?? '–'} bpm</div></div>
      <a class="btn small" href="#/meetings">Stress board</a></div>
      <div class="card"><h3 style="margin-bottom:8px">Who was there</h3><div id="dPeople"></div>
      <button class="btn small" id="dSavePeople" style="margin-top:8px">Save people</button></div>`;
  };
  if (!s.manual) {
    refreshAuto(s, Date.now());
    db.saveSession(s).catch(() => {});
  }

  const draw = () => {
    const st = sessionStats(s, rest);
    const hasAi = !!(s.ai && s.ai.at);
    view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/history" aria-label="Back">${icon('back')}</a>
      <div class="grow"><div class="small muted">${esc(type.label)} · ${fmtDate(s.startTs)}${s.demo ? ' · Demo' : ''}</div>
      <h1 style="font-size:26px">${esc(displayTitle(s))}</h1></div></div>
    <a class="hero" id="dHero" target="_blank" rel="noopener" aria-label="Open the chart full size"><span class="spinner"></span>Drawing your chart…</a>
    ${detailInfoHtml(s)}
    <div class="detail-actions">
      <button class="btn primary" id="dShare">${icon('share')} Share</button>
      <button class="btn" id="wRegen">${icon('spark')} ${hasAi ? 'Re-analyse' : 'Analyse with AI'}</button>
    </div>
    <div class="explore" id="dExplore" ${s.samples && s.samples.length ? '' : 'hidden'}>
      <div class="explore-bar"><span class="grow">Tap a numbered marker to read it. Zoom to look closer.</span>
        <button class="btn small" data-zoom="1">1×</button><button class="btn small" data-zoom="2">2×</button><button class="btn small" data-zoom="4">4×</button></div>
      <div class="explore-scroll" id="dExploreSvg"></div>
      <div class="explore-cap" id="dExploreCap">Tap a marker on the chart.</div>
    </div>
    <div id="dMeeting"></div>
    ${
      s.type === 'workday'
        ? `<div class="card"><h3 style="margin-bottom:8px">${icon('cal')} Meetings this day</h3><p class="small muted" style="margin-top:0">${(s.calEvents || []).length} calendar meeting${(s.calEvents || []).length === 1 ? '' : 's'} recorded.</p><button class="btn small" id="wdScore">Score meetings again</button></div>`
        : ''
    }
    <div class="card ai-card"><h3 style="margin-bottom:10px">${icon('spark')} AI analysis</h3><div id="wBody" class="writeup"></div></div>
    ${
      linked
        ? `<div class="card tight delaycard"><div class="grow"><div class="small muted">Stream delay${s.calib && !s.calib.pending ? ' (synced)' : ''}</div><div class="num" style="font-size:22px;font-weight:700">${Math.round(
            (s.delayMs ?? 0) / 1000,
          )} s</div></div>
          <button class="btn small" data-delay="-60">−1 min</button><button class="btn small" data-delay="-10">−10 s</button><button class="btn small" data-delay="10">+10 s</button><button class="btn small" data-delay="60">+1 min</button>
          ${s.event.id !== 'demo' ? '<button class="btn small" id="dSync">Update moments</button>' : ''}</div>`
        : ''
    }
    <div class="stats" style="margin:14px 0">
      <div class="stat"><div class="v">${fmtDur(st.durationMs)}</div><div class="k">Recorded</div></div>
      <div class="stat"><div class="v">${st.avgHr ?? '--'}<small>bpm</small></div><div class="k">Average HR</div></div>
      <div class="stat"><div class="v">${st.peakHr ?? '--'}<small>bpm</small></div><div class="k">Peak HR</div>${st.peakContext ? `<div class="ctx">${esc(st.peakContext)}</div>` : ''}</div>
      <div class="stat"><div class="v">${fmtDur(st.aboveCalmMs)}</div><div class="k">Above calm (&gt;${st.calmCeiling})</div></div>
    </div>
    <div class="card"><h3 style="margin-bottom:8px">My notes</h3>
      <textarea id="dNotes" placeholder="Add notes…">${esc(s.notes || '')}</textarea>
      <button class="btn small" id="dSaveNotes" style="margin-top:8px">Save notes</button></div>
    <p class="note-estimate">${STRESS_NOTE}${linked ? ' Times marked ~ are estimated from live data plus your stream delay.' : ''}</p>
    <button class="btn danger block" id="dDelete">Delete session</button>
  `;
    drawHero();
    bind();
    drawExplore(1);
    meetingHtml().then((h) => {
      const slot = $('#dMeeting');
      if (!slot || !h) return;
      slot.innerHTML = h;
      knownPeople().then((known) => {
        const pi = peopleInput($('#dPeople'), s.attendees || [], known);
        $('#dSavePeople').addEventListener('click', async () => {
          s.attendees = pi.get();
          await db.saveSession(s);
          toast('People saved');
        });
      });
    });
  };

  let zoom = 1;
  const drawExplore = (z = zoom) => {
    zoom = z;
    const box = $('#dExploreSvg');
    if (!box || !s.samples || !s.samples.length) return;
    const w = Math.max(320, Math.floor(box.clientWidth || 340));
    box.innerHTML = chartSvg(s, w * zoom, w < 500 ? 300 : 380, { restingHr: rest });
    $$('[data-zoom]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.zoom) === zoom));
  };
  view.addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]');
    if (z) return drawExplore(Number(z.dataset.zoom));
    const mk = e.target.closest && e.target.closest('.mk');
    if (!mk) return;
    const m = numberedMoments(s).find((x) => String(x.n) === mk.dataset.n);
    const cap = $('#dExploreCap');
    if (m && cap) cap.innerHTML = `<b style="color:${isLight(m.color) ? 'var(--text)' : m.color}">${m.n} · ${esc(m.timeLabel)}</b>${esc(m.label)}`;
  });
  let heroJob = 0;
  const drawHero = async () => {
    const job = ++heroJob;
    try {
      const blob = await renderShareImage(s, rest, 'classic');
      if (job !== heroJob || !$('#dHero')) return;
      if (heroUrl) URL.revokeObjectURL(heroUrl);
      heroUrl = URL.createObjectURL(blob);
      const hero = $('#dHero');
      hero.href = heroUrl;
      hero.innerHTML = `<img src="${heroUrl}" alt="${esc(storyLine(s))}">`;
    } catch (e) {
      const hero = $('#dHero');
      if (hero) hero.innerHTML = `<span class="error small">Couldn't draw the chart: ${esc(e.message)}</span>`;
    }
  };

  const bind = () => {
    renderWriteupBody(s);
    $('#wRegen').addEventListener('click', () => runWriteup(s.id, false));
    $('#dSaveNotes').addEventListener('click', async () => {
      const fresh = await db.getSession(s.id);
      fresh.notes = $('#dNotes').value.trim();
      await db.saveSession(fresh);
      s.notes = fresh.notes;
      toast('Notes saved');
    });
    $$('[data-delay]').forEach((b) =>
      b.addEventListener('click', async () => {
        s.delayMs = Math.max(0, Math.min(MAX_DELAY_MS, (s.delayMs ?? 0) + Number(b.dataset.delay) * 1000));
        s.delayCalibrated = true;
        s.calib = null;
        refreshAuto(s, Date.now());
        await db.saveSession(s);
        draw();
      }),
    );
    const sync = $('#dSync');
    if (sync)
      sync.addEventListener('click', async () => {
        sync.disabled = true;
        sync.innerHTML = '<span class="spinner"></span>Updating';
        try {
          s.feed = await syncEvent(s.event, state.follow);
          refreshAuto(s, Date.now());
          await db.saveSession(s);
          toast(`${s.tags.filter((g) => g.auto && g.cat !== 'reaction').length} moments from live data`);
          draw();
        } catch (e) {
          toast(`Couldn't update: ${e.message}`);
          sync.disabled = false;
          sync.textContent = 'Update moments';
        }
      });
    $('#dShare').addEventListener('click', () => shareSheet(s, rest));
    const wds = $('#wdScore');
    if (wds)
      wds.addEventListener('click', async () => {
        wds.disabled = true;
        try {
          if (state.settings.gcalClientId) {
            s.calEvents = await calendarEvents(state.settings.gcalClientId, ...dayRange(s.startTs), { interactive: true });
            applyCalendarBands(s);
            await db.saveSession(s);
          }
          const r = await scoreWorkday(s);
          toast(`${r.scored} of ${r.total} meetings scored`);
          go('#/meetings');
        } catch (e) {
          toast(e.message);
          wds.disabled = false;
        }
      });
    armButton($('#dDelete'), 'Tap again to delete', async () => {
      await db.deleteSession(s.id);
      toast('Session deleted');
      go('#/history');
    });
  };

  draw();
  detailRedraw = (fresh) => {
    if (location.hash !== `#/session/${id}`) return;
    s = fresh;
    draw();
  };
  cleanup = () => {
    detailRedraw = null;
    if (heroUrl) URL.revokeObjectURL(heroUrl);
  };

  // Fill in or refresh moments from live data (F1 timing is often published after the race;
  // a session saved before full time picks up the rest of the match).
  const stale = linked && s.event.id !== 'demo' && (!s.feed || !s.feed.status || !s.feed.status.completed) && Date.now() - (s.endTs || 0) < 3 * 24 * 3600 * 1000;
  if (stale) {
    try {
      s.feed = await syncEvent(s.event, state.follow);
      refreshAuto(s, Date.now());
      await db.saveSession(s);
      if (detailRedraw) detailRedraw(s);
    } catch {
      /* try again next time */
    }
  }
}

function renderWriteupBody(s) {
  const el = $('#wBody');
  if (!el) return;
  const regen = $('#wRegen');
  const plain = 'font-family:var(--txt);font-size:15px;font-weight:400';
  if (state.writeupBusy.has(s.id)) {
    el.innerHTML = `<p class="muted" style="${plain}"><span class="spinner"></span>Analysing the ${s.type === 'f1' ? 'race' : s.type === 'sport' ? 'match' : 'session'} and your heart rate…</p>`;
    if (regen) regen.disabled = true;
    return;
  }
  if (regen) regen.disabled = false;
  if (s.writeupError) {
    el.innerHTML = `<p class="error" style="${plain}">${esc(s.writeupError)}</p>${
      s.writeupErrorKind === 'nokey' || s.writeupErrorKind === 'auth' ? '<a href="#/settings" class="btn small">Open Settings</a>' : ''
    }`;
    return;
  }
  if (s.writeup && s.writeup.text) {
    el.innerHTML =
      s.writeup.text
        .split(/\n\s*\n/)
        .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('') +
      (s.ai && s.ai.caption ? `<div class="ai-caption"><div class="small muted">Suggested post</div><p>${esc(s.ai.caption)}</p></div>` : '') +
      `<p class="small muted" style="${plain};font-size:12px">By ${esc(s.writeup.model)} · ${new Date(s.writeup.createdAt).toLocaleString()}</p>`;
    return;
  }
  el.innerHTML = `<p class="muted" style="${plain}">${
    state.settings.apiKey
      ? 'Tap <b>Analyse with AI</b>: Claude studies the match and your heart rate, writes the caption for every moment on the chart, explains your heart-rate spikes and drafts a post to share.'
      : 'Add your Anthropic API key in Settings and Claude will analyse the match and your heart rate, caption every moment on the chart and draft a post to share.'
  }</p>`;
}

async function runWriteup(id, auto) {
  if (state.writeupBusy.has(id)) return;
  const s = await db.getSession(id);
  if (!s) return;
  if (auto && (!state.settings.apiKey || !state.settings.featAutoAnalyse)) {
    renderWriteupBody(s);
    return;
  }
  refreshAuto(s, Date.now());
  state.writeupBusy.add(id);
  renderWriteupBody(s);
  try {
    const w = await generateWriteup(s, state.settings);
    const fresh = (await db.getSession(id)) || s;
    fresh.writeup = { text: w.text, model: w.model, createdAt: w.createdAt };
    if (w.ai) {
      fresh.ai = w.ai;
      if (!fresh.shareCaption && w.ai.caption) fresh.shareCaption = '';
    }
    delete fresh.writeupError;
    delete fresh.writeupErrorKind;
    refreshAuto(fresh, Date.now());
    await db.saveSession(fresh);
    state.writeupBusy.delete(id);
    if (detailRedraw) detailRedraw(fresh);
  } catch (e) {
    const fresh = (await db.getSession(id)) || s;
    state.writeupBusy.delete(id);
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

/* ---------------- Share sheet (social formats + caption) ---------------- */

function shareSheet(s, rest) {
  let format = 'classic';
  try {
    format = localStorage.getItem('pulse.shareFormat') || 'classic';
  } catch {
    /* ignore */
  }
  if (!SHARE_FORMATS[format]) format = 'classic';
  const cache = {};
  let url = null;
  const caption = s.shareCaption || (s.ai && s.ai.caption) || buildCaption(s, rest);
  const m = showModal(`
    <h2>Share</h2>
    <div class="fmt" id="shFmt" role="tablist">${Object.entries(SHARE_FORMATS)
      .map(([k, f]) => `<button role="tab" data-f="${k}"><b>${esc(f.label)}</b><span>${esc(f.hint)}</span></button>`)
      .join('')}</div>
    <div class="preview" id="shPrev"><span class="spinner"></span></div>
    <label class="field" style="margin:12px 0 0"><span>Caption</span>
      <textarea id="shCap" rows="5">${esc(caption)}</textarea></label>
    <p class="small muted" style="margin:6px 0 0">WhatsApp and X take the caption with the image. Instagram and LinkedIn don't, so Pulse copies it: just paste it in.</p>
    <div class="actions">
      <button class="btn primary" id="shGo" style="min-height:58px;font-size:17px" disabled>${icon('share')} Share image + caption</button>
      <div class="row2"><button class="btn" id="shCopy">Copy caption</button><button class="btn" id="shSave">Save image</button></div>
      <button class="btn ghost" id="shClose">Close</button>
    </div>`);
  m.querySelector('.sheet').classList.add('wide');
  const setTabs = () => $$('#shFmt button', m).forEach((b) => b.classList.toggle('on', b.dataset.f === format));
  const render = async () => {
    setTabs();
    $('#shGo', m).disabled = true;
    const prev = $('#shPrev', m);
    prev.innerHTML = '<span class="spinner"></span>';
    prev.dataset.f = format;
    const f = format;
    try {
      cache[f] = cache[f] || (await renderShareImage(s, rest, f));
    } catch (e) {
      prev.innerHTML = `<p class="error small">Couldn't create the image: ${esc(e.message)}</p>`;
      return;
    }
    if (f !== format || !$('#shPrev')) return;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(cache[f]);
    prev.innerHTML = `<img src="${url}" alt="Share preview: ${esc(SHARE_FORMATS[f].label)}">`;
    $('#shGo', m).disabled = false;
  };
  const cap = () => $('#shCap', m).value.trim();
  const fileName = () => exportFileName(s).replace(/\.png$/, format === 'classic' ? '.png' : `-${format}.png`);
  const copyCaption = () => {
    try {
      if (navigator.clipboard) return navigator.clipboard.writeText(cap()).then(() => true, () => false);
    } catch {
      /* ignore */
    }
    return Promise.resolve(false);
  };
  const remember = async () => {
    if (cap() === (s.shareCaption || '')) return;
    s.shareCaption = cap();
    const fresh = await db.getSession(s.id);
    if (fresh) {
      fresh.shareCaption = s.shareCaption;
      await db.saveSession(fresh);
    }
  };
  $('#shFmt', m).addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b || b.dataset.f === format) return;
    format = b.dataset.f;
    try {
      localStorage.setItem('pulse.shareFormat', format);
    } catch {
      /* ignore */
    }
    render();
  });
  $('#shGo', m).addEventListener('click', async () => {
    const blob = cache[format];
    if (!blob) return;
    const copied = copyCaption(); // inside the tap, before sharing
    const res = await shareOrDownload(blob, fileName(), displayTitle(s), cap());
    remember();
    if (res === 'downloaded') toast((await copied) ? 'Image saved, caption copied' : 'Image saved to Downloads');
    else if (res === 'shared') toast((await copied) ? 'Shared. Caption is also copied' : 'Shared');
  });
  $('#shCopy', m).addEventListener('click', async () => {
    toast((await copyCaption()) ? 'Caption copied' : 'Select the caption and copy it');
    remember();
  });
  $('#shSave', m).addEventListener('click', () => {
    if (!cache[format]) return;
    downloadBlob(cache[format], fileName());
    toast('Image saved to Downloads');
  });
  $('#shClose', m).addEventListener('click', () => {
    remember();
    if (url) URL.revokeObjectURL(url);
    hideModal();
  });
  render();
}

/* ---------------- Work day (all-day recording + calendar) ---------------- */

async function startWorkday() {
  if (state.live && !state.live.ended) {
    toast('A session is already running');
    return go('#/live');
  }
  const now = Date.now();
  const s = {
    id: uid(),
    type: 'workday',
    title: `Work day · ${new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`,
    mode: 'doing',
    startTs: now,
    endTs: null,
    restingHr: state.settings.restingHr,
    samples: [],
    tags: [],
    bands: [],
    notes: '',
    writeup: null,
    calEvents: [],
  };
  state.live = s;
  state.undo = [];
  await db.saveLive(s);
  go('#/live');
  refreshWorkdayCalendar(s, true);
}

function dayRange(t) {
  const a = new Date(t);
  a.setHours(0, 0, 0, 0);
  return [a.getTime(), a.getTime() + 24 * 3600e3];
}

async function refreshWorkdayCalendar(s, interactive = false) {
  if (!state.settings.gcalClientId) {
    const el = $('#wdCal');
    if (el) el.innerHTML = '<p class="small muted">Connect Google Calendar in Settings and your meetings appear here and get scored automatically. You can still add meetings manually afterwards.</p>';
    return;
  }
  try {
    const [a, b] = dayRange(s.startTs);
    s.calEvents = await calendarEvents(state.settings.gcalClientId, a, b, { interactive });
    applyCalendarBands(s);
    db.saveLive(s).catch(() => {});
    refreshLive(true);
  } catch (e) {
    const el = $('#wdCal');
    if (el) el.innerHTML = `<p class="small error">${esc(e.message)}</p><button class="btn small" id="wdConnect">Connect Google Calendar</button>`;
    const c = $('#wdConnect');
    if (c) c.addEventListener('click', () => refreshWorkdayCalendar(s, true));
  }
}

function applyCalendarBands(s) {
  s.bands = [
    ...(s.bands || []).filter((b) => b.key !== 'meeting'),
    ...(s.calEvents || []).map((e) => ({ key: 'meeting', label: e.title, color: '#a78bfa', start: e.start, end: e.end, auto: true, cal: true })),
  ];
}

function workdayCalHtml(s, now) {
  const evs = s.calEvents || [];
  if (!evs.length) return '<p class="small muted">No meetings found for today yet.</p>';
  return `<ol class="wdlist">${evs
    .map((e) => {
      const st = now >= e.end ? 'done' : now >= e.start ? 'now' : 'next';
      return `<li class="${st}"><span class="wt">${esc(clockTime(e.start))}–${esc(clockTime(e.end))}</span><span class="wn">${esc(e.title)}${
        e.attendees.length ? `<small>${esc(e.attendees.slice(0, 4).join(', '))}${e.attendees.length > 4 ? ` +${e.attendees.length - 4}` : ''}</small>` : ''
      }</span><span class="ws">${st === 'now' ? 'NOW' : st === 'done' ? '✓' : ''}</span></li>`;
    })
    .join('')}</ol>`;
}

/** Turn a finished work day into scored meeting sessions. Returns how many were scored. */
async function scoreWorkday(day) {
  const events = day.calEvents || [];
  const scores = scoreDayMeetings(day.samples || [], events);
  for (const sc of scores) {
    const e = sc.event;
    const from = e.start - 20 * 60000;
    const to = e.end + 20 * 60000;
    const sess = {
      id: `cal-${e.id}`,
      type: 'meeting',
      title: e.title,
      mode: 'doing',
      startTs: Math.max(from, day.startTs),
      endTs: Math.min(to, day.endTs || to),
      restingHr: state.settings.restingHr,
      samples: day.samples.filter((x) => x.t >= from && x.t <= to),
      tags: [],
      bands: [],
      notes: '',
      writeup: null,
      attendees: e.attendees,
      phases: { meetingStart: e.start },
      calScore: { dbpm: sc.dbpm, baseline: sc.baseline, baseStd: sc.baseStd, z: sc.z, elevatedShare: sc.elevatedShare, coverage: sc.coverage, avgHr: sc.avgHr, peakHr: sc.peakHr, minutes: sc.minutes },
      calendarEvent: { id: e.id, start: e.start, end: e.end },
      workdayId: day.id,
    };
    const prev = await db.getSession(sess.id);
    if (prev) {
      sess.notes = prev.notes || '';
      sess.writeup = prev.writeup || null;
      sess.ai = prev.ai;
    }
    await db.saveSession(sess);
  }
  return { scored: scores.length, total: events.length };
}

/* ---------------- Meeting stress board ---------------- */

const baselineText = (src) =>
  src === 'day' ? 'your heart rate in the 90 min around it, outside meetings' : src === 'measured' ? 'measured before it started' : src === 'usual' ? 'your usual desk baseline' : src === 'entered' ? 'entered' : 'estimated from resting HR';

async function knownPeople() {
  const all = await db.allSessions();
  const count = new Map();
  for (const x of all) for (const n of x.attendees || []) count.set(n, (count.get(n) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** Chip input for people. Returns { get() }. */
function peopleInput(el, initial, known) {
  let list = [...initial];
  const id = 'pl' + Math.random().toString(36).slice(2, 7);
  const draw = () => {
    el.innerHTML = `<div class="peoplechips">${list
      .map((n, i) => `<span class="pchip">${esc(n)}<button type="button" aria-label="Remove ${esc(n)}" data-i="${i}">×</button></span>`)
      .join('')}<input type="text" list="${id}" placeholder="${list.length ? 'Add another…' : 'Type a name, press Enter'}" maxlength="40" autocomplete="off" enterkeyhint="done"/></div>
      <datalist id="${id}">${known.filter((n) => !list.includes(n)).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
    const input = $('input', el);
    const addNow = () => {
      const v = input.value.replace(/,/g, ' ').trim();
      if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
      draw();
      $('input', el).focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addNow();
      } else if (e.key === 'Backspace' && !input.value && list.length) {
        list.pop();
        draw();
        $('input', el).focus();
      }
    });
    input.addEventListener('change', () => {
      if (known.includes(input.value.trim())) addNow();
    });
    $$('[data-i]', el).forEach((b) =>
      b.addEventListener('click', () => {
        list.splice(Number(b.dataset.i), 1);
        draw();
      }),
    );
  };
  draw();
  return {
    get: () => {
      const v = $('input', el) && $('input', el).value.trim();
      if (v && !list.includes(v)) list.push(v);
      return list;
    },
  };
}

function meetingRows(meetings) {
  const rest = state.settings.restingHr;
  const desk = deskBaseline(meetings, rest);
  return meetings
    .map((m) => ({ id: m.id, title: m.title, date: m.startTs, attendees: m.attendees || [], manual: !!m.manual, ...meetingStress(m, rest, desk) }))
    .sort((a, b) => b.date - a.date);
}

const stressClass = (e) => (e == null ? '' : e >= 10 ? 'hot' : e >= 5 ? 'warm' : 'cool');

async function renderMeetings() {
  const my = routeSeq;
  if (!(await lockGate())) return;
  const all = (await db.allSessions()).filter((x) => x.type === 'meeting');
  if (my !== routeSeq) return;
  const rows = meetingRows(all);
  const scored = rows.filter((r) => r.elevation != null);
  const ranked = [...scored].sort((a, b) => b.elevation - a.elevation);
  const people = peopleEffects(scored.map((r) => ({ elevation: r.elevation, attendees: r.attendees })));
  if (state.hideNames == null) state.hideNames = !!state.settings.hideNamesDefault;
  const hide = !!state.hideNames;
  const alias = new Map(people.map((p, i) => [p.name, `Person ${String.fromCharCode(65 + (i % 26))}`]));
  const nm = (n) => (hide ? alias.get(n) || 'Someone' : n);
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mask = (t) => (hide ? people.reduce((acc, pp) => acc.replace(new RegExp(`(^|[^\\p{L}])${reEsc(pp.name)}(?![\\p{L}])`, 'giu'), `$1${alias.get(pp.name)}`), t) : t);
  const maxAbs = Math.max(4, ...ranked.map((r) => Math.abs(r.elevation)));
  const maxEff = Math.max(2, ...people.map((p) => Math.abs(p.effect)));
  const avg = scored.length ? Math.round((scored.reduce((a, r) => a + r.elevation, 0) / scored.length) * 10) / 10 : null;

  view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/" aria-label="Back">${icon('back')}</a><h1 class="grow">Meeting stress</h1></div>
    <button class="btn primary block" id="mWorkday" style="min-height:58px;font-size:16.5px;margin-bottom:8px">${icon('cal')} Start work day</button>
    <p class="small muted" style="margin:0 2px 12px">Records your heart rate all day (phone on its charger, Pulse open) and scores every meeting in your Google Calendar automatically.</p>
    <div class="row2" style="margin-bottom:12px">
      <a class="btn" href="#/start/meeting">${icon('chat')} One meeting</a>
      <button class="btn" id="mAdd">+ Add manually</button>
    </div>
    ${
      !rows.length
        ? `<div class="empty">No meetings yet. Record one (start 2–3 minutes early for a baseline) or add one manually with the average heart rate from your WHOOP app.<br><br><button class="btn small" id="mDemo">Load 10 demo meetings</button></div>`
        : `
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><div class="v">${rows.length}</div><div class="k">Meetings</div></div>
      <div class="stat"><div class="v">${avg == null ? '–' : `${avg > 0 ? '+' : ''}${avg}`}<small>bpm</small></div><div class="k">Average above baseline</div></div>
    </div>
    <div class="chart-card mboard">
      <div class="cc-head"><div class="cc-title">STRESS GRAPH · EVERY MEETING</div><div class="cc-key"><span>BPM ABOVE BASELINE</span></div></div>
      <ol class="mbars">${ranked
        .map(
          (r) => `<li><a href="#/session/${r.id}">
          <div class="mb-top"><span class="mb-title">${esc(mask(r.title))}</span><span class="mb-val ${stressClass(r.elevation)}">${r.elevation > 0 ? '+' : ''}${r.elevation}</span></div>
          <div class="mb-bar"><i class="${stressClass(r.elevation)}" style="width:${Math.max(2, (Math.abs(r.elevation) / maxAbs) * 100)}%"></i></div>
          <div class="mb-meta">${fmtDate(r.date)} · ${r.durationMin ?? '–'} min${r.attendees.length ? ` · ${esc(r.attendees.map(nm).join(', '))}` : ''}${r.manual ? ' · added manually' : ''}</div></a></li>`,
        )
        .join('')}</ol>
    </div>
    <div class="chart-card mboard">
      <div class="cc-head"><div class="cc-title">WHO RAISES YOUR HEART RATE</div>
        <label class="toggle mini"><span>Hide names</span><input type="checkbox" id="mHide" ${hide ? 'checked' : ''}/><i></i></label></div>
      ${
        people.length
          ? `<ol class="mpeople">${people
              .map(
                (pp, i) => `<li><span class="rank">${i + 1}</span><span class="pname">${esc(nm(pp.name))}</span>
              <span class="pbar"><i class="${pp.effect >= 0 ? 'up' : 'down'}" style="width:${(Math.abs(pp.effect) / maxEff) * 50}%"></i></span>
              <span class="peff ${pp.effect >= 0 ? 'up' : 'down'}">${pp.effect > 0 ? '+' : ''}${pp.effect}</span><span class="pn">${pp.meetings} mtg${pp.meetings > 1 ? 's' : ''}</span></li>`,
              )
              .join('')}</ol>
          <p class="small muted" style="margin:8px 8px 4px">Each person's estimated extra bpm when they're in the meeting, separated from who else was there (regression over all your meetings). People with fewer meetings are pulled towards 0.</p>`
          : '<p class="small muted" style="margin:8px">Add who was in each meeting to see this.</p>'
      }
    </div>
    <div class="banner warn small">A higher heart rate in a meeting is not proof that a person causes stress. Topic, time pressure, sleep, caffeine, exercise or having to present all play a part. Treat this as a personal signal to look into, not a verdict on anyone.</div>
    <button class="btn block" id="mShare" style="margin-top:12px">${icon('share')} Share stress board${hide ? ' (names hidden)' : ''}</button>`
    }
  `;
  $('#mAdd').addEventListener('click', () => manualMeetingSheet());
  $('#mWorkday').addEventListener('click', () => startWorkday());
  const demoBtn = $('#mDemo');
  if (demoBtn)
    demoBtn.addEventListener('click', async () => {
      for (const m of demoMeetingWeek(state.settings.restingHr)) await db.saveSession(m);
      renderMeetings();
    });
  const hideEl = $('#mHide');
  if (hideEl)
    hideEl.addEventListener('change', () => {
      state.hideNames = hideEl.checked;
      renderMeetings();
    });
  const share = $('#mShare');
  if (share)
    share.addEventListener('click', async () => {
      share.disabled = true;
      try {
        const blob = await renderMeetingBoard(ranked.map((r) => ({ ...r, title: mask(r.title) })), people, { nameOf: nm });
        const res = await shareOrDownload(blob, `pulse-meeting-stress-${new Date().toISOString().slice(0, 10)}.png`, 'My meeting stress board', 'My heart rate in every meeting, ranked. #WHOOP #Pulse');
        if (res === 'downloaded') toast('Image saved to Downloads');
      } catch (e) {
        toast('Could not create image: ' + e.message);
      } finally {
        share.disabled = false;
      }
    });
}

async function manualMeetingSheet(existing = null) {
  const known = await knownPeople();
  const all = (await db.allSessions()).filter((x) => x.type === 'meeting');
  const desk = deskBaseline(all, state.settings.restingHr);
  const e = existing || {};
  const m = e.manual || {};
  const d = new Date(existing ? existing.startTs : Date.now() - 60 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const dateVal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeVal = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sheet = showModal(`
    <h2>${existing ? 'Edit meeting' : 'Add a meeting'}</h2>
    <p class="small muted">For meetings you didn't record in Pulse. Open the WHOOP app's heart-rate graph for that time and copy the average (and peak) while the meeting ran.</p>
    <label class="field"><span>Title</span><input type="text" id="mmTitle" maxlength="80" value="${esc(e.title || '')}" placeholder="Weekly sync"/></label>
    <div class="row2"><label class="field"><span>Date</span><input type="date" id="mmDate" value="${dateVal}"/></label>
      <label class="field"><span>Start</span><input type="time" id="mmTime" value="${timeVal}"/></label></div>
    <div class="row2"><label class="field"><span>Duration (min)</span><input type="number" id="mmDur" min="5" max="480" inputmode="numeric" value="${esc(m.durationMin || 30)}"/></label>
      <label class="field"><span>Average HR (bpm)</span><input type="number" id="mmAvg" min="40" max="200" inputmode="numeric" value="${esc(m.avgHr || '')}" placeholder="82"/></label></div>
    <div class="row2"><label class="field"><span>Peak HR (optional)</span><input type="number" id="mmPeak" min="40" max="220" inputmode="numeric" value="${esc(m.peakHr || '')}"/></label>
      <label class="field"><span>Your baseline (optional)</span><input type="number" id="mmBase" min="40" max="150" inputmode="numeric" value="${esc(m.baselineHr || '')}" placeholder="${Math.round(desk || state.settings.restingHr + 8)}"/></label></div>
    <div class="field"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Who was there?</span><div id="mmPeople"></div></div>
    <div class="actions">
      <button class="btn primary" id="mmSave">Save meeting</button>
      <button class="btn ghost" id="mmCancel">Cancel</button>
    </div>`);
  sheet.querySelector('.sheet').classList.add('wide');
  const pi = peopleInput($('#mmPeople', sheet), e.attendees || [], known);
  $('#mmCancel', sheet).addEventListener('click', hideModal);
  $('#mmSave', sheet).addEventListener('click', async () => {
    const title = $('#mmTitle', sheet).value.trim() || 'Meeting';
    const start = new Date(`${$('#mmDate', sheet).value}T${$('#mmTime', sheet).value || '09:00'}`).getTime();
    const dur = parseInt($('#mmDur', sheet).value, 10);
    const avgHr = parseInt($('#mmAvg', sheet).value, 10);
    const peakHr = parseInt($('#mmPeak', sheet).value, 10) || null;
    const baselineHr = parseInt($('#mmBase', sheet).value, 10) || null;
    if (!Number.isFinite(start)) return toast('Pick a date and time');
    if (!(dur >= 5 && dur <= 480)) return toast('Duration should be 5–480 minutes');
    if (!(avgHr >= 40 && avgHr <= 200)) return toast('Enter the average heart rate from WHOOP');
    const sess = {
      ...(existing || {}),
      id: existing ? existing.id : uid(),
      type: 'meeting',
      title,
      mode: 'doing',
      startTs: start,
      endTs: start + dur * 60000,
      restingHr: state.settings.restingHr,
      samples: [],
      tags: [],
      bands: [],
      notes: existing ? existing.notes || '' : '',
      attendees: pi.get(),
      manual: { avgHr, peakHr, baselineHr, durationMin: dur },
    };
    await db.saveSession(sess);
    hideModal();
    toast(existing ? 'Meeting updated' : 'Meeting added');
    if (location.hash === '#/meetings') renderMeetings();
    else go('#/meetings');
  });
}

async function renderManualMeeting(s) {
  const my = routeSeq;
  const rest = state.settings.restingHr;
  const all = (await db.allSessions()).filter((x) => x.type === 'meeting');
  if (my !== routeSeq) return;
  const ms = meetingStress(s, rest, deskBaseline(all, rest));
  view.innerHTML = `
    <div class="topbar"><a class="iconbtn" href="#/meetings" aria-label="Back">${icon('back')}</a>
      <div class="grow"><div class="small muted">Meeting · added manually · ${fmtDate(s.startTs)} ${clockTime(s.startTs)}</div><h1 style="font-size:26px">${esc(s.title)}</h1></div></div>
    <div class="card meetstat"><div class="grow"><div class="small muted">Above your baseline</div>
      <div class="big ${stressClass(ms.elevation)}">${ms.elevation > 0 ? '+' : ''}${ms.elevation}<small> bpm</small></div>
      <div class="small muted">Average ${ms.avgHr} bpm${ms.peakHr ? ` · peak ${ms.peakHr}` : ''} · baseline ${ms.baseline} (${esc(baselineText(ms.baselineSource))}) · ${ms.durationMin} min</div></div></div>
    <div class="card"><h3 style="margin-bottom:8px">Who was there</h3><p style="margin:0">${(s.attendees || []).map(esc).join(', ') || '<span class="muted">Nobody added</span>'}</p></div>
    <div style="display:grid;gap:8px">
      <button class="btn block" id="mmEdit">Edit meeting</button>
      <button class="btn danger block" id="dDelete">Delete meeting</button>
    </div>`;
  $('#mmEdit').addEventListener('click', () => manualMeetingSheet(s));
  armButton($('#dDelete'), 'Tap again to delete', async () => {
    await db.deleteSession(s.id);
    toast('Meeting deleted');
    go('#/meetings');
  });
}

/* ---------------- Helpers: reminders, weekly, info chips, lock ---------------- */

const APP_URL = () => location.origin + location.pathname;

function downloadIcs(evs, name) {
  const ics = buildIcs(evs.map((e) => fixtureToEvent(e, APP_URL())), { alarmMin: Number(state.settings.reminderMin) || 15 });
  downloadBlob(new Blob([ics], { type: 'text/calendar' }), name);
}

function detailInfoHtml(s) {
  const q = dataQuality(s);
  const wd = whoop.dayFor(s.startTs);
  const qText = q ? { good: 'Good data', fair: 'Fair data', poor: 'Patchy data' }[q.level] : '';
  const qTip = q ? `Heart rate ${q.hrPct}% of the time · HRV ${q.rrPct}%${q.lostMin ? ` · ${q.lostMin} min lost` : ''}` : '';
  const chips = wd
    ? [
        wd.recovery != null ? `<span>Recovery<b>${wd.recovery}%</b></span>` : '',
        wd.sleepPerf != null ? `<span>Sleep<b>${wd.sleepPerf}%</b></span>` : '',
        wd.hrv != null ? `<span>HRV<b>${Math.round(wd.hrv)} ms</b></span>` : '',
        wd.rhr != null ? `<span>Resting<b>${wd.rhr}</b></span>` : '',
      ].join('')
    : '';
  if (!q && !chips) return '';
  return `<div class="whoopday">${q ? `<span class="quality ${q.level}" title="${esc(qTip)}"><i></i>${qText} · ${q.hrPct}% HR · ${q.rrPct}% HRV</span>` : ''}${chips ? `${chips}<span class="muted">WHOOP that day</span>` : ''}</div>`;
}

function weeklyHtml(sessions) {
  if (!state.settings.featWeekly) return '';
  const since = Date.now() - 7 * 864e5;
  const week = sessions.filter((x) => x.startTs >= since);
  if (!week.length) return '';
  const rest = state.settings.restingHr;
  const stats = week.map((x) => ({ s: x, st: sessionStats(x, rest) }));
  const recorded = stats.reduce((a, x) => a + (x.s.samples && x.s.samples.length ? x.st.durationMs : 0), 0);
  const games = stats.filter((x) => (x.s.type === 'sport' || x.s.type === 'f1') && x.st.peakHr).sort((a, b) => b.st.peakHr - a.st.peakHr);
  const meetings = meetingRows(week.filter((x) => x.type === 'meeting')).filter((r) => r.elevation != null);
  const hardest = [...meetings].sort((a, b) => b.elevation - a.elevation)[0];
  const calm = stats.filter((x) => x.st.avgTension != null).sort((a, b) => a.st.avgTension - b.st.avgTension)[0];
  const locked = state.settings.lockOn && !isUnlocked();
  const row = (k, v) => `<div class="wk-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return `<div class="weekcard"><div class="wk-head"><b>This week</b><span class="small muted">${week.length} session${week.length > 1 ? 's' : ''} · ${fmtDur(recorded)} recorded</span></div>
    ${games[0] ? row('Biggest game', `${esc(displayTitle(games[0].s))} · peak ${games[0].st.peakHr} bpm`) : ''}
    ${hardest && !locked ? row('Toughest meeting', `${esc(hardest.title)} · +${hardest.elevation} bpm`) : ''}
    ${calm ? row('Calmest', `${esc(displayTitle(calm.s))} · stress ${calm.st.avgTension.toFixed(1)}`) : ''}
  </div>`;
}

/** Returns true when meetings may be shown; otherwise renders the lock screen. */
async function lockGate() {
  const st = state.settings;
  if (!st.lockOn || !st.lockPinHash || isUnlocked()) return true;
  const my = routeSeq;
  const bio = st.lockBioId && (await biometricAvailable());
  if (my !== routeSeq) return false;
  view.innerHTML = `<div class="topbar"><a class="iconbtn" href="#/" aria-label="Back">${icon('back')}</a><h1 class="grow">Meetings are locked</h1></div>
    <div class="lockscreen">${icon('lock')}
      <p class="muted" style="margin:0">Enter your PIN${bio ? ' or use your fingerprint' : ''} to see meeting stress.</p>
      <input type="password" id="lkPin" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN"/>
      <button class="btn primary" id="lkGo" style="min-width:220px">Unlock</button>
      ${bio ? `<button class="btn" id="lkBio" style="min-width:220px">Use fingerprint</button>` : ''}
    </div>`;
  const done = () => {
    markUnlocked(15);
    route();
  };
  const tryPin = async () => {
    if (await checkPin($('#lkPin').value, st.lockPinHash)) done();
    else {
      toast('Wrong PIN');
      $('#lkPin').value = '';
    }
  };
  $('#lkGo').addEventListener('click', tryPin);
  $('#lkPin').addEventListener('keydown', (e) => e.key === 'Enter' && tryPin());
  if (bio)
    $('#lkBio').addEventListener('click', async () => {
      try {
        if (await verifyBiometric(st.lockBioId)) done();
      } catch {
        toast('Fingerprint not recognised. Use your PIN.');
      }
    });
  setTimeout(() => $('#lkPin') && $('#lkPin').focus(), 50);
  return false;
}

/* ---------------- Settings: apply, WHOOP sync, onboarding ---------------- */

function applySettings() {
  const st = state.settings;
  configureAnalysis({
    reactions: !!st.featReactions,
    meetSkipMin: Number(st.meetSkipMin) || 0,
    meetBaselineMin: Number(st.meetBaselineMin) || 90,
    meetMinCoverage: (Number(st.meetMinCoverage) || 50) / 100,
  });
  configureFeeds({ bigChances: !!st.featBigChances, apiFootballKey: st.apiFootballKey || '', openf1User: st.openf1User || '', openf1Pass: st.openf1Pass || '' });
  const sys = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const theme = st.theme === 'system' ? sys : st.theme || 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('large', st.textSize === 'large');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5f9' : '#0b0d12');
}

async function updatePersonalScale() {
  if (!state.settings.featPersonalScale) {
    state.scaleBpm = 15;
  } else {
    try {
      state.scaleBpm = personalScale(await db.allSessions(), state.settings.restingHr);
    } catch {
      state.scaleBpm = 15;
    }
  }
  configureAnalysis({ scaleBpm: state.scaleBpm });
}

async function whoopSync(force = false) {
  const st = state.settings;
  if (!st.whoopRelay || !whoop.isConnected()) return null;
  if (!force && Date.now() - whoop.lastSync() < 6 * 3600e3) return null;
  const r = await whoop.sync(st.whoopRelay);
  if (st.whoopAutoRhr && r.latest && r.latest.rhr && r.latest.rhr !== st.restingHr) {
    state.settings = { ...state.settings, restingHr: r.latest.rhr };
    saveSettings(state.settings);
  }
  return r;
}

function renderWhoopCallback() {
  const r = whoop.handleCallback(location.hash);
  history.replaceState(null, '', '#/settings');
  if (!r.ok) {
    toast(`WHOOP connection failed (${r.error})`);
    return renderSettings();
  }
  toast('WHOOP connected. Syncing your last 30 days…');
  renderSettings();
  whoopSync(true)
    .then((x) => {
      toast(x && x.latest ? `WHOOP synced · resting HR ${x.latest.rhr} · recovery ${x.latest.recovery}%` : 'WHOOP synced');
      if (location.hash === '#/settings') renderSettings();
    })
    .catch((e) => toast(e.message));
}

function showOnboarding() {
  const steps = [
    {
      t: 'Welcome to Pulse',
      h: `<p>Pulse records your heart rate from your WHOOP strap while you watch your teams, race on with your drivers or sit in meetings, then shows exactly which moments moved you.</p>
        <p class="small muted">Four quick steps. You can change everything later in Settings.</p>`,
    },
    {
      t: 'Connect your strap',
      h: `<p>In the WHOOP app turn on <b>Heart Rate Broadcast</b>. Then connect it here.</p>
        <button class="btn primary block" id="obStrap">Connect strap</button>
        <p class="small muted">You can do this later from the chip at the top of Home.</p>`,
    },
    {
      t: 'Your resting heart rate',
      h: `<p>Copy it from WHOOP (Recovery). Pulse uses it for stress and your calm zone.</p>
        <input type="number" id="obRhr" min="30" max="120" inputmode="numeric" value="${esc(state.settings.restingHr)}" style="font-family:var(--num);font-size:28px;text-align:center"/>
        <p class="small muted">Connect WHOOP in Settings later and this updates itself every day.</p>`,
    },
    {
      t: 'What you follow',
      h: `<p>${esc(state.follow.teams.map((t) => t.name).join(', '))}${state.follow.drivers.length ? ` and ${esc(state.follow.drivers.map((d) => d.name).join(', '))}` : ''}, plus every game in ${state.follow.competitions.length} competitions.</p>
        <p class="small muted">Change it any time in the Following tab.</p>`,
    },
    {
      t: 'Optional extras',
      h: `<p><b>Google Calendar</b> scores every meeting automatically in Work day mode.<br><b>WHOOP account</b> adds recovery, sleep and resting HR.<br><b>AI analysis</b> writes the captions and your post.</p>
        <p class="small muted">All three are in Settings, each with step-by-step help.</p>`,
    },
  ];
  let i = 0;
  const draw = () => {
    const st = steps[i];
    const m = showModal(`<div class="onb"><div class="step">Step ${i + 1} of ${steps.length}</div><div class="dots">${steps.map((_, j) => `<i class="${j <= i ? 'on' : ''}"></i>`).join('')}</div>
      <h2>${st.t}</h2>${st.h}
      <div class="actions"><button class="btn primary" id="obNext">${i === steps.length - 1 ? 'Start using Pulse' : 'Next'}</button>
      ${i > 0 ? '<button class="btn ghost" id="obBack">Back</button>' : '<button class="btn ghost" id="obSkip">Skip setup</button>'}</div></div>`);
    m.onclick = null;
    const strapBtn = $('#obStrap', m);
    if (strapBtn) strapBtn.addEventListener('click', () => connectStrap(false));
    const finish = () => {
      state.settings = { ...state.settings, onboarded: true };
      saveSettings(state.settings);
      hideModal();
      route();
    };
    $('#obNext', m).addEventListener('click', () => {
      const rhr = $('#obRhr', m);
      if (rhr) {
        const v = parseInt(rhr.value, 10);
        if (v >= 30 && v <= 120) {
          state.settings = { ...state.settings, restingHr: v };
          saveSettings(state.settings);
        }
      }
      if (i === steps.length - 1) return finish();
      i++;
      draw();
    });
    const back = $('#obBack', m);
    if (back) back.addEventListener('click', () => ((i -= 1), draw()));
    const skip = $('#obSkip', m);
    if (skip) skip.addEventListener('click', finish);
  };
  draw();
}

/* ---------------- History ---------------- */

async function renderHistory() {
  const my = routeSeq;
  const all = await db.allSessions();
  if (my !== routeSeq) return;
  const rest = state.settings.restingHr;
  for (const s of all) s.statsCache = sessionStats(s, rest);
  const f = state.historyFilter;
  const list = f === 'all' ? all : all.filter((s) => s.type === f);

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
        byType.every((x) => x.avgTen != null) ? ' Average stress: ' + byType.map((x) => `${x.label.toLowerCase()} ${x.avgTen.toFixed(1)}`).join(', ') + '.' : ''
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

/* ---------------- Following ---------------- */

let teamIndex = null;
let driverIndex = null;

function renderFollowing() {
  const f = state.follow;
  const save = () => {
    saveFollow(f);
    state.fixtures = null;
    state.fixturesAt = 0;
  };
  view.innerHTML = `
    <div class="topbar"><h1 class="grow">Following</h1></div>
    <p class="muted" style="margin-top:-6px">Games and races for these show up on Home. Tap Watch and Pulse logs the moments for you.</p>
    <div class="section-title"><h3>Your teams</h3></div>
    <div class="card">
      <div class="followchips" id="teamChips">${f.teams
        .map((t) => `<span class="fchip">${img(t.logo, 'crest')}${esc(t.name)}<button aria-label="Remove ${esc(t.name)}" data-rmteam="${esc(t.id)}">×</button></span>`)
        .join('') || '<span class="muted small">No teams yet</span>'}</div>
      <input type="text" id="teamSearch" placeholder="Add a team: search clubs or countries" autocomplete="off" style="margin-top:12px"/>
      <div id="teamResults" class="results"></div>
    </div>
    <div class="section-title"><h3>Every game in</h3></div>
    <div class="card complist">
      ${Object.entries(COMPETITIONS)
        .map(
          ([slug, name]) =>
            `<label class="toggle"><span>${esc(name)}</span><input type="checkbox" data-comp="${slug}" ${f.competitions.includes(slug) ? 'checked' : ''}/><i></i></label>`,
        )
        .join('')}
    </div>
    <div class="section-title"><h3>Formula 1</h3></div>
    <div class="card">
      <label class="toggle"><span>Show F1 races & sprints</span><input type="checkbox" id="f1On" ${f.f1 ? 'checked' : ''}/><i></i></label>
      <div class="field" style="margin-top:10px"><span class="muted small" style="display:block;margin-bottom:6px;font-weight:500">Your drivers</span>
        <div class="followchips" style="margin-bottom:10px">${f.drivers
          .map((d) => `<span class="fchip">${icon('flag')}${esc(d.name)}<button aria-label="Remove ${esc(d.name)}" data-rmdriver="${esc(d.last)}">×</button></span>`)
          .join('') || '<span class="muted small">No drivers yet</span>'}</div>
        <select id="driverSel"><option>Loading drivers…</option></select></div>
    </div>
  `;
  $$('[data-rmteam]').forEach((b) =>
    b.addEventListener('click', () => {
      f.teams = f.teams.filter((t) => t.id !== b.dataset.rmteam);
      save();
      renderFollowing();
    }),
  );
  $$('[data-comp]').forEach((c) =>
    c.addEventListener('change', () => {
      const slug = c.dataset.comp;
      f.competitions = c.checked ? [...new Set([...f.competitions, slug])] : f.competitions.filter((x) => x !== slug);
      save();
    }),
  );
  $('#f1On').addEventListener('change', (e) => {
    f.f1 = e.target.checked;
    save();
  });
  const search = $('#teamSearch');
  const results = $('#teamResults');
  search.addEventListener('focus', async () => {
    if (!teamIndex) {
      results.innerHTML = '<p class="small muted"><span class="spinner"></span>Loading teams…</p>';
      try {
        teamIndex = await searchableTeams([...new Set([...TEAM_SEARCH_LEAGUES, ...f.competitions])]);
        results.innerHTML = '';
      } catch {
        results.innerHTML = '<p class="small error">Couldn\'t load teams.</p>';
      }
    }
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!teamIndex || q.length < 2) return (results.innerHTML = '');
    const hits = teamIndex.filter((t) => t.name.toLowerCase().includes(q) && !f.teams.some((x) => x.id === t.id)).slice(0, 8);
    results.innerHTML = hits.length
      ? hits.map((t) => `<button class="result" data-addteam="${esc(t.id)}">${img(t.logo, 'crest')}<span>${esc(t.name)}</span><span class="muted small">${esc(COMPETITIONS[t.league] || '')}</span></button>`).join('')
      : '<p class="small muted">No match.</p>';
    $$('[data-addteam]', results).forEach((b) =>
      b.addEventListener('click', () => {
        const t = teamIndex.find((x) => x.id === b.dataset.addteam);
        f.teams.push(t);
        save();
        toast(`Following ${t.name}`);
        renderFollowing();
      }),
    );
  });
  const sel = $('#driverSel');
  (async () => {
    try {
      driverIndex = driverIndex || (await currentDrivers());
      sel.innerHTML =
        '<option value="">+ Add a driver…</option>' +
        driverIndex
          .slice()
          .filter((d) => !f.drivers.some((x) => x.last === d.last))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => `<option value="${esc(d.last)}">${esc(d.name)}${d.team ? ` · ${esc(d.team)}` : ''}</option>`)
          .join('');
    } catch {
      /* keep current */
    }
  })();
  sel.addEventListener('change', () => {
    const d = (driverIndex || []).find((x) => x.last === sel.value);
    if (d) {
      f.drivers = [...f.drivers.filter((x) => x.last !== d.last), { name: d.name, last: d.last }];
      save();
      toast(`Following ${d.name}`);
      renderFollowing();
    }
  });
  $$('[data-rmdriver]').forEach((b) =>
    b.addEventListener('click', () => {
      f.drivers = f.drivers.filter((x) => x.last !== b.dataset.rmdriver);
      save();
      renderFollowing();
    }),
  );
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  const st = state.settings;
  const tog = (key, title, sub = '') =>
    `<div class="set-row"><div class="lbl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div><label class="toggle"><input type="checkbox" data-set="${key}" ${st[key] ? 'checked' : ''} aria-label="${esc(title)}"/><i></i></label></div>`;
  const num = (key, title, sub, min, max, unit = '') =>
    `<div class="set-row"><div class="lbl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div><span><input type="number" data-set="${key}" data-num="1" min="${min}" max="${max}" inputmode="numeric" value="${esc(st[key])}" aria-label="${esc(title)}"/>${unit ? ` <span class="small muted">${unit}</span>` : ''}</span></div>`;
  const sel = (key, title, opts, sub = '') =>
    `<div class="set-row"><div class="lbl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div><select data-set="${key}" aria-label="${esc(title)}">${opts
      .map(([v, l]) => `<option value="${v}" ${String(st[key]) === v ? 'selected' : ''}>${l}</option>`)
      .join('')}</select></div>`;
  const txt = (key, title, sub, ph = '', secret = false) =>
    `<div class="set-row stack"><div class="lbl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div><input type="${secret ? 'password' : 'text'}" data-set="${key}" placeholder="${esc(ph)}" value="${esc(st[key] || '')}" autocomplete="off" spellcheck="false" aria-label="${esc(title)}"/></div>`;
  const group = (ic, title, rows) => `<div class="set-group"><h3>${icon(ic)} ${title}</h3><div class="set-card">${rows.join('')}</div></div>`;
  const wConn = whoop.isConnected();
  const wLast = whoop.lastSync();

  view.innerHTML = `
    <div class="topbar"><h1 class="grow">Settings</h1></div>
    <div class="saved-note" id="savedNote">Changes save automatically</div>
    ${group('heart', 'You', [
      num('restingHr', 'Resting heart rate', st.whoopAutoRhr && wConn ? 'Updated daily from WHOOP' : 'Copy it from WHOOP (Recovery)', 30, 120, 'bpm'),
      tog('featPersonalScale', 'Personal stress scale', `Scale stress to your own heart-rate range once you have 8+ recordings. Now: 1 stress point = ${state.scaleBpm || 15} bpm above resting.`),
    ])}
    ${group('gear', 'Display', [
      sel('theme', 'Theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match my phone']], 'Charts and share images stay dark, like the reference.'),
      sel('textSize', 'Text size', [['normal', 'Normal'], ['large', 'Large']]),
    ])}
    ${group('heart', 'Heart-rate strap', [
      `<div class="set-row"><div class="lbl"><b>${esc(strapLabel())}</b><span>WHOOP → Device settings → Heart Rate Broadcast</span></div><button class="btn small" id="sStrap" type="button">${state.strapStatus === 'connected' ? 'Change' : 'Connect'}</button></div>`,
    ])}
    ${group('ball', 'Live sport data', [
      num('delaySec', 'Stream delay', 'Set automatically when you use Sync stream', 0, 600, 's'),
      tog('featBigChances', 'Big chances', 'Add close-range shots and woodwork as moments'),
      num('reminderMin', 'Reminder', 'How long before kick-off calendar reminders alert you', 0, 180, 'min'),
      `<div class="set-row"><div class="lbl"><b>Teams, competitions, drivers</b><span>${esc(state.follow.teams.length + ' teams · ' + state.follow.competitions.length + ' competitions · ' + state.follow.drivers.length + ' drivers')}</span></div><a class="btn small" href="#/following">Edit</a></div>`,
      txt('apiFootballKey', 'Backup live scores (API-Football key)', 'Optional. Used only when ESPN is unavailable. Free key at dashboard.api-football.com.', 'Paste key', true),
      txt('openf1User', 'OpenF1 account (real-time F1)', 'Optional. A paid OpenF1 account gives live race data; without it F1 moments fill in after the race.', 'Username'),
      txt('openf1Pass', 'OpenF1 password', 'Stored only on this phone.', 'Password', true),
    ])}
    ${group('cal', 'Google Calendar', [
      txt('gcalClientId', 'Google OAuth client ID', 'Read-only, straight from Google to this phone.', '1234-abc.apps.googleusercontent.com'),
      `<div class="set-row"><div class="lbl"><b>Connection</b><span id="sGcalStatus">${gcalConnected() ? 'Connected' : 'Not connected'} · <a href="https://github.com/joelmadeira26/stress-tracking-whoop#google-calendar-setup" target="_blank" rel="noopener">setup guide</a></span></div>
        <span><button class="btn small" id="sGcalGo" type="button">${gcalConnected() ? 'Reconnect' : 'Connect'}</button> <button class="btn small ghost" id="sGcalOff" type="button" ${gcalConnected() ? '' : 'disabled'}>Disconnect</button></span></div>`,
      tog('calAutoRefresh', 'Keep calendar in sync', 'Refresh meetings every 15 minutes during a work day'),
    ])}
    ${group('heart', 'WHOOP account (official API)', [
      txt('whoopRelay', 'Relay URL', 'Your Cloudflare relay that talks to WHOOP. See the setup guide.', 'https://pulse-whoop.yourname.workers.dev'),
      `<div class="set-row"><div class="lbl"><b>Connection</b><span>${wConn ? `Connected${wLast ? ` · last sync ${new Date(wLast).toLocaleString()}` : ''}` : 'Not connected'} · <a href="https://github.com/joelmadeira26/stress-tracking-whoop/tree/main/relay#readme" target="_blank" rel="noopener">setup guide</a></span></div>
        <span>${wConn ? '<button class="btn small" id="sWhoopSync" type="button">Sync now</button> <button class="btn small ghost" id="sWhoopOff" type="button">Disconnect</button>' : '<button class="btn small" id="sWhoopGo" type="button">Connect</button>'}</span></div>`,
      tog('whoopAutoRhr', 'Update resting heart rate from WHOOP', 'Daily, from your latest recovery'),
    ])}
    ${group('chat', 'Meetings', [
      num('meetSkipMin', 'Ignore the first minutes', 'Walking in or setting up isn’t stress', 0, 10, 'min'),
      num('meetBaselineMin', 'Baseline window (work day)', 'Minutes before and after each meeting, outside other meetings', 30, 180, 'min'),
      num('meetMinCoverage', 'Minimum heart-rate coverage', 'Skip meetings with less recorded data than this', 20, 100, '%'),
      tog('hideNamesDefault', 'Hide names by default', 'People appear as Person A, B… on the stress board and in shares'),
      tog('lockOn', 'Lock meetings', st.lockPinHash ? 'PIN set. Fingerprint optional below.' : 'You’ll set a PIN'),
      `<div class="set-row"><div class="lbl"><b>Fingerprint / face unlock</b><span>${st.lockBioId ? 'Registered on this phone' : 'Unlock meetings without typing the PIN'}</span></div><button class="btn small" id="sBio" type="button" ${st.lockOn ? '' : 'disabled'}>${st.lockBioId ? 'Re-register' : 'Set up'}</button></div>`,
    ])}
    ${group('spark', 'AI analysis', [
      txt('apiKey', 'Anthropic API key', 'Stored only on this phone, sent only to api.anthropic.com. About one US cent per analysis.', 'sk-ant-…', true),
      txt('model', 'AI model', '', 'claude-sonnet-5-5'),
      tog('featAutoAnalyse', 'Analyse automatically', 'Run the AI analysis when you save a session'),
    ])}
    ${group('star', 'Features', [
      tog('featReactions', '“Your reaction” moments', 'Detect heart-rate spikes that no event explains'),
      tog('featWeekly', 'Weekly summary on Home', ''),
    ])}
    <div class="set-group"><h3>${icon('list')} Demo sessions</h3><div class="set-card" style="padding:12px 16px;display:grid;gap:8px">
      ${Object.entries(SESSION_TYPES)
        .filter(([k]) => DEMOS[k])
        .map(([k, t]) => `<button class="btn block" data-demo="${k}">${icon(t.icon)} Load ${esc(t.label.toLowerCase())} demo</button>`)
        .join('')}
      <button class="btn block" id="demoMeetings">${icon('chat')} Load meeting stress demo (10 meetings)</button>
    </div></div>
    <div class="set-group"><h3>${icon('list')} Your data</h3><div class="set-card" style="padding:12px 16px;display:grid;gap:8px">
      <button class="btn block" id="sExport">Export all data (JSON)</button>
      <label class="btn block" for="sImport">Restore from an export…</label><input type="file" id="sImport" accept="application/json,.json" hidden/>
      <button class="btn block" id="sOnboard">Run the setup guide again</button>
      <button class="btn danger block" id="sClear">Clear all data</button>
      <p class="small muted" style="margin:4px 0 0">Everything lives on this phone (IndexedDB). Live football data: ESPN (backup: API-Football). F1: OpenF1 (unofficial, not associated with Formula 1).</p>
    </div></div>
    <p class="note-estimate">${STRESS_NOTE}</p>
    <p class="small muted">Pulse · <a href="https://github.com/joelmadeira26/stress-tracking-whoop">source</a></p>
  `;

  let noteTimer;
  const saved = () => {
    const n = $('#savedNote');
    if (!n) return;
    n.textContent = 'Saved ✓';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n && (n.textContent = 'Changes save automatically'), 1500);
  };
  const LIMITS = { restingHr: [30, 120], delaySec: [0, 600], reminderMin: [0, 180], meetSkipMin: [0, 10], meetBaselineMin: [30, 180], meetMinCoverage: [20, 100] };
  $$('[data-set]').forEach((el) => {
    el.addEventListener('change', async () => {
      const key = el.dataset.set;
      let v = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (el.dataset.num) {
        v = parseInt(v, 10);
        const [lo, hi] = LIMITS[key] || [0, 1e9];
        if (!(v >= lo && v <= hi)) {
          toast(`Choose between ${lo} and ${hi}`);
          el.value = state.settings[key];
          return;
        }
      }
      if (key === 'lockOn' && v && !state.settings.lockPinHash) {
        el.checked = false;
        return setPinSheet(() => renderSettings());
      }
      if (key === 'model' && !v) v = 'claude-sonnet-5-5';
      state.settings = { ...state.settings, [key]: v };
      saveSettings(state.settings);
      applySettings();
      if (key === 'featPersonalScale' || key === 'restingHr') await updatePersonalScale();
      if (key === 'lockOn' && v) markUnlocked(15);
      saved();
      if (['lockOn', 'featPersonalScale', 'whoopRelay'].includes(key)) renderSettings();
    });
  });

  $('#sStrap').addEventListener('click', () => connectStrap(false));
  $('#sGcalGo').addEventListener('click', async () => {
    const id = (state.settings.gcalClientId || '').trim();
    if (!id) return toast('Paste your Google client ID first');
    try {
      const now = Date.now();
      const evs = await calendarEvents(id, now - 12 * 3600e3, now + 24 * 3600e3, { interactive: true });
      $('#sGcalStatus').textContent = `Connected. ${evs.length} meeting${evs.length === 1 ? '' : 's'} today and tomorrow.`;
      $('#sGcalOff').disabled = false;
      toast('Google Calendar connected');
    } catch (e) {
      $('#sGcalStatus').textContent = e.message;
    }
  });
  $('#sGcalOff').addEventListener('click', () => {
    gcalDisconnect();
    $('#sGcalStatus').textContent = 'Disconnected.';
    $('#sGcalOff').disabled = true;
  });
  const wGo = $('#sWhoopGo');
  if (wGo)
    wGo.addEventListener('click', () => {
      try {
        whoop.login(state.settings.whoopRelay);
      } catch (e) {
        toast(e.message);
      }
    });
  const wSync = $('#sWhoopSync');
  if (wSync)
    wSync.addEventListener('click', async () => {
      wSync.disabled = true;
      try {
        const r = await whoopSync(true);
        toast(r && r.latest ? `Synced · resting HR ${r.latest.rhr} · recovery ${r.latest.recovery}%` : 'Synced');
        renderSettings();
      } catch (e) {
        toast(e.message);
        wSync.disabled = false;
      }
    });
  const wOff = $('#sWhoopOff');
  if (wOff)
    wOff.addEventListener('click', () => {
      whoop.disconnect();
      toast('WHOOP disconnected');
      renderSettings();
    });
  $('#sBio').addEventListener('click', async () => {
    if (!(await biometricAvailable())) return toast('This phone has no fingerprint or face unlock for websites');
    try {
      const id = await registerBiometric();
      state.settings = { ...state.settings, lockBioId: id };
      saveSettings(state.settings);
      toast('Fingerprint unlock ready');
      renderSettings();
    } catch {
      toast('Fingerprint setup was cancelled');
    }
  });
  $$('[data-demo]').forEach((b) =>
    b.addEventListener('click', async () => {
      const x = DEMOS[b.dataset.demo](state.settings.restingHr);
      await db.saveSession(x);
      toast('Demo loaded');
      go(`#/session/${x.id}`);
    }),
  );
  $('#demoMeetings').addEventListener('click', async () => {
    for (const m of demoMeetingWeek(state.settings.restingHr)) await db.saveSession(m);
    toast('10 demo meetings loaded');
    go('#/meetings');
  });
  $('#sExport').addEventListener('click', async () => {
    const all = await db.allSessions();
    const secret = ['apiKey', 'apiFootballKey', 'openf1Pass', 'lockPinHash', 'lockBioId'];
    const settings = Object.fromEntries(Object.entries(state.settings).filter(([k]) => !secret.includes(k)));
    downloadBlob(new Blob([JSON.stringify({ app: 'Pulse', version: 2, exportedAt: new Date().toISOString(), settings, follow: state.follow, sessions: all })], { type: 'application/json' }), `pulse-export-${new Date().toISOString().slice(0, 10)}.json`);
  });
  $('#sImport').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'Pulse' || !Array.isArray(data.sessions)) throw new Error('Not a Pulse export');
      for (const x of data.sessions) if (x && x.id && x.type && Array.isArray(x.samples)) await db.saveSession(x);
      if (data.follow && Array.isArray(data.follow.teams)) {
        state.follow = { ...state.follow, ...data.follow };
        saveFollow(state.follow);
      }
      if (data.settings) {
        state.settings = { ...state.settings, ...data.settings, onboarded: true };
        saveSettings(state.settings);
        applySettings();
      }
      toast(`Restored ${data.sessions.length} sessions`);
      renderSettings();
    } catch (err) {
      toast(`Couldn't restore: ${err.message}`);
    }
  });
  $('#sOnboard').addEventListener('click', showOnboarding);
  armButton($('#sClear'), 'Tap again to delete everything', async () => {
    await db.clearSessions();
    await db.clearLive();
    state.live = null;
    toast('All sessions deleted');
    renderSettings();
  });
}

function setPinSheet(done) {
  const m = showModal(`<h2>Set a PIN for meetings</h2><p class="small muted">4–8 digits. It's stored only as a scrambled hash on this phone.</p>
    <input type="password" id="pin1" inputmode="numeric" maxlength="8" placeholder="PIN" style="font-family:var(--num);font-size:26px;text-align:center;letter-spacing:.3em"/>
    <input type="password" id="pin2" inputmode="numeric" maxlength="8" placeholder="Repeat PIN" style="font-family:var(--num);font-size:26px;text-align:center;letter-spacing:.3em;margin-top:8px"/>
    <div class="actions"><button class="btn primary" id="pinSave">Lock meetings</button><button class="btn ghost" id="pinCancel">Cancel</button></div>`);
  $('#pinCancel', m).addEventListener('click', hideModal);
  $('#pinSave', m).addEventListener('click', async () => {
    const a = $('#pin1', m).value;
    const b = $('#pin2', m).value;
    if (!/^\d{4,8}$/.test(a)) return toast('Use 4–8 digits');
    if (a !== b) return toast("PINs don't match");
    state.settings = { ...state.settings, lockOn: true, lockPinHash: await hashPin(a) };
    saveSettings(state.settings);
    markUnlocked(15);
    hideModal();
    toast('Meetings locked with your PIN');
    done();
  });
}

/* ---------------- Boot ---------------- */

$$('#tabbar [data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

async function boot() {
  applySettings();
  updatePersonalScale();
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applySettings);
  whoopSync(false).catch(() => {});
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
      if (location.hash === '#/live' || location.hash === '#/end') history.replaceState(null, '', '#/');
      await route();
      const m = showModal(`
        <h2>Resume your session?</h2>
        <p class="muted">"${esc(displayTitle(live))}" started at ${clockTime(live.startTs)} (${fmtDur(Date.now() - live.startTs)} ago) with ${live.samples.length} heart-rate readings saved.</p>
        <div class="actions">
          <button class="btn primary" data-r="resume">Resume</button>
          <button class="btn" data-r="end">End it and review</button>
          <button class="btn danger" data-r="discard">Discard</button>
        </div>`);
      m.onclick = null;
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
      return;
    }
  } else if (location.hash === '#/live' || location.hash === '#/end') {
    location.hash = '#/';
  }
  await route();
  if (!state.settings.onboarded && !/^#\/whoop/.test(location.hash)) showOnboarding();
}
boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for automated tests / debugging.
window.__pulse = { state, strap, db, aggregator, applyFeed, whoop };
