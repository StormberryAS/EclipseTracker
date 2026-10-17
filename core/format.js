import { localDateTime, offsetMinutes, weekday } from './zoned.js?v=d3e47120';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TYPE_WORDS = {
    total: 'Total',
    annular: 'Annular',
    hybrid: 'Hybrid',
    partial: 'Partial',
    penumbral: 'Penumbral',
};
export function eclipseName(e) {
    return `${TYPE_WORDS[e.type]} ${e.kind} eclipse`;
}
function dateParts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
    const dayName = DAYS[weekday(iso)];
    if (!m || month === undefined || dayName === undefined)
        throw new RangeError(`not a date: ${iso}`);
    return { y: Number(m[1]), month, d: Number(m[3]), dayName };
}
export function dateWords(iso) {
    const { y, month, d } = dateParts(iso);
    return `${d} ${month} ${y}`;
}
export function longDate(iso) {
    return `${dateParts(iso).dayName} ${dateWords(iso)}`;
}
export function shortDate(iso) {
    const { y, month, d, dayName } = dateParts(iso);
    return `${dayName.slice(0, 3)} ${d} ${month.slice(0, 3)} ${y}`;
}
export function offsetWords(minutes) {
    if (minutes === 0)
        return 'UTC';
    const sign = minutes > 0 ? '+' : '−';
    const a = Math.abs(minutes);
    const h = Math.floor(a / 60);
    const m = a % 60;
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
export function greatestMinute(e) {
    return Math.floor((Date.parse(e.greatest) + 30000) / 60000) * 60000;
}
export function localWhen(zone, epochMs) {
    const { date, time } = localDateTime(zone, epochMs);
    return `${longDate(date)} at ${time} (${offsetWords(offsetMinutes(zone, epochMs))})`;
}
export function utcWhen(epochMs) {
    const { date, time } = localDateTime('UTC', epochMs);
    return `${time} UTC on ${dateWords(date)}`;
}
export function magnitudeWords(e) {
    const label = e.kind === 'solar' ? 'Magnitude' : e.type === 'penumbral' ? 'Penumbral magnitude' : 'Umbral magnitude';
    return { label, value: e.shownMagnitude };
}
export function countdownParts(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}
export function countdownWords(ms) {
    const { days, hours, minutes } = countdownParts(ms);
    const unit = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const bits = [days ? unit(days, 'day') : '', hours ? unit(hours, 'hour') : '', unit(minutes, 'minute')].filter(Boolean);
    const last = bits.pop() ?? '';
    return bits.length > 0 ? `${bits.join(', ')} and ${last}` : last;
}
const BEFORE_WORDS = { 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 120: '2 hours' };
const DAY_WORDS = { 0: 'On the day of the eclipse', 1: '1 day before', 2: '2 days before', 3: '3 days before', 7: '1 week before' };
export function alarmWords(spec) {
    if (spec.kind === 'before')
        return `${BEFORE_WORDS[spec.minutes]} before greatest eclipse`;
    return `${DAY_WORDS[spec.daysBefore]} at ${spec.time}`;
}
export const DAY_CHOICES = [
    { value: 'day-0', label: 'On the day of the eclipse' },
    { value: 'day-1', label: '1 day before' },
    { value: 'day-2', label: '2 days before' },
    { value: 'day-3', label: '3 days before' },
    { value: 'day-7', label: '1 week before' },
    { value: 'before', label: 'Before greatest eclipse' },
];
export const BEFORE_CHOICES = [
    { value: 15, label: '15 minutes before' },
    { value: 30, label: '30 minutes before' },
    { value: 60, label: '1 hour before' },
    { value: 120, label: '2 hours before' },
];
export const ICS_FILE_NAME = /^eclipse-\d{4}-\d{2}-\d{2}-(solar|lunar)\.ics$/;
export function icsFileName(e) {
    const name = `eclipse-${e.id}.ics`;
    if (!ICS_FILE_NAME.test(name))
        throw new RangeError(`not an eclipse id: ${e.id}`);
    return name;
}
export function isIcsFileName(name) {
    return typeof name === 'string' && ICS_FILE_NAME.test(name);
}
