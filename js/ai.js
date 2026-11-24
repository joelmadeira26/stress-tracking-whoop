// AI write-up via the Anthropic Messages API, called straight from the browser.
import { SESSION_TYPES } from './config.js';
import {
  bucketHr,
  tensionSeries,
  allBands,
  numberedMoments,
  sessionEnd,
  sessionStats,
  momentTimeLabel,
  clockTime,
  displayTitle,
  recoveryAfterTags,
  findGaps,
} from './analysis.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';

// Models that accept server-side refusal fallbacks (falls back to another model if one declines).
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2']);

const SYSTEM = `You write short, friendly session recaps for Pulse, a personal heart-rate and stress journal fed by a WHOOP strap.
Write in plain English, second person ("you"), like a knowledgeable friend who coaches.
Use only the data given. Refer to moments by their time or match minute and label.
"Stress" is Pulse's own 0-3 estimate from heart rate and HRV, not WHOOP's Stress Monitor; 0 is calm, 1 is mildly elevated, 2 is clearly stressed or working hard, 3 is very high.
Moments marked source "live data" came from the official match or race feed; "you" means the person tagged their own reaction.
No medical claims or diagnoses. No markdown: no asterisks, hashes, bullet symbols or bold. Plain sentences only.

Structure (separate parts with a blank line, no headings):
1. A one-line headline.
2. Where your heart rate and stress peaked and what was happening then.
3. Where you were calmest.
4. How you recovered after the big moments (how fast your heart rate came back down).
5. The type-specific part: for meetings, how you were when speaking vs listening; for workouts, effort per set and recovery between sets; for football and F1, which moments hit hardest (and how your team or driver's moments compared with the opponent's).
6. One practical takeaway, starting with "Takeaway:".
Keep it under 230 words.`;

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Everything the model needs, compact. */
export function buildSessionData(session, restingHr) {
  const type = SESSION_TYPES[session.type];
  const start = session.startTs;
  const end = sessionEnd(session);
  const stats = sessionStats(session, restingHr);
  const hr30 = bucketHr(session.samples, start, end, 30000);
  const ten = tensionSeries(session, restingHr).series;
  const tenAt = new Map(ten.map((p) => [Math.round((p.t - start) / 30000), p.value]));

  const series = hr30.map((b, i) => ({
    time: type.clock === 'match' ? momentTimeLabel(session, b.t) + ' ' + clockTime(b.t) : clockTime(b.t),
    hrAvg: b.avg == null ? null : Math.round(b.avg),
    hrMax: b.max,
    stress: round1(tenAt.get(i + 1)),
  }));

  const data = {
    sessionType: type.label,
    watchingOrDoing: session.mode,
    title: session.title,
    displayTitle: displayTitle(session),
    date: new Date(start).toDateString(),
    timeRange: `${clockTime(start)}-${clockTime(end)}`,
    durationMinutes: Math.round((end - start) / 60000),
    restingHr,
    calmCeilingBpm: stats.calmCeiling,
    summary: {
      avgHr: stats.avgHr,
      peakHr: stats.peakHr,
      peakAt: stats.peakT ? momentTimeLabel(session, stats.peakT) : null,
      peakContext: stats.peakContext,
      lowestHr10sAvg: stats.minHr,
      minutesAboveCalm: Math.round(stats.aboveCalmMs / 60000),
      avgStress: round1(stats.avgTension),
      peakStress: round1(stats.peakTension),
      peakStressAt: stats.peakTensionT ? momentTimeLabel(session, stats.peakTensionT) : null,
    },
    moments: numberedMoments(session).map((g) => ({ n: g.n, time: g.timeLabel, label: g.label, category: g.catLabel || null, source: g.auto ? 'live data' : 'you', addedAfterwards: !!g.manual })),
    bands: allBands(session).map((b) => ({ label: b.label, from: momentTimeLabel(session, b.start), to: momentTimeLabel(session, b.end) })),
    signalGaps: findGaps(session.samples, start, end).map((g) => ({ from: clockTime(g.start), to: clockTime(g.end) })),
    recoveryAfterMoments: recoveryAfterTags(session),
    myNotes: session.notes || '',
    series30s: series,
  };
  if (session.event) {
    data.event = { competition: session.event.competition, name: displayTitle(session) };
    if (session.feed && session.feed.myDriver) data.myDriver = session.feed.myDriver.full;
    if (session.feed && session.feed.result) data.myDriverResult = session.feed.result;
  }
  if (session.teams) {
    data.teams = { home: session.teams.home, away: session.teams.away, myTeam: session.teams[session.teams.mine] || null };
    data.finalScore = `${session.score.home}-${session.score.away}`;
  }
  return data;
}

export function buildRequest(session, settings) {
  const model = (settings.model || 'claude-sonnet-5-5').trim();
  const data = buildSessionData(session, settings.restingHr);
  const body = {
    model,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: `Here is my session data as JSON. Write my recap.\n\n${JSON.stringify(data)}`,
      },
    ],
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey.trim(),
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  return { url: API_URL, headers, body };
}

/** Remove any markdown the model slips in. */
export function cleanText(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[ \t]*[-*•][ \t]+/gm, '')
    .replace(/`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class WriteupError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

async function post(req, fetchImpl) {
  try {
    return await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    throw new WriteupError("Couldn't reach Anthropic. Check your internet connection and try again.", 'network');
  }
}

export async function generateWriteup(session, settings, fetchImpl = fetch.bind(globalThis)) {
  if (!settings.apiKey || !settings.apiKey.trim()) {
    throw new WriteupError('Add your Anthropic API key in Settings to get a write-up.', 'nokey');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new WriteupError("You're offline. Connect to the internet and tap Regenerate.", 'network');
  }
  let req = buildRequest(session, settings);
  let res = await post(req, fetchImpl);
  let json = await res.json().catch(() => ({}));

  // If this model/account doesn't accept the fallback option, retry once without it.
  if (res.status === 400 && req.body.fallbacks && /fallback|beta/i.test(json?.error?.message || '')) {
    delete req.body.fallbacks;
    delete req.headers['anthropic-beta'];
    res = await post(req, fetchImpl);
    json = await res.json().catch(() => ({}));
  }

  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new WriteupError('Your API key was rejected. Check it in Settings (it starts with "sk-ant-").', 'auth');
    if (res.status === 403) throw new WriteupError(`This key isn't allowed to do that: ${msg}`, 'auth');
    if (res.status === 404) throw new WriteupError(`Model not found: "${req.body.model}". Check the model name in Settings.`, 'model');
    if (res.status === 429) throw new WriteupError('Rate limit or credit limit reached. Wait a minute or check your Anthropic billing.', 'rate');
    if (res.status === 529 || res.status >= 500) throw new WriteupError('Anthropic is busy right now. Try Regenerate in a minute.', 'server');
    throw new WriteupError(`The write-up failed: ${msg}`, 'api');
  }
  if (json.stop_reason === 'refusal') {
    throw new WriteupError('The model declined to write this one. Try Regenerate, or edit your notes.', 'refusal');
  }
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new WriteupError('The model returned an empty write-up. Try Regenerate.', 'empty');
  return { text: cleanText(text), model: json.model || req.body.model, createdAt: Date.now() };
}
