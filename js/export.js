// Shareable PNG (2x): title, date/time range, chart, numbered legend, Pulse mark.
import { COLORS, SESSION_TYPES } from './config.js';
import { CanvasPainter, drawChart, FONT_NUM, FONT_TEXT } from './chart.js';
import { numberedMoments, displayTitle, clockTime, sessionEnd, legendCategories, sessionStats } from './analysis.js';


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

/* ---------------- Social formats ---------------- */

// Logical sizes; rendered at 2x → Classic 1520 px wide, Post 1080×1350 (4:5), Story 1080×1920 (9:16).
export const SHARE_FORMATS = {
  classic: { label: 'Classic', hint: 'X · WhatsApp · LinkedIn', W: 760, H: null },
  post: { label: 'Post 4:5', hint: 'Instagram · LinkedIn feed', W: 540, H: 675 },
  story: { label: 'Story 9:16', hint: 'Instagram · WhatsApp status', W: 540, H: 960 },
};

function glowBackground(ctx, W, H) {
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.05, 0, 10, W * 0.05, 0, Math.max(W, H) * 0.9);
  g.addColorStop(0, 'rgba(98, 112, 190, 0.22)');
  g.addColorStop(0.55, 'rgba(98, 112, 190, 0.05)');
  g.addColorStop(1, 'rgba(98, 112, 190, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function chartCard(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#272c38');
  g.addColorStop(0.6, '#191c24');
  g.addColorStop(1, '#14171d');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 14);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  const glow = ctx.createRadialGradient(x, y, 5, x, y, w * 0.8);
  glow.addColorStop(0, 'rgba(120, 135, 210, 0.16)');
  glow.addColorStop(1, 'rgba(120, 135, 210, 0)');
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function letter(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/** Lay out the numbered legend at a given font size. */
function layoutLegend(measure, moments, colW, cols, f, maxLines) {
  measure.font = `600 ${f}px ${FONT_TEXT}`;
  const timeW = Math.max(f * 3, ...moments.map((m) => measure.measureText(m.timeLabel).width));
  const dotR = f * 0.66;
  const textX = dotR * 2 + 6 + timeW + 7;
  measure.font = `400 ${f}px ${FONT_TEXT}`;
  const items = moments.map((m) => ({ ...m, lines: wrap(measure, m.label, colW - textX, maxLines) }));
  const perCol = Math.ceil(items.length / cols);
  const colsArr = Array.from({ length: cols }, (_, c) => items.slice(c * perCol, (c + 1) * perCol));
  const lineH = f * 1.32;
  const gap = f * 0.8;
  const rowHeights = [];
  for (let i = 0; i < perCol; i++) {
    const n = Math.max(...colsArr.map((col) => (col[i] ? col[i].lines.length : 0)), 1);
    rowHeights.push(n * lineH + gap);
  }
  return { f, timeW, dotR, textX, colsArr, rowHeights, lineH, height: rowHeights.reduce((a, b) => a + b, 0) };
}

function drawLegend(ctx, L, x0, y0, colW, colGap) {
  const { f, dotR, timeW, textX, colsArr, rowHeights, lineH } = L;
  colsArr.forEach((col, c) => {
    let y = y0;
    col.forEach((m, i) => {
      const x = x0 + c * (colW + colGap);
      ctx.fillStyle = m.color;
      dot(ctx, x + dotR, y + f * 0.45, dotR);
      ctx.fillStyle = isLight(m.color) ? '#111418' : '#ffffff';
      ctx.font = `700 ${f * 0.78}px ${FONT_TEXT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.n), x + dotR, y + f * 0.48);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${f}px ${FONT_TEXT}`;
      ctx.fillStyle = isLight(m.color) ? COLORS.text : m.color;
      ctx.fillText(m.timeLabel, x + dotR * 2 + 6, y + f * 0.85);
      ctx.font = `400 ${f}px ${FONT_TEXT}`;
      ctx.fillStyle = '#c9ced8';
      m.lines.forEach((ln, j) => ctx.fillText(ln, x + textX, y + f * 0.85 + j * lineH));
      y += rowHeights[i];
    });
  });
  return timeW;
}

function keyRowsHeight(measure, cats, maxW, f) {
  measure.font = `400 ${f}px ${FONT_TEXT}`;
  let rows = cats.length ? 1 : 0;
  let x = 0;
  for (const c of cats) {
    const w = f + measure.measureText(c.label).width + f * 1.3;
    if (x + w > maxW && x > 0) (rows += 1), (x = 0);
    x += w;
  }
  return rows * (f * 1.7);
}

function drawKey(ctx, cats, x0, y0, maxW, f) {
  ctx.font = `400 ${f}px ${FONT_TEXT}`;
  let x = x0;
  let y = y0;
  for (const c of cats) {
    const w = f + ctx.measureText(c.label).width + f * 1.3;
    if (x + w > x0 + maxW && x > x0) (x = x0), (y += f * 1.7);
    ctx.fillStyle = c.color;
    dot(ctx, x + f * 0.38, y - f * 0.33, f * 0.38);
    ctx.fillStyle = '#c4cad6';
    ctx.fillText(c.label, x + f * 1.15, y);
    x += w;
  }
}

/**
 * Render a shareable image.
 * format: 'classic' (reference layout, height grows with the legend) | 'post' (4:5) | 'story' (9:16)
 */
export async function renderShareImage(session, restingHr, format = 'classic', scale = 2) {
  await ensureFonts();
  const F = SHARE_FORMATS[format] || SHARE_FORMATS.classic;
  const W = F.W;
  const narrow = W < 600;
  const pad = narrow ? 16 : 20;
  const moments = numberedMoments(session);
  const cats = legendCategories(session);
  const measure = document.createElement('canvas').getContext('2d');
  const innerW = W - pad * 2;

  // ----- vertical plan -----
  const hasTitle = format !== 'classic';
  const titleH = !hasTitle ? 0 : format === 'story' ? 150 : 70;
  const cardY = pad + titleH;
  const cardHeadH = narrow ? 52 : 64;
  let chartH = format === 'story' ? 380 : format === 'post' ? 268 : 420;
  const storyF = narrow ? 11.5 : 13.5;
  const keyF = narrow ? 9.5 : 10.5;
  const footH = narrow ? 30 : 40;
  const cols = format === 'story' ? 1 : 2;
  const colGap = narrow ? 16 : 24;
  const colW = (innerW - 20 - colGap * (cols - 1)) / cols;

  let L;
  let keyH = keyRowsHeight(measure, cats, innerW - 20, keyF);
  const above = () => cardY + cardHeadH + chartH + 16 + 22 + storyF * 1.4 + 8 + keyH + 10;
  if (F.H) {
    const fit = () => {
      for (const maxLines of [3, 2, 1]) {
        for (let f = narrow ? 11 : 11.5; f >= 7.5; f -= 0.5) {
          const l = layoutLegend(measure, moments, colW, cols, f, maxLines);
          if (above() + l.height + footH <= F.H) return l;
        }
      }
      return null;
    };
    L = fit();
    while (!L && chartH > 200) {
      chartH -= 20;
      L = fit();
    }
    if (!L) L = layoutLegend(measure, moments, colW, cols, 7.5, 1);
    // Give spare height to the chart (Story has room to breathe).
    const spare = F.H - (above() + L.height + footH);
    if (spare > 20) chartH += Math.min(spare - 10, 160);
  } else {
    L = layoutLegend(measure, moments, colW, cols, 11.5, 3);
  }
  const H = F.H || Math.ceil(above() + L.height + footH + 8);

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  glowBackground(ctx, W, H);

  // ----- title block (post / story) -----
  if (hasTitle) {
    drawMark(ctx, W - pad, pad + 14, 14);
    const typeLabel = SESSION_TYPES[session.type].label.toUpperCase();
    const comp = session.event && session.event.competition ? session.event.competition.toUpperCase() : typeLabel;
    ctx.fillStyle = COLORS.muted;
    ctx.font = `600 10px ${FONT_TEXT}`;
    letter(ctx, 1.4);
    ctx.fillText(fitText(ctx, comp, W - pad * 2 - 90), pad + 2, pad + 18);
    letter(ctx, 0);
    ctx.fillStyle = COLORS.text;
    const tSize = format === 'story' ? 40 : 30;
    ctx.font = `700 ${tSize}px ${FONT_NUM}`;
    ctx.fillText(fitText(ctx, displayTitle(session), innerW), pad, pad + 18 + tSize + 4);
    if (format === 'story') {
      const st = sessionStats(session, restingHr);
      const chips = [
        st.peakHr ? ['PEAK', `${st.peakHr} bpm`] : null,
        st.avgHr ? ['AVERAGE', `${st.avgHr} bpm`] : null,
        st.peakTension != null ? ['STRESS PEAK', st.peakTension.toFixed(1)] : null,
      ].filter(Boolean);
      let cx = pad;
      const cy = pad + 18 + tSize + 20;
      for (const [k, v] of chips) {
        ctx.font = `600 8.5px ${FONT_TEXT}`;
        letter(ctx, 1);
        const kw = ctx.measureText(k).width;
        letter(ctx, 0);
        ctx.font = `700 17px ${FONT_NUM}`;
        const vw = ctx.measureText(v).width;
        const w = Math.max(kw, vw) + 22;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx, cy, w, 40, 9);
        else ctx.rect(cx, cy, w, 40);
        ctx.fill();
        ctx.fillStyle = COLORS.muted;
        ctx.font = `600 8.5px ${FONT_TEXT}`;
        letter(ctx, 1);
        ctx.fillText(k, cx + 11, cy + 14);
        letter(ctx, 0);
        ctx.fillStyle = k === 'STRESS PEAK' ? COLORS.stressHigh : COLORS.text;
        ctx.font = `700 17px ${FONT_NUM}`;
        ctx.fillText(v, cx + 11, cy + 33);
        cx += w + 8;
      }
    }
  }

  // ----- chart card -----
  const cardH = cardHeadH + chartH + 16;
  chartCard(ctx, pad, cardY, innerW, cardH);
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 ${narrow ? 9.5 : 11.5}px ${FONT_TEXT}`;
  letter(ctx, narrow ? 1.1 : 1.6);
  ctx.fillText(fitText(ctx, chartHeading(session), innerW - 32), pad + 16, cardY + (narrow ? 22 : 30));
  ctx.font = `600 ${narrow ? 8.5 : 9.5}px ${FONT_TEXT}`;
  ctx.textAlign = 'right';
  const kx = pad + innerW - 16;
  const ky = cardY + (narrow ? 40 : 54);
  const sW = ctx.measureText('STRESS').width;
  ctx.fillText('STRESS', kx, ky);
  ctx.fillStyle = COLORS.stressLow;
  dot(ctx, kx - sW - 9, ky - 3.2, 3.6);
  ctx.fillStyle = COLORS.text;
  const hx = kx - sW - 24;
  ctx.fillText('HEART RATE', hx, ky);
  ctx.fillStyle = COLORS.hr;
  dot(ctx, hx - ctx.measureText('HEART RATE').width - 9, ky - 3.2, 3.6);
  ctx.textAlign = 'left';
  letter(ctx, 0);
  drawChart(new CanvasPainter(ctx), session, pad + 4, cardY + cardHeadH, innerW - 8, chartH, { restingHr, scale: narrow ? 0.92 : 1 });

  // ----- story line, key, legend -----
  let y = cardY + cardH + 22 + storyF;
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 ${storyF}px ${FONT_TEXT}`;
  ctx.fillText(fitText(ctx, storyLine(session), innerW - 16), pad + 8, y);
  y += 8 + keyF * 1.3;
  drawKey(ctx, cats, pad + 8, y, innerW - 20, keyF);
  y += keyH + 2;
  drawLegend(ctx, L, pad + 8, y, colW, colGap);

  // ----- footer -----
  const fy = H - (narrow ? 14 : 18);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 ${narrow ? 8.5 : 10.5}px ${FONT_TEXT}`;
  ctx.fillText(fitText(ctx, "Stress is Pulse's estimate from heart rate and HRV, not WHOOP's Stress Monitor.", innerW - 90), pad + 8, fy);
  if (!hasTitle) drawMark(ctx, W - pad - 8, fy - 5, 16);
  else {
    ctx.textAlign = 'right';
    ctx.font = `600 ${narrow ? 8.5 : 10.5}px ${FONT_TEXT}`;
    ctx.fillText('Made with Pulse', W - pad - 8, fy);
    ctx.textAlign = 'left';
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Back-compat: the classic layout. */
export function renderSessionPng(session, restingHr, scale = 2) {
  return renderShareImage(session, restingHr, 'classic', scale);
}

/* ---------------- Post caption ---------------- */

const hashtag = (s) =>
  '#' +
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toUpperCase());

/** Ready-to-post caption, in the spirit of "I tracked my heart rate and stress during the F1 GP in Vegas…". */
export function buildCaption(session, restingHr) {
  const st = sessionStats(session, restingHr);
  const title = displayTitle(session);
  const ev = session.event;
  const lines = [];
  let opener;
  if (session.type === 'f1') opener = `I tracked my heart rate and stress during the ${title} 🏎️`;
  else if (session.type === 'sport') opener = `I tracked my heart rate and stress during ${title}${ev && ev.competition ? ` (${ev.competition})` : ''} ⚽`;
  else if (session.type === 'workout') opener = `My heart rate and stress during ${session.title} 💪`;
  else opener = `My heart rate and stress during ${session.title}`;
  lines.push(opener);
  const facts = [];
  if (st.peakHr) {
    let when = '';
    const ctxt = (st.peakContext || '').replace(/\s\([^()]*\)$/, '').trim();
    if (ctxt) {
      const lap = ctxt.match(/^Laps? (\d+)/);
      if (session.type === 'f1') when = lap ? ` on lap ${lap[1]}` : ` at ${ctxt.split(':')[0].toLowerCase()}`;
      else if (session.type === 'sport') when = ` at ${ctxt.split(':')[0]}`;
      else when = ` during “${ctxt}”`;
    }
    facts.push(`Peak ${st.peakHr} bpm${when}`);
  }
  if (st.avgHr) facts.push(`average ${st.avgHr} bpm`);
  if (st.aboveCalmMs > 60000) facts.push(`${Math.round(st.aboveCalmMs / 60000)} min above my calm zone`);
  if (facts.length) lines.push(facts.join(', ') + '.');
  if (session.writeup && session.writeup.text) {
    const head = session.writeup.text.split(/\n/)[0].trim();
    if (head && head.length < 120) lines.push(`“${head}”`);
  }
  const tags = ['#WHOOP', '#Pulse'];
  if (session.type === 'f1') {
    tags.push('#F1');
    if (ev && ev.meetingName) tags.push(hashtag(ev.meetingName.replace(/Grand Prix/i, 'GP')));
    const me = session.feed && session.feed.myDriver;
    if (me && me.full) tags.push(hashtag(me.full.split(' ').slice(-1)[0]));
  } else if (session.type === 'sport' && session.teams) {
    tags.push(hashtag(session.teams.home), hashtag(session.teams.away));
    if (ev && ev.competition) tags.push(hashtag(ev.competition));
  }
  lines.push('', [...new Set(tags)].join(' '));
  return lines.join('\n');
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

function drawMark(ctx, right, y, size = 16) {
  ctx.save();
  ctx.font = `700 ${size}px ${FONT_NUM}`;
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
/** Web Share API with files (+ caption text); falls back to download. Returns 'shared' | 'downloaded' | 'cancelled'. */
export async function shareOrDownload(blob, filename, title, text = '') {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      const data = { files: [file], title };
      if (text) data.text = text;
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
