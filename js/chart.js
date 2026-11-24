// Session chart. Drawn through a tiny "painter" interface so the same code
// renders live SVG on screen and the 2x PNG export on a canvas.
import { COLORS } from './config.js';
import {
  bucketHr,
  tensionSeries,
  findGaps,
  allBands,
  phaseLines,
  numberedMoments,
  sessionEnd,
  clockTime,
} from './analysis.js';

export const FONT_NUM = "'Barlow Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif";
export const FONT_TEXT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/* ---------------- Painters ---------------- */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r2 = (n) => Math.round(n * 100) / 100;

export class SvgPainter {
  constructor() {
    this.parts = [];
    this.defs = [];
    this.gid = 0;
  }
  /** Vertical gradient for strokes: stops = [[offset, colour], ...] from y1 to y2 (user space). */
  gradient(y1, y2, stops) {
    const id = `g${++this.gid}${Math.random().toString(36).slice(2, 6)}`;
    this.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${r2(y1)}" x2="0" y2="${r2(y2)}">${stops
        .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
        .join('')}</linearGradient>`,
    );
    return `url(#${id})`;
  }
  rect(x, y, w, h, st = {}) {
    this.parts.push(
      `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(0, w))}" height="${r2(Math.max(0, h))}"${st.rx ? ` rx="${st.rx}"` : ''} fill="${st.fill || 'none'}"${st.opacity != null ? ` fill-opacity="${st.opacity}"` : ''}${st.stroke ? ` stroke="${st.stroke}" stroke-width="${st.width || 1}"` : ''}/>`,
    );
  }
  line(x1, y1, x2, y2, st = {}) {
    this.parts.push(
      `<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${st.stroke}" stroke-width="${st.width || 1}"${st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''}${st.opacity != null ? ` stroke-opacity="${st.opacity}"` : ''}/>`,
    );
  }
  path(cmds, st = {}) {
    if (!cmds.length) return;
    const d = cmds.map((c) => c[0] + c.slice(1).map(r2).join(' ')).join('');
    this.parts.push(
      `<path d="${d}" fill="${st.fill || 'none'}"${st.fillOpacity != null ? ` fill-opacity="${st.fillOpacity}"` : ''}${st.stroke ? ` stroke="${st.stroke}" stroke-width="${st.width || 1}" stroke-linejoin="round" stroke-linecap="round"` : ''}/>`,
    );
  }
  circle(cx, cy, r, st = {}) {
    this.parts.push(
      `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r}" fill="${st.fill || 'none'}"${st.stroke ? ` stroke="${st.stroke}" stroke-width="${st.width || 1}"` : ''}/>`,
    );
  }
  text(x, y, str, st = {}) {
    const anchor = st.anchor || 'start';
    const fam = st.font === 'num' ? FONT_NUM : FONT_TEXT;
    this.parts.push(
      `<text x="${r2(x)}" y="${r2(y)}" fill="${st.fill || COLORS.text}" font-family="${esc(fam)}" font-size="${st.size || 11}" font-weight="${st.weight || 400}" text-anchor="${anchor}"${st.spacing ? ` letter-spacing="${st.spacing}"` : ''} dominant-baseline="${st.baseline === 'middle' ? 'central' : 'alphabetic'}"${st.opacity != null ? ` fill-opacity="${st.opacity}"` : ''}>${esc(str)}</text>`,
    );
  }
  toString(w, h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Heart rate and stress chart">${
      this.defs.length ? `<defs>${this.defs.join('')}</defs>` : ''
    }${this.parts.join('')}</svg>`;
  }
}

export class CanvasPainter {
  constructor(ctx) {
    this.ctx = ctx;
  }
  gradient(y1, y2, stops) {
    const g = this.ctx.createLinearGradient(0, y1, 0, y2);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  }
  rect(x, y, w, h, st = {}) {
    const c = this.ctx;
    c.save();
    c.beginPath();
    if (st.rx && c.roundRect) c.roundRect(x, y, Math.max(0, w), Math.max(0, h), st.rx);
    else c.rect(x, y, Math.max(0, w), Math.max(0, h));
    if (st.fill && st.fill !== 'none') {
      c.globalAlpha = st.opacity != null ? st.opacity : 1;
      c.fillStyle = st.fill;
      c.fill();
    }
    if (st.stroke) {
      c.globalAlpha = 1;
      c.strokeStyle = st.stroke;
      c.lineWidth = st.width || 1;
      c.stroke();
    }
    c.restore();
  }
  line(x1, y1, x2, y2, st = {}) {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.strokeStyle = st.stroke;
    c.lineWidth = st.width || 1;
    c.globalAlpha = st.opacity != null ? st.opacity : 1;
    if (st.dash) c.setLineDash(st.dash);
    c.stroke();
    c.restore();
  }
  path(cmds, st = {}) {
    if (!cmds.length) return;
    const c = this.ctx;
    c.save();
    c.beginPath();
    for (const k of cmds) {
      if (k[0] === 'M') c.moveTo(k[1], k[2]);
      else if (k[0] === 'L') c.lineTo(k[1], k[2]);
      else if (k[0] === 'C') c.bezierCurveTo(k[1], k[2], k[3], k[4], k[5], k[6]);
      else if (k[0] === 'Z') c.closePath();
    }
    if (st.fill && st.fill !== 'none') {
      c.globalAlpha = st.fillOpacity != null ? st.fillOpacity : 1;
      c.fillStyle = st.fill;
      c.fill();
    }
    if (st.stroke) {
      c.globalAlpha = 1;
      c.strokeStyle = st.stroke;
      c.lineWidth = st.width || 1;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.stroke();
    }
    c.restore();
  }
  circle(cx, cy, r, st = {}) {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    if (st.fill) {
      c.fillStyle = st.fill;
      c.fill();
    }
    if (st.stroke) {
      c.strokeStyle = st.stroke;
      c.lineWidth = st.width || 1;
      c.stroke();
    }
    c.restore();
  }
  text(x, y, str, st = {}) {
    const c = this.ctx;
    c.save();
    c.font = `${st.weight || 400} ${st.size || 11}px ${st.font === 'num' ? FONT_NUM : FONT_TEXT}`;
    c.fillStyle = st.fill || COLORS.text;
    c.globalAlpha = st.opacity != null ? st.opacity : 1;
    c.textAlign = st.anchor === 'middle' ? 'center' : st.anchor === 'end' ? 'right' : 'left';
    c.textBaseline = st.baseline === 'middle' ? 'middle' : 'alphabetic';
    if (st.spacing && 'letterSpacing' in c) c.letterSpacing = `${st.spacing}px`;
    c.fillText(str, x, y);
    c.restore();
  }
}

/* ---------------- Geometry helpers ---------------- */

/** Monotone cubic (Fritsch–Carlson) path through points — smooth, never overshoots 0–3. */
export function monotonePath(pts) {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [['M', pts[0][0], pts[0][1]]];
  if (n === 2) return [['M', pts[0][0], pts[0][1]], ['L', pts[1][0], pts[1][1]]];
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  t.push(m[n - 2]);
  const cmds = [['M', pts[0][0], pts[0][1]]];
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    cmds.push(['C', pts[i][0] + h, pts[i][1] + t[i] * h, pts[i + 1][0] - h, pts[i + 1][1] - t[i + 1] * h, pts[i + 1][0], pts[i + 1][1]]);
  }
  return cmds;
}

/** Split a series with nulls into contiguous runs of [x,y]. */
function runs(series, xf, yf, key) {
  const out = [];
  let cur = [];
  for (const p of series) {
    if (p[key] == null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([xf(p.t), yf(p[key])]);
  }
  if (cur.length) out.push(cur);
  return out;
}

function niceStep(rangeMin, targetPx, pxPerMin) {
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120];
  for (const s of steps) if (s * pxPerMin >= targetPx) return s;
  return 240;
}

/** Assign each marker to the lowest of `maxRows` rows where it doesn't overlap. */
export function staggerMarkers(xs, radius, maxRows = 3) {
  const lastX = new Array(maxRows).fill(-Infinity);
  const gap = radius * 2 + 2;
  return xs.map((x) => {
    for (let r = 0; r < maxRows; r++) {
      if (x - lastX[r] >= gap) {
        lastX[r] = x;
        return r;
      }
    }
    let best = 0;
    for (let r = 1; r < maxRows; r++) if (lastX[r] < lastX[best]) best = r;
    lastX[best] = x;
    return best;
  });
}

/* ---------------- Chart ---------------- */

function isLight(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return true;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/** Centered moving average over ±w points (skips nulls). */
function smooth(series, w = 2) {
  return series.map((p, i) => {
    if (p.value == null) return p;
    let s = 0;
    let n = 0;
    for (let j = i - w; j <= i + w; j++) if (series[j] && series[j].value != null) (s += series[j].value), n++;
    return { ...p, value: s / n };
  });
}

export function timeTick(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Draws the chart into `painter` inside box (x0, y0, W, H).
 * opts: { restingHr, now (live end time), scale }
 */
export function drawChart(painter, session, x0, y0, W, H, opts = {}) {
  const rest = opts.restingHr ?? 60;
  const k = opts.scale || 1;
  const compact = W < 520;
  const start = session.startTs;
  let end = opts.now || sessionEnd(session);
  if (opts.now) end = Math.max(end, start + 5 * 60 * 1000);
  const span = end - start;

  const moments = numberedMoments(session);
  const radius = (compact ? 6.5 : 7.5) * k;
  const rowH = radius * 2 + 4 * k;

  const xLeftPad = (compact ? 30 : 44) * k;
  const xRightPad = (compact ? 20 : 34) * k;
  const plotX = x0 + xLeftPad;
  const plotW = W - xLeftPad - xRightPad;

  const xf = (t) => plotX + ((t - start) / span) * plotW;
  const mxs = moments.map((g) => xf(g.t));
  const rows = staggerMarkers(mxs, radius, 3);
  const nRows = moments.length ? Math.max(...rows) + 1 : 0;

  const topPad = 8 * k + nRows * rowH + (nRows ? 8 * k : 6 * k);
  const bottomPad = 24 * k;
  const plotY = y0 + topPad;
  const plotH = H - topPad - bottomPad;

  // Data
  const hr10 = bucketHr(session.samples, start, end, 10 * 1000);
  // Stress: smoothed over ~4 min and drawn every 2 min (like the reference: calm, readable swings).
  const tenRaw = smooth(tensionSeries(session, rest).series.filter((p) => p.t <= end + 1), 4);
  const ten = tenRaw.filter((p, i) => i % 4 === 0 || i === tenRaw.length - 1 || p.value == null || (tenRaw[i + 1] && tenRaw[i + 1].value == null) || (tenRaw[i - 1] && tenRaw[i - 1].value == null));
  const vals = hr10.filter((b) => b.avg != null).map((b) => b.avg);
  let lo = vals.length ? Math.min(...vals) : rest;
  let hi = vals.length ? Math.max(...vals) : rest + 40;
  const step = hi - lo > 60 ? 20 : 10;
  lo = Math.floor((Math.min(lo, rest + 5) - 4) / step) * step;
  hi = Math.ceil((hi + 4) / step) * step;
  if (hi - lo < 3 * step) hi = lo + 3 * step;
  const yHr = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
  const yTen = (v) => plotY + plotH - (v / 3) * plotH;

  // Plot area
  painter.rect(plotX, plotY, plotW, plotH, { fill: '#ffffff', opacity: 0.025, stroke: 'rgba(255,255,255,0.07)', width: 1 });

  // Bands
  for (const b of allBands(session, opts.now)) {
    const bx = Math.max(plotX, xf(b.start));
    const bw = Math.min(plotX + plotW, xf(b.end)) - bx;
    if (bw <= 0) continue;
    const ht = b.key === 'halftime';
    const sc = b.key === 'sc';
    painter.rect(bx, plotY, bw, plotH, { fill: ht ? '#ffffff' : b.color || '#ffffff', opacity: sc ? 0.22 : ht ? 0.06 : 0.12 });
    const lbl = String(b.label || '').toUpperCase();
    if (sc || ht) {
      if (bw > 18 * k) painter.text(bx + bw / 2, plotY + plotH - 8 * k, lbl, { size: 8.5 * k, weight: 600, anchor: 'middle', fill: sc ? '#e3b341' : COLORS.muted, spacing: 0.6 * k });
    } else if (bw > 34 * k) {
      painter.text(bx + 4 * k, plotY + 11 * k, lbl, { size: 8 * k, weight: 600, fill: b.color || COLORS.text, opacity: 0.9, spacing: 0.5 * k });
    }
  }

  // Gaps (strap lost)
  for (const g of findGaps(session.samples, start, end)) {
    const gx = xf(g.start);
    const gw = xf(g.end) - gx;
    if (gw < 1) continue;
    painter.rect(gx, plotY, gw, plotH, { fill: '#000000', opacity: 0.25 });
    if (gw > 46 * k) painter.text(gx + gw / 2, plotY + 12 * k, 'NO SIGNAL', { size: 8 * k, anchor: 'middle', fill: COLORS.muted, spacing: 0.5 * k });
  }

  // Grid + axes
  for (let v = lo; v <= hi; v += step) {
    const y = yHr(v);
    if (v > lo && v < hi) painter.line(plotX, y, plotX + plotW, y, { stroke: '#ffffff', opacity: 0.08, width: 1 });
    painter.text(plotX - 8 * k, y, String(v), { size: 10.5 * k, anchor: 'end', baseline: 'middle', fill: '#c4cad6', weight: 500 });
  }
  for (let v = 0; v <= 3; v++) {
    painter.text(plotX + plotW + 8 * k, yTen(v), String(v), { size: 10.5 * k, baseline: 'middle', fill: '#c4cad6', weight: 500 });
  }

  // X axis clock labels (+ bold end time, like the original)
  const pxPerMin = plotW / (span / 60000);
  const stepMin = niceStep(span / 60000, (compact ? 62 : 84) * k, pxPerMin);
  const stepMs = stepMin * 60000;
  const endX = plotX + plotW;
  const endLabel = timeTick(end);
  painter.text(endX, plotY + plotH + 16 * k, endLabel, { size: 10.5 * k, anchor: 'end', fill: COLORS.text, weight: 700 });
  const endLabelW = endLabel.length * 6.2 * k + 8 * k;
  for (let t = Math.ceil(start / stepMs) * stepMs; t <= end; t += stepMs) {
    const x = xf(t);
    if (x > endX - endLabelW - 18 * k || x < plotX + 24 * k) continue;
    painter.text(x, plotY + plotH + 16 * k, timeTick(t), { size: 10.5 * k, anchor: 'middle', fill: COLORS.muted, weight: 500 });
  }

  // Phase lines (kick-off, full time)
  for (const pl of phaseLines(session)) {
    if (pl.t > end || pl.t < start) continue;
    const x = xf(pl.t);
    painter.line(x, plotY, x, plotY + plotH, { stroke: '#ffffff', width: 1 * k, opacity: 0.3 });
    painter.text(x + 3 * k, plotY + plotH - 8 * k, pl.label, { size: 8.5 * k, weight: 600, fill: COLORS.muted, spacing: 0.4 * k });
  }

  // HR fill + line
  for (const r of runs(hr10, xf, yHr, 'avg')) {
    if (r.length < 2) continue;
    const base = plotY + plotH;
    painter.path([['M', r[0][0], base], ...r.map((p) => ['L', p[0], p[1]]), ['L', r[r.length - 1][0], base], ['Z']], { fill: COLORS.hr, fillOpacity: 0.08 });
    painter.path(r.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]), { stroke: COLORS.hr, width: 1.15 * k });
  }

  // Stress line: smooth, green when calm → yellow when high
  const grad = painter.gradient(yTen(0.6), yTen(2.6), [
    [0, COLORS.stressLow],
    [1, COLORS.stressHigh],
  ]);
  for (const r of runs(ten, xf, yTen, 'value')) {
    painter.path(monotonePath(r), { stroke: grad, width: 2.4 * k });
  }

  // Moment markers
  moments.forEach((g, i) => {
    const x = mxs[i];
    if (x < plotX - 1 || x > plotX + plotW + 1) return;
    const cy = y0 + 8 * k + radius + rows[i] * rowH;
    painter.line(x, cy + radius, x, plotY + plotH, { stroke: g.color, width: 1 * k, dash: [3 * k, 3 * k], opacity: 0.6 });
    painter.circle(x, cy, radius, { fill: g.color, stroke: 'rgba(0,0,0,0.35)', width: 1 * k });
    painter.text(x, cy + 0.5 * k, String(g.n), {
      size: (g.n > 9 ? 8.5 : 9.5) * k,
      weight: 700,
      anchor: 'middle',
      baseline: 'middle',
      fill: isLight(g.color) ? '#111418' : '#ffffff',
    });
  });

  return { plotX, plotY, plotW, plotH, start, end, xf, yHr, yTen };
}

/** Render to an SVG string at real pixel size. */
export function chartSvg(session, width, height, opts = {}) {
  const p = new SvgPainter();
  drawChart(p, session, 0, 0, width, height, opts);
  return p.toString(width, height);
}

/** Tiny sparkline (SVG string) for history rows. */
export function sparklineSvg(session, w = 96, h = 30) {
  const start = session.startTs;
  const end = sessionEnd(session);
  const b = bucketHr(session.samples, start, end, Math.max(10000, (end - start) / 60)).filter((x) => x.avg != null);
  if (b.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const lo = Math.min(...b.map((x) => x.avg));
  const hi = Math.max(...b.map((x) => x.avg));
  const pts = b.map((x) => [((x.t - start) / (end - start)) * (w - 2) + 1, h - 2 - ((x.avg - lo) / (hi - lo || 1)) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r2(p[0])} ${r2(p[1])}`).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${COLORS.hr}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}
