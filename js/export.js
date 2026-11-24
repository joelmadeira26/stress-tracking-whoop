// Shareable PNG (2x): title, date/time range, chart, numbered legend, Pulse mark.
import { COLORS, SESSION_TYPES } from './config.js';
import { CanvasPainter, drawChart, FONT_NUM, FONT_TEXT } from './chart.js';
import { numberedMoments, displayTitle, clockTime, sessionEnd } from './analysis.js';

const W = 720; // logical px; exported at 2x = 1440 px wide
const PAD = 28;

async function ensureFonts() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`700 34px ${FONT_NUM}`),
      document.fonts.load(`600 12px ${FONT_NUM}`),
      document.fonts.load(`400 13px ${FONT_TEXT}`),
      document.fonts.load(`600 13px ${FONT_TEXT}`),
    ]);
  } catch {
    /* fall back to system fonts */
  }
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

export async function renderSessionPng(session, restingHr, scale = 2) {
  await ensureFonts();
  const moments = numberedMoments(session);
  const cols = 2;
  const colW = (W - PAD * 2) / cols;
  const rowH = 26;
  const legendRows = Math.ceil(moments.length / cols);
  const headerH = 104;
  const chartH = 400;
  const legendH = moments.length ? 34 + legendRows * rowH : 0;
  const footerH = 74;
  const H = headerH + chartH + legendH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Background with a subtle glow
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.15, 0, 10, W * 0.15, 0, W * 0.9);
  g.addColorStop(0, 'rgba(61,165,255,0.16)');
  g.addColorStop(1, 'rgba(61,165,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const type = SESSION_TYPES[session.type];
  const end = sessionEnd(session);
  const date = new Date(session.startTs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // Header
  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 12px ${FONT_TEXT}`;
  ctx.fillText(`${type.label.toUpperCase()} · ${session.mode === 'doing' ? 'DOING' : 'WATCHING'}`, PAD, 34);
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 36px ${FONT_NUM}`;
  ctx.fillText(fit(ctx, displayTitle(session), W - PAD * 2 - 90), PAD, 70);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 13px ${FONT_TEXT}`;
  ctx.fillText(`${date} · ${clockTime(session.startTs)}–${clockTime(end)}`, PAD, 92);

  // Pulse mark (top right)
  drawMark(ctx, W - PAD, 38);

  // Chart
  const painter = new CanvasPainter(ctx);
  drawChart(painter, session, PAD - 6, headerH, W - PAD * 2 + 12, chartH, { restingHr });

  // Legend
  let y = headerH + chartH + 22;
  if (moments.length) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(PAD, y - 10);
    ctx.lineTo(W - PAD, y - 10);
    ctx.stroke();
    moments.forEach((m, i) => {
      const col = Math.floor(i / legendRows);
      const row = i % legendRows;
      const x = PAD + col * colW;
      const cy = y + 10 + row * rowH;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x + 9, cy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#07101f';
      ctx.font = `700 ${m.n > 9 ? 10.5 : 12}px ${FONT_NUM}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.n), x + 9, cy + 0.5);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text;
      ctx.font = `600 15px ${FONT_NUM}`;
      ctx.fillText(m.timeLabel, x + 24, cy + 1);
      const tw = ctx.measureText(m.timeLabel).width;
      ctx.font = `400 12.5px ${FONT_TEXT}`;
      ctx.fillStyle = '#cdd6e6';
      ctx.fillText(fit(ctx, m.label, colW - tw - 40), x + 30 + tw, cy + 1);
      ctx.textBaseline = 'alphabetic';
    });
    y += legendH;
  }

  // Footer key
  const fy = H - footerH + 24;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.hr;
  ctx.fillRect(PAD, fy - 1.5, 18, 3);
  ctx.font = `500 12px ${FONT_TEXT}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Heart rate (bpm, 10 s avg)', PAD + 24, fy);
  const x2 = PAD + 24 + ctx.measureText('Heart rate (bpm, 10 s avg)').width + 22;
  ctx.fillStyle = COLORS.tension;
  ctx.fillRect(x2, fy - 1.5, 18, 3);
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Tension (0–3)', x2 + 24, fy);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 11px ${FONT_TEXT}`;
  ctx.fillText("Tension is Pulse's estimate from heart rate and HRV, not WHOOP's Stress Monitor.", PAD, fy + 24);
  ctx.textBaseline = 'alphabetic';

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

function drawMark(ctx, right, y) {
  ctx.save();
  ctx.font = `700 20px ${FONT_NUM}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('PULSE', right, y + 7);
  const w = ctx.measureText('PULSE').width;
  // little heartbeat glyph
  const x = right - w - 30;
  ctx.strokeStyle = COLORS.hr;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 6, y);
  ctx.lineTo(x + 9, y - 7);
  ctx.lineTo(x + 14, y + 8);
  ctx.lineTo(x + 18, y - 2);
  ctx.lineTo(x + 24, y);
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
