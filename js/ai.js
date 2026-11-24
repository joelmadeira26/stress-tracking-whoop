// AI write-up via the Anthropic Messages API, called straight from the browser.
import { SESSION_TYPES, typeOf } from './config.js';
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

import { dayFor } from './whoop.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';

// Models that accept server-side refusal fallbacks (falls back to another model if one declines).
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2']);

const SYSTEM = `You are Pulse's analyst. Pulse records a person's heart rate from their WHOOP strap while they watch football or F1 (or sit in a meeting), and lines it up with what happened, from live match or race data.
You turn the data into the captions of a shareable chart, like a live blog of the event and of the person's body.

Return JSON with:
- "moments": one entry for EVERY moment in the input, with the same "id". Each "text" is at most 110 characters, in this style:
    "Lap 2: Russell passes Max; Max retakes it around the outside at the last corner"
    "Formation lap begins. Your stress and heart rate start climbing"
    "77': Deniz Gül heads Galatasaray in from a corner; your heart rate jumps to 118"
    "10:02 Budget review starts with Marco and Priya; your heart rate climbs 14 bpm above your baseline"
    "Tough question on the numbers; your heart rate hits 96"
  Keep the minute ("77'") or lap ("Lap 19:") at the start when the original label has one. Say what happened using only facts in the input (label, detail, context lines). Where the heart-rate series (series30s rows: time, avg, max, stress) clearly reacts around that time, add a short body note ("your heart rate jumps to 118", "stress peaks"). For moments with source "your body", explain what was going on at that time from the context and describe the body's reaction. Never invent players, scores, events or numbers.
- "headline": one punchy line about the session.
- "writeup": 120 to 200 words in second person ("you"), plain sentences, paragraphs separated by a blank line: where heart rate and stress peaked and why; when you were calmest; how fast you recovered after the big moments; which moments hit hardest (your team or driver vs the opponent); end with one practical takeaway starting "Takeaway:".
- "caption": a social media post in first person ("I tracked my heart rate and stress during ..."), at most 260 characters, mentioning the peak heart rate and the moment that caused it, then 3 to 6 relevant hashtags at the end (include #WHOOP). At most two emoji. No @mentions.

If "whoopThatDay" is present, mention briefly when low recovery or poor sleep may explain a higher heart rate.
"Stress" is Pulse's own 0-3 estimate from heart rate and HRV (not WHOOP's Stress Monitor): 0 calm, 1 mildly elevated, 2 clearly stressed, 3 very high.
No medical claims. No markdown anywhere.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moments', 'headline', 'writeup', 'caption'],
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    headline: { type: 'string' },
    writeup: { type: 'string' },
    caption: { type: 'string' },
  },
};

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Everything the model needs, compact. */
export function buildSessionData(session, restingHr) {
  const type = typeOf(session.type);
  const start = session.startTs;
  const end = sessionEnd(session);
  const stats = sessionStats(session, restingHr);
  const hr30 = bucketHr(session.samples, start, end, 30000);
  const ten = tensionSeries(session, restingHr).series;
  const tenAt = new Map(ten.map((p) => [Math.round((p.t - start) / 30000), p.value]));

  // Compact table (rows of [time, avg, max, stress]); skips empty buckets. Keeps each analysis cheap.
  const series = {
    columns: ['time', 'hrAvg', 'hrMax', 'stress'],
    rows: hr30
      .map((b, i) => [
        type.clock === 'match' ? `${momentTimeLabel(session, b.t)} ${clockTime(b.t)}` : clockTime(b.t),
        b.avg == null ? null : Math.round(b.avg),
        b.max,
        round1(tenAt.get(i + 1)),
      ])
      .filter((r) => r[1] != null),
  };

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
    moments: numberedMoments(session).map((g) => {
      const fm = g.fid && session.feed ? (session.feed.moments || []).find((m) => m.fid === g.fid) : null;
      const near = session.samples.filter((x) => x.t >= g.t - 30000 && x.t <= g.t + 120000);
      return {
        id: g.id,
        n: g.n,
        time: g.timeLabel,
        label: g.baseLabel || g.label,
        category: g.catLabel || null,
        source: g.cat === 'reaction' && g.auto ? 'your body' : g.auto ? 'live data' : 'you',
        detail: fm && fm.detail ? fm.detail : undefined,
        maxHrNext2min: near.length ? Math.max(...near.map((x) => x.hr)) : null,
      };
    }),
    bands: allBands(session).map((b) => ({ label: b.label, from: momentTimeLabel(session, b.start), to: momentTimeLabel(session, b.end) })),
    signalGaps: findGaps(session.samples, start, end).map((g) => ({ from: clockTime(g.start), to: clockTime(g.end) })),
    recoveryAfterMoments: recoveryAfterTags(session),
    myNotes: session.notes || '',
    series30s: series,
  };
  if (session.event) {
    data.event = { competition: session.event.competition, name: displayTitle(session) };
    if (session.feed && session.feed.context && session.feed.context.length) data.eventContext = session.feed.context.slice(0, 140);
    data.youJoinedAt = clockTime(start);
    if (session.feed && session.feed.myDriver) data.myDriver = session.feed.myDriver.full;
    if (session.feed && session.feed.result) data.myDriverResult = session.feed.result;
  }
  const wd = dayFor(start);
  if (wd) data.whoopThatDay = wd; // recovery %, resting HR, HRV, sleep performance %
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
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: settings.aiEffort || 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Here is my session data as JSON. Analyse it.\n\n${JSON.stringify(data)}`,
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

  // If this model/account doesn't accept an optional feature, retry once without it.
  if (res.status === 400 && req.body.fallbacks && /fallback|beta/i.test(json?.error?.message || '')) {
    delete req.body.fallbacks;
    delete req.headers['anthropic-beta'];
    res = await post(req, fetchImpl);
    json = await res.json().catch(() => ({}));
  }
  if (res.status === 400 && req.body.output_config.format && /format|schema|output_config/i.test(json?.error?.message || '')) {
    delete req.body.output_config.format;
    req.body.messages[0].content += '\n\nReply with only the JSON object described in the instructions.';
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
  return parseAnalysis(text, json.model || req.body.model);
}

/** Turn the model's JSON into what Pulse stores. Falls back to plain text if it isn't JSON. */
export function parseAnalysis(text, model) {
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  const createdAt = Date.now();
  if (!obj || typeof obj !== 'object') return { text: cleanText(text), model, createdAt, ai: null };
  const moments = {};
  const reactions = {};
  const other = {};
  for (const it of Array.isArray(obj.moments) ? obj.moments : []) {
    if (!it || typeof it.id !== 'string' || typeof it.text !== 'string') continue;
    const t = cleanText(it.text).slice(0, 160);
    if (it.id.startsWith('f:')) moments[it.id.slice(2)] = t;
    else if (it.id.startsWith('r:')) reactions[it.id.slice(2)] = t;
    else other[it.id] = t;
  }
  const headline = cleanText(String(obj.headline || ''));
  const writeup = cleanText(String(obj.writeup || ''));
  return {
    text: [headline, writeup].filter(Boolean).join('\n\n'),
    model,
    createdAt,
    ai: { moments, reactions, other, headline, caption: String(obj.caption || '').replace(/\*\*/g, '').trim(), at: createdAt },
  };
}
