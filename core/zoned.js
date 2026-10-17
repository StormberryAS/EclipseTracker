const MINUTE = 60000;
const DAY = 86400000;
const formatters = new Map();
function formatter(zone) {
    let f = formatters.get(zone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatters.set(zone, f);
    }
    return f;
}
export function isKnownZone(zone) {
    try {
        formatter(zone);
        return true;
    }
    catch {
        return false;
    }
}
export function deviceZone() {
    try {
        const z = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return z && isKnownZone(z) ? z : 'UTC';
    }
    catch {
        return 'UTC';
    }
}
function parts(zone, epochMs) {
    const out = {};
    for (const p of formatter(zone).formatToParts(new Date(epochMs))) {
        if (p.type !== 'literal')
            out[p.type] = Number(p.value);
    }
    const get = (k) => {
        const v = out[k];
        if (v === undefined || Number.isNaN(v))
            throw new RangeError(`no ${k} for ${zone} at ${epochMs}`);
        return v;
    };
    const hour = get('hour');
    return { y: get('year'), m: get('month'), d: get('day'), hh: hour === 24 ? 0 : hour, mm: get('minute'), ss: get('second') };
}
export function offsetMinutes(zone, epochMs) {
    const p = parts(zone, epochMs);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const whole = Math.floor(epochMs / 1000) * 1000;
    return Math.round((asUtc - whole) / MINUTE);
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
export function localDateTime(zone, epochMs) {
    const p = parts(zone, epochMs);
    return { date: `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}` };
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isWallTime(text) {
    return TIME_RE.test(text);
}
export function addDays(iso, n) {
    const m = DATE_RE.exec(iso);
    if (!m)
        throw new RangeError(`not a date: ${iso}`);
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
    return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function weekday(iso) {
    const m = DATE_RE.exec(iso);
    if (!m)
        throw new RangeError(`not a date: ${iso}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}
export function wallTimeToInstant(zone, date, time) {
    const dm = DATE_RE.exec(date);
    const tm = TIME_RE.exec(time);
    if (!dm)
        throw new RangeError(`not a date: ${date}`);
    if (!tm)
        throw new RangeError(`not a time: ${time}`);
    const wall = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
    const before = offsetMinutes(zone, wall - DAY);
    const after = offsetMinutes(zone, wall + DAY);
    const valid = [...new Set([before, after])]
        .map((o) => wall - o * MINUTE)
        .filter((t) => offsetMinutes(zone, t) * MINUTE === wall - t)
        .sort((a, b) => a - b);
    const first = valid[0];
    if (first !== undefined)
        return { epochMs: first, dst: valid.length > 1 ? 'overlap' : 'none' };
    return { epochMs: wall - before * MINUTE, dst: 'gap' };
}
