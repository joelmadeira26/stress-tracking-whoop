// Shareable PNG (2x): title, date/time range, chart, numbered legend, Pulse mark.
import { COLORS, SESSION_TYPES } from './config.js';
import { CanvasPainter, drawChart, FONT_NUM, FONT_TEXT } from './chart.js';
import { numberedMoments, displayTitle, clockTime, sessionEnd, legendCategories } from './analysis.js';

const W = 760; // logical px; exported at 2x
const PAD = 20;

async function ensureFonts() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`700 20px ${FONT_NUM}`),
      document.fonts.load(`400 12px ${FONT_TEXT}`),
      document.fonts.load(`600 12px ${FONT_TEXT}`),
      document.fonts.load(`700 12px ${FONT_TEXT}`),
    ]);
  } catch {
    /* system fonts */
  }
}

export function chartHeading(session) {
  const end = sessionEnd(session);
  const date = new Date(session.startTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `HEART RATE & STRESS — ${date.toUpperCase()}, ${clockTime(session.startTs)}–${clockTime(end)}`;
}

/** "Max Verstappen's race, Las Vegas Grand Prix 2026 (your clock, lights out 9:02 PM)" */
export function storyLine(session) {
  const ev = session.event;
  const year = new Date(session.startTs).getFullYear();
  if (ev && ev.source === 'openf1') {
    const me = session.feed && session.feed.myDriver;
    const lo = (session.tags || []).find((g) => g.auto && /^Lights out/.test(g.label));
    const who = me ? `${me.full}'s race, ` : '';
    return `${who}${displayTitle(session)} ${year} (your clock${lo ? `, lights out ${clockTime(lo.t)}` : ''})`;
  }
  if (session.teams) {
    const ko = session.phases && session.phases.kickoff;
    const comp = ev && ev.competition ? `, ${ev.competition}` : '';
    return `${displayTitle(session)}${comp} (your clock${ko ? `, kick-off ${clockTime(ko)}` : ''})`;
  }
  return `${session.title} · ${SESSION_TYPES[session.type].label} (your clock)`;
}

function wrap(ctx, text, maxW, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= maxW || !cur) cur = test;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines);
    let last = keep[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    keep[maxLines - 1] = last + '…';
    return keep;
  }
  return lines;
}

function isLight(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return true;
  return 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) > 150;
}

export async function renderSessionPng(session, restingHr, scale = 2) {
  await ensureFonts();
  const moments = numberedMoments(session);
  const cats = legendCategories(session);

  // --- measure legend ---
  const measure = document.createElement('canvas').getContext('2d');
  const colW = (W - PAD * 2 - 20 - 24) / 2;
  measure.font = `600 11.5px ${FONT_TEXT}`;
  const timeW = Math.max(36, ...moments.map((m) => measure.measureText(m.timeLabel).width));
  const textW = colW - 22 - timeW - 8;
  measure.font = `400 11.5px ${FONT_TEXT}`;
  const items = moments.map((m) => ({ ...m, lines: wrap(measure, m.label, textW, 3) }));
  const half = Math.ceil(items.length / 2);
  const left = items.slice(0, half);
  const right = items.slice(half);
  const rowHeights = [];
  for (let i = 0; i < half; i++) {
    const n = Math.max(left[i] ? left[i].lines.length : 1, right[i] ? right[i].lines.length : 1);
    rowHeights.push(10 + n * 15);
  }
  measure.font = `400 10.5px ${FONT_TEXT}`;
  let keyRows = 1;
  {
    let x = 0;
    for (const c of cats) {
      const w = 14 + measure.measureText(c.label).width + 14;
      if (x + w > W - PAD * 2 - 20 && x > 0) (keyRows += 1), (x = 0);
      x += w;
    }
  }

  const cardY = PAD;
  const chartTop = cardY + 64;
  const chartH = 420;
  const cardH = chartTop - cardY + chartH + 16;
  const storyY = cardY + cardH + 30;
  const keyY = storyY + 22;
  const listY = keyY + keyRows * 18 + 14;
  const listH = rowHeights.reduce((a, b) => a + b, 0);
  const footY = listY + listH + 18;
  const H = footY + 40;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Page
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, W, H);

  // Chart card
  const g = ctx.createLinearGradient(PAD, cardY, W - PAD, cardY + cardH);
  g.addColorStop(0, '#262b36');
  g.addColorStop(1, '#14171e');
  ctx.fillStyle = g;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(PAD, cardY, W - PAD * 2, cardH, 14);
  else ctx.rect(PAD, cardY, W - PAD * 2, cardH);
  ctx.fill();

  ctx.fillStyle = COLORS.text;
  ctx.font = `600 11.5px ${FONT_TEXT}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
  ctx.fillText(chartHeading(session), PAD + 20, cardY + 30);
  // HR / stress key (top right)
  ctx.font = `600 9.5px ${FONT_TEXT}`;
  ctx.textAlign = 'right';
  const kx = W - PAD - 20;
  const ky = cardY + 54;
  const sW = ctx.measureText('STRESS').width;
  ctx.fillStyle = COLORS.text;
  ctx.fillText('STRESS', kx, ky);
  ctx.fillStyle = COLORS.stressLow;
  dot(ctx, kx - sW - 10, ky - 3.5, 4);
  ctx.fillStyle = COLORS.text;
  const hx = kx - sW - 26;
  ctx.fillText('HEART RATE', hx, ky);
  ctx.fillStyle = COLORS.hr;
  dot(ctx, hx - ctx.measureText('HEART RATE').width - 10, ky - 3.5, 4);
  ctx.textAlign = 'left';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  drawChart(new CanvasPainter(ctx), session, PAD + 6, chartTop, W - PAD * 2 - 12, chartH, { restingHr });

  // Story line
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 13.5px ${FONT_TEXT}`;
  ctx.fillText(fitText(ctx, storyLine(session), W - PAD * 2 - 20), PAD + 10, storyY);

  // Category key
  ctx.font = `400 10.5px ${FONT_TEXT}`;
  let x = PAD + 10;
  let y = keyY;
  for (const c of cats) {
    const w = 14 + ctx.measureText(c.label).width + 14;
    if (x + w > W - PAD && x > PAD + 10) (x = PAD + 10), (y += 18);
    ctx.fillStyle = c.color;
    dot(ctx, x + 4, y - 3.5, 4);
    ctx.fillStyle = '#c4cad6';
    ctx.fillText(c.label, x + 13, y);
    x += w;
  }

  // Numbered list, two columns (column-major)
  const drawItem = (m, x0, y0) => {
    ctx.fillStyle = m.color;
    dot(ctx, x0 + 8, y0 + 5, 7.5);
    ctx.fillStyle = isLight(m.color) ? '#111418' : '#ffffff';
    ctx.font = `700 9.5px ${FONT_TEXT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.n), x0 + 8, y0 + 5.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 11.5px ${FONT_TEXT}`;
    ctx.fillStyle = isLight(m.color) ? COLORS.text : m.color;
    ctx.fillText(m.timeLabel, x0 + 22, y0 + 9.5);
    ctx.font = `400 11.5px ${FONT_TEXT}`;
    ctx.fillStyle = '#c9ced8';
    m.lines.forEach((ln, j) => ctx.fillText(ln, x0 + 22 + timeW + 8, y0 + 9.5 + j * 15));
  };
  let ry = listY;
  for (let i = 0; i < half; i++) {
    if (left[i]) drawItem(left[i], PAD + 10, ry);
    if (right[i]) drawItem(right[i], PAD + 10 + colW + 24, ry);
    ry += rowHeights[i];
  }

  // Footer
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 10.5px ${FONT_TEXT}`;
  ctx.fillText("Stress is Pulse's estimate from heart rate and HRV, not WHOOP's Stress Monitor.", PAD + 10, footY + 10);
  drawMark(ctx, W - PAD - 10, footY + 6);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawMark(ctx, right, y) {
  ctx.save();
  ctx.font = `700 16px ${FONT_NUM}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText('PULSE', right, y + 5);
  const w = ctx.measureText('PULSE').width;
  const x = right - w - 26;
  ctx.strokeStyle = COLORS.hr;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x + 8, y - 6);
  ctx.lineTo(x + 12, y + 7);
  ctx.lineTo(x + 15, y - 2);
  ctx.lineTo(x + 20, y);
  ctx.stroke();
  ctx.restore();
}

export function exportFileName(session) {
  const d = new Date(session.startTs);
  const slug = displayTitle(session)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `pulse-${slug || 'session'}-${d.toISOString().slice(0, 10)}.png`;
}

/** Web Share API with files; falls back to download. Returns 'shared' | 'downloaded' | 'cancelled'. */
export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: title });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
