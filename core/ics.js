import { eclipseName, greatestMinute, magnitudeWords, utcWhen } from './format.js?v=be22d0d5';
import { MAX_ALARMS, ringing } from './alarms.js?v=4a8fb0af';
export const PRODID = '-//Stormberry AS//EclipseTracker 2.0//EN';
export const EVENT_MINUTES = 30;
export function escapeText(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}
function octets(ch) {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}
export function foldLine(line) {
    const out = [];
    let current = '';
    let size = 0;
    for (const ch of line) {
        const n = octets(ch);
        if (size + n > 75) {
            out.push(current);
            current = ' ';
            size = 1;
        }
        current += ch;
        size += n;
    }
    out.push(current);
    return out.join('\r\n');
}
export function utcStamp(epochMs) {
    return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
export function triggerDuration(minutes) {
    if (!Number.isInteger(minutes))
        throw new RangeError(`not whole minutes: ${minutes}`);
    if (minutes === 0)
        return 'PT0S';
    const a = Math.abs(minutes);
    const d = Math.floor(a / 1440);
    const h = Math.floor((a % 1440) / 60);
    const m = a % 60;
    const time = h || m ? `T${h ? `${h}H` : ''}${m ? `${m}M` : ''}` : '';
    return `${minutes < 0 ? '-' : ''}P${d ? `${d}D` : ''}${time}`;
}
export function triggerLine(fireAt, start) {
    return `TRIGGER:${triggerDuration((fireAt - start) / 60000)}`;
}
export function eventTitle(e) {
    return eclipseName(e);
}
export function eventDescription(e) {
    const mag = magnitudeWords(e);
    return [
        `${eclipseName(e)}. Greatest eclipse at ${utcWhen(greatestMinute(e))}.`,
        `${mag.label}: ${mag.value}.`,
        `Visible from: ${e.region}.`,
        ...(e.path ? [`Path of the ${e.type === 'hybrid' ? 'central' : e.type} eclipse: ${e.path}.`] : []),
        '',
        'Times from NASA\'s eclipse catalogue (Fred Espenak, NASA Goddard Space Flight Center), rounded to the minute.',
        'Made with EclipseTracker by Stormberry AS, eclipse.stormberry.as.',
    ].join('\n');
}
export function buildIcs({ eclipse, alarms, uid, dtstamp }) {
    if (!/^[0-9a-f]{16,64}$/.test(uid))
        throw new RangeError('uid must be 16 to 64 hex digits');
    if (alarms.length > MAX_ALARMS)
        throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${alarms.length}`);
    const start = greatestMinute(eclipse);
    const title = eventTitle(eclipse);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${PRODID}`,
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${uid}@eclipse.stormberry.as`,
        `DTSTAMP:${utcStamp(dtstamp)}`,
        `DTSTART:${utcStamp(start)}`,
        `DTEND:${utcStamp(start + EVENT_MINUTES * 60000)}`,
        `SUMMARY:${escapeText(title)}`,
        `DESCRIPTION:${escapeText(eventDescription(eclipse))}`,
        'TRANSP:TRANSPARENT',
    ];
    for (const a of ringing(alarms)) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(title)}`, triggerLine(a.fireAt, start), 'END:VALARM');
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
