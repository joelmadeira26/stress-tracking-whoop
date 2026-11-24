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
      `<text x="${r2(x)}" y="${r2(y)}" fill="${st.fill || COLORS.text}" font-family="${esc(fam)}" font-size="${st.size || 11}" font-weight="${st.weight || 400}" text-anchor="${anchor}" dominant-baseline="${st.baseline === 'middle' ? 'central' : 'alphabetic'}"${st.opacity != null ? ` fill-opacity="${st.opacity}"` : ''}>${esc(str)}</text>`,
    );
  }
  toString(w, h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Heart rate and tension chart">${this.parts.join('')}</svg>`;
  }
}

export class CanvasPainter {
  constructor(ctx) {
    this.ctx = ctx;
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

/**
 * Draws the chart into `painter` inside box (x0, y0, W, H).
 * opts: { restingHr, now (live end time), scale (font scale) }
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
  const radius = (compact ? 8.5 : 10) * k;
  const rowH = radius * 2 + 3 * k;

  const xLeftPad = (compact ? 30 : 40) * k;
  const xRightPad = (compact ? 22 : 34) * k;
  const plotX = x0 + xLeftPad;
  const plotW = W - xLeftPad - xRightPad;

  // Stagger markers first to know how many rows we need.
  const xf = (t) => plotX + ((t - start) / span) * plotW;
  const mxs = moments.map((g) => xf(g.t));
  const rows = staggerMarkers(mxs, radius, 3);
  const nRows = moments.length ? Math.max(...rows) + 1 : 0;

  const topPad = (16 + nRows * rowH + (nRows ? 4 : 0)) * 1 + 2 * k;
  const bottomPad = 22 * k;
  const plotY = y0 + topPad;
  const plotH = H - topPad - bottomPad;

  // Data
  const hr10 = bucketHr(session.samples, start, end, 10 * 1000);
  const ten = tensionSeries(session, rest).series.filter((p) => p.t <= end + 1);
  const vals = hr10.filter((b) => b.avg != null).map((b) => b.avg);
  let lo = vals.length ? Math.min(...vals) : rest;
  let hi = vals.length ? Math.max(...vals) : rest + 40;
  lo = Math.floor((Math.min(lo, rest + 5) - 5) / 10) * 10;
  hi = Math.ceil((hi + 5) / 10) * 10;
  if (hi - lo < 30) hi = lo + 30;
  const yHr = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
  const yTen = (v) => plotY + plotH - (v / 3) * plotH;

  // Panel background
  painter.rect(plotX, plotY, plotW, plotH, { fill: '#0b1530', opacity: 1 });

  // Bands
  const bands = allBands(session, opts.now);
  for (const b of bands) {
    const bx = Math.max(plotX, xf(b.start));
    const bw = Math.min(plotX + plotW, xf(b.end)) - bx;
    if (bw <= 0) continue;
    painter.rect(bx, plotY, bw, plotH, { fill: b.color || '#ffffff', opacity: b.key === 'halftime' ? 0.16 : 0.13 });
    if (bw > 26 * k) {
      painter.text(bx + 4 * k, plotY + 12 * k, b.label, {
        size: 9.5 * k,
        weight: 600,
        fill: b.color || COLORS.text,
        opacity: 0.95,
      });
    }
  }

  // Gaps (strap lost)
  for (const g of findGaps(session.samples, start, end)) {
    const gx = xf(g.start);
    const gw = xf(g.end) - gx;
    if (gw < 1) continue;
    painter.rect(gx, plotY, gw, plotH, { fill: '#ffffff', opacity: 0.045 });
    if (gw > 46 * k) painter.text(gx + gw / 2, plotY + plotH - 6 * k, 'no signal', { size: 9 * k, anchor: 'middle', fill: COLORS.muted });
  }

  // Grid + left axis (bpm)
  const tickEvery = plotH / ((hi - lo) / 10) < 18 * k ? 20 : 10;
  for (let v = Math.ceil(lo / tickEvery) * tickEvery; v <= hi; v += tickEvery) {
    const y = yHr(v);
    painter.line(plotX, y, plotX + plotW, y, { stroke: '#ffffff', opacity: 0.07, width: 1 });
    painter.text(plotX - 6 * k, y, String(v), { size: 10.5 * k, anchor: 'end', baseline: 'middle', fill: COLORS.hr, font: 'num', weight: 600 });
  }
  // Right axis (tension 0–3)
  for (let v = 0; v <= 3; v++) {
    painter.text(plotX + plotW + 6 * k, yTen(v), String(v), { size: 10.5 * k, baseline: 'middle', fill: COLORS.tension, font: 'num', weight: 600 });
  }
  painter.text(plotX - 6 * k, plotY - 13 * k, 'bpm', { size: 9 * k, anchor: 'end', fill: COLORS.hr, weight: 600 });

  // X axis clock labels
  const pxPerMin = plotW / (span / 60000);
  const stepMin = niceStep(span / 60000, (compact ? 52 : 70) * k, pxPerMin);
  const stepMs = stepMin * 60000;
  const first = Math.ceil(start / stepMs) * stepMs;
  for (let t = first; t <= end; t += stepMs) {
    const x = xf(t);
    painter.line(x, plotY + plotH, x, plotY + plotH + 4 * k, { stroke: '#ffffff', opacity: 0.35 });
    painter.text(x, plotY + plotH + 16 * k, clockTime(t), { size: 10.5 * k, anchor: 'middle', fill: COLORS.axis, font: 'num', weight: 500 });
  }

  // Phase lines (kick-off, full time)
  for (const pl of phaseLines(session)) {
    if (pl.t > end) continue;
    const x = xf(pl.t);
    painter.line(x, plotY, x, plotY + plotH, { stroke: '#ffffff', width: 1.4 * k, opacity: 0.6 });
    painter.text(x + 3 * k, plotY + plotH - 6 * k, pl.label, { size: 9.5 * k, weight: 700, fill: '#ffffff', opacity: 0.8, font: 'num' });
  }

  // HR fill + line
  const hrRuns = runs(hr10, xf, yHr, 'avg');
  for (const r of hrRuns) {
    if (r.length < 2) continue;
    const base = plotY + plotH;
    const fill = [['M', r[0][0], base], ...r.map((p) => ['L', p[0], p[1]]), ['L', r[r.length - 1][0], base], ['Z']];
    painter.path(fill, { fill: COLORS.hr, fillOpacity: 0.14 });
    painter.path(r.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]), { stroke: COLORS.hr, width: 1.7 * k });
  }

  // Tension line (smooth)
  for (const r of runs(ten, xf, yTen, 'value')) {
    painter.path(monotonePath(r), { stroke: COLORS.tension, width: 2.2 * k });
  }

  // Tag markers
  const markerTop = y0 + 14 * k;
  moments.forEach((g, i) => {
    const x = mxs[i];
    if (x < plotX - 1 || x > plotX + plotW + 1) return;
    const cy = markerTop + radius + rows[i] * rowH;
    painter.line(x, cy + radius, x, plotY + plotH, { stroke: g.color, width: 1.2 * k, dash: [3 * k, 3 * k], opacity: 0.85 });
    painter.circle(x, cy, radius, { fill: g.color, stroke: '#070d1c', width: 1.5 * k });
    painter.text(x, cy + 0.5 * k, String(g.n), {
      size: (g.n > 9 ? 10 : 11.5) * k,
      weight: 700,
      anchor: 'middle',
      baseline: 'middle',
      fill: '#07101f',
      font: 'num',
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${COLORS.hr}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
