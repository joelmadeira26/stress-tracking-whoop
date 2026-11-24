# Pulse: heart-rate & tension journal

Pulse records your live heart rate from a WHOOP strap (via **Heart Rate Broadcast** over Bluetooth) during real-life sessions, such as watching football, meetings and workouts. You tag moments as they happen. When the session ends you get a chart, an AI write-up and a shareable image.

**App:** https://joelmadeira26.github.io/stress-tracking-whoop/

![Example export](docs/example-export.png)

## Features
- **Live**: big BPM, session clock (football match minute: 1'–45', 45+x', HT, 46'–90', 90+x', FT), live chart, thumb-sized tag buttons, free-text tags, Undo, and End (tap twice to confirm).
- **Session types**: *Watching sport* (phase button, goals per team with a running score, big chance, penalty, red card, VAR), *Meeting* ("I'm speaking" band), *Workout* ("Set / interval" band).
- **Chart**: 10-second heart-rate averages (blue, left axis) and tension (gold, 0–3, right axis). Numbered tag circles, staggered into up to 3 rows. Shaded bands (half-time, speaking, sets), kick-off and full-time lines, and gaps marked where the strap dropped out. Rendered as SVG at real pixel size, and redrawn when the screen resizes.
- **End screen**: notes, forgotten moments (minute + label), and quick stats (duration, average and peak HR with what was happening at the peak, time above calm).
- **AI write-up**: Anthropic Messages API called straight from the browser. Your key is stored only on your device.
- **Share**: 1440 px PNG (2x) with title, date and time range, chart, numbered legend and the Pulse mark, sent through the Web Share API (WhatsApp, Instagram, LinkedIn…), with a download fallback.
- **History**: filter by type, sparklines, and an average-peak comparison across types.
- **Reliability**: Screen Wake Lock, auto-reconnect with increasing waits, autosave every 5 s with "Resume your session?", and IndexedDB storage.
- **PWA**: installable and works offline (service worker: network-first, cache fallback).

### Tension (Pulse's own estimate)
WHOOP's Stress Monitor isn't available over Bluetooth, so Pulse estimates tension from 0 to 3 every 30 s:
- HR part = (60 s average HR − resting HR) / 15, clamped to 0–3
- HRV part (when RR intervals arrive) = 1.5 × log2(baseline RMSSD / current 60 s RMSSD) + 1, clamped to 0–3. The baseline comes from the period before kick-off (if at least 2 min) or the first 5 minutes.
- Tension = the average of the available parts.

"Calm" means at or below resting HR + 15 bpm.

## Adding a new session type
All types live in **`js/config.js` → `SESSION_TYPES`**. Add one entry:

```js
podcast: {
  label: 'Recording a podcast',
  short: 'Podcast',
  icon: 'chat',               // key from ICONS in the same file
  defaultMode: 'doing',       // 'watching' | 'doing'
  clock: 'elapsed',           // or 'match' for a football-style minute
  titleHint: 'Episode 12',
  toggle: { key: 'live', button: 'On air', label: 'On air', color: '#f472b6' }, // optional band
  tags: [
    { key: 'laugh', label: 'Big laugh', color: '#34d399' },
    { key: 'flub',  label: 'Flubbed it', color: '#f87171' },
  ],
},
```

The Start button, live tag buttons, history filter and chart all pick it up automatically. For a demo, add a generator to `DEMOS` in `js/demo.js`.

## Files
```
index.html               app shell
css/styles.css           design
js/config.js             session types, tags, colours, icons
js/hr.js                 0x2A37 heart-rate parser + 1 Hz aggregator
js/ble.js                Web Bluetooth connection + auto-reconnect
js/analysis.js           buckets, tension, match clock, stats
js/chart.js              chart (one drawing routine → SVG on screen, canvas for PNG)
js/export.js             PNG export + Web Share
js/ai.js                 AI write-up request
js/db.js                 IndexedDB storage
js/demo.js               demo sessions
js/app.js                screens, routing, live session
sw.js, manifest.webmanifest, icons/   PWA
tests/                   unit tests (node) + browser end-to-end test (Playwright)
```

## Running locally & tests
No build step. Serve the folder over HTTP, for example with `python3 -m http.server 8080`, and open http://localhost:8080 (Web Bluetooth works on localhost).

```
npm run test:unit   # parser (8/16-bit, RR, energy), tension, match clock, chart, mocked AI
npm run test:e2e    # headless Chromium: fake strap, live football session, reconnect,
                    # resume after reload, end screen, mocked AI, PNG export + share, 360 px & desktop
```
