// Reminders without a server: an .ics file your phone's calendar imports, with an alert before kick-off.

const fmt = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** events: [{ key, title, start, end, description }] */
export function buildIcs(events, { alarmMin = 15 } = {}) {
  const now = fmt(Date.now());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pulse//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${esc(e.key)}@pulse`,
      `DTSTAMP:${now}`,
      `DTSTART:${fmt(e.start)}`,
      `DTEND:${fmt(e.end || e.start + 2 * 3600e3)}`,
      `SUMMARY:${esc(e.title)}`,
      `DESCRIPTION:${esc(e.description || 'Open Pulse, connect your strap and tap Watch.')}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(e.title)}`,
      `TRIGGER:-PT${Math.max(0, Math.round(alarmMin))}M`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function fixtureToEvent(ev, appUrl) {
  const title = ev.source === 'openf1' ? `🏎️ ${ev.meetingName} ${ev.sessionName}` : `⚽ ${ev.home.short} v ${ev.away.short}`;
  return {
    key: ev.key.replace(/[^a-z0-9:]/gi, ''),
    title,
    start: ev.date,
    end: ev.end || ev.date + (ev.source === 'openf1' ? 2 : 2) * 3600e3,
    description: `${ev.competition}. Open Pulse (${appUrl}), connect your strap and tap Watch.`,
  };
}
