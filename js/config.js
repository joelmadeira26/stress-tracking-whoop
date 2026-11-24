// Pulse — central configuration.
// To add a new session type, add one entry to SESSION_TYPES (see README).

export const COLORS = {
  bg: '#070d1c',
  panel: '#0e1830',
  grid: 'rgba(255,255,255,0.07)',
  axis: 'rgba(255,255,255,0.55)',
  text: '#f4f7fb',
  muted: '#8a97b3',
  hr: '#3da5ff',
  tension: '#f5c242',
  mine: '#2ed47a',
  theirs: '#ff4d5e',
  free: '#e2e8f0',
  gap: 'rgba(255,255,255,0.05)',
};

/*
 * Each session type:
 *  label        – shown on Start buttons and in history
 *  icon         – key of an icon in ICONS below
 *  defaultMode  – 'watching' | 'doing'
 *  clock        – 'match' (football minute) | 'elapsed'
 *  phases       – optional list of phases the Phase button steps through
 *  toggle       – optional on/off switch that draws a band on the chart
 *  tags         – tag buttons. `team: 'home'|'away'` marks a goal button
 *                 (label/colour are worked out from the teams & score).
 *  titleHint    – placeholder for the title field
 */
export const SESSION_TYPES = {
  sport: {
    label: 'Watching sport',
    short: 'Sport',
    icon: 'ball',
    defaultMode: 'watching',
    clock: 'match',
    titleHint: 'Benfica v Porto',
    teams: true,
    phases: [
      { key: 'kickoff', button: 'Kick-off', label: 'Kick-off' },
      { key: 'halftime', button: 'Half-time', label: 'Half-time' },
      { key: 'secondhalf', button: 'Second half', label: 'Second half' },
      { key: 'fulltime', button: 'Full time', label: 'Full time' },
    ],
    tags: [
      { key: 'goal_home', team: 'home', label: 'Goal' },
      { key: 'goal_away', team: 'away', label: 'Goal' },
      { key: 'chance', label: 'Big chance', color: '#22d3ee' },
      { key: 'penalty', label: 'Penalty', color: '#a78bfa' },
      { key: 'redcard', label: 'Red card', color: '#fb923c' },
      { key: 'var', label: 'VAR check', color: '#94a3b8' },
    ],
  },
  meeting: {
    label: 'Meeting',
    short: 'Meeting',
    icon: 'chat',
    defaultMode: 'doing',
    clock: 'elapsed',
    titleHint: 'Interview with Zinc',
    toggle: { key: 'speaking', button: "I'm speaking", label: 'Speaking', color: '#22d3ee' },
    tags: [
      { key: 'tough', label: 'Tough question', color: '#f87171' },
      { key: 'well', label: 'Went well', color: '#34d399' },
      { key: 'awkward', label: 'Awkward moment', color: '#f472b6' },
      { key: 'decision', label: 'Key decision', color: '#a78bfa' },
      { key: 'pitch', label: 'My pitch / ask', color: '#22d3ee' },
    ],
  },
  workout: {
    label: 'Workout',
    short: 'Workout',
    icon: 'bolt',
    defaultMode: 'doing',
    clock: 'elapsed',
    titleHint: 'Leg day',
    toggle: { key: 'set', button: 'Set / interval', label: 'Set', color: '#a78bfa' },
    tags: [
      { key: 'exercise', label: 'New exercise', color: '#22d3ee' },
      { key: 'hard', label: 'Felt hard', color: '#f87171' },
      { key: 'pb', label: 'Personal best', color: '#34d399' },
      { key: 'rest', label: 'Rest', color: '#94a3b8' },
      { key: 'cooldown', label: 'Cool-down', color: '#60a5fa' },
    ],
  },
};

export const FREE_TAG = { key: 'free', label: 'Note', color: COLORS.free };

export const DEFAULT_SETTINGS = {
  restingHr: 60,
  apiKey: '',
  model: 'claude-sonnet-5-5',
};

// Calm zone ceiling = resting HR + this (same 15 bpm that makes the HR part of tension = 1).
export const CALM_MARGIN = 15;

export const ICONS = {
  ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l4 2.9-1.5 4.7h-5L8 10.4z"/><path d="M12 3v4.5M16 10.4l4.3-1.4M14.5 15.1l2.7 3.7M9.5 15.1l-2.7 3.7M8 10.4L3.7 9"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v11H9l-5 4z" stroke-linejoin="round"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L4 14h7l-1 8 9-12h-7z" stroke-linejoin="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.5-9.4C1.2 8.2 3.4 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.6 0 5.8 3.7 4.5 7.1C19.5 16.4 12 21 12 21z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" stroke-linejoin="round"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
