import { LUNAR_ELEMENTS, SOLAR_ELEMENTS } from './elements.js?v=003a9738';
export const SUN_LIMIT_DEG = -0.833;
export const REFRACTION_DEG = 0.5667;
const HOUR = 3600000;
const STEP = 60000;
const FINE = 1000;
const RAD = Math.PI / 180;
const FLATTENING = 0.99664719;
function upSpans(up, from, to) {
    const samples = [];
    for (let t = from; t < to; t += STEP)
        samples.push(t);
    samples.push(to);
    const flags = samples.map(up);
    const out = [];
    let i = 0;
    while (i < samples.length) {
        if (!flags[i]) {
            i += 1;
            continue;
        }
        let j = i;
        while (j + 1 < samples.length && flags[j + 1])
            j += 1;
        let start = samples[i] ?? from;
        if (i > 0) {
            let lo = samples[i - 1] ?? from;
            let hi = start;
            while (hi - lo > FINE) {
                const mid = (lo + hi) / 2;
                if (up(mid))
                    hi = mid;
                else
                    lo = mid;
            }
            start = hi;
        }
        let end = samples[j] ?? to;
        if (j < samples.length - 1) {
            let lo = end;
            let hi = samples[j + 1] ?? to;
            while (hi - lo > FINE) {
                const mid = (lo + hi) / 2;
                if (up(mid))
                    lo = mid;
                else
                    hi = mid;
            }
            end = lo;
        }
        out.push({ start, end });
        i = j + 1;
    }
    return out;
}
function mergeSpans(a, b) {
    const out = [];
    for (const s of [...a, ...b].sort((x, y) => x.start - y.start)) {
        const last = out[out.length - 1];
        if (last && s.start <= last.end + FINE)
            out[out.length - 1] = { start: last.start, end: Math.max(last.end, s.end) };
        else
            out.push(s);
    }
    return out;
}
function seenOf(spans, deepest) {
    const first = spans[0];
    const last = spans[spans.length - 1];
    if (!first || !last)
        return null;
    let max = deepest;
    if (!spans.some((s) => deepest >= s.start && deepest <= s.end)) {
        let best = Number.POSITIVE_INFINITY;
        for (const s of spans) {
            for (const edge of [s.start, s.end]) {
                if (Math.abs(edge - deepest) < best) {
                    best = Math.abs(edge - deepest);
                    max = edge;
                }
            }
        }
    }
    return { start: first.start, end: last.end, gap: spans.length > 1, max };
}
const cubic = (c, t) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));
const cubicRate = (c, t) => c[1] + t * (2 * c[2] + t * 3 * c[3]);
const quad = (c, t) => c[0] + t * (c[1] + t * c[2]);
const quadRate = (c, t) => c[1] + t * 2 * c[2];
function place(o) {
    const lat = o.lat * RAD;
    const u = Math.atan(FLATTENING * Math.tan(lat));
    return { lat, lon: o.lon * RAD, rs: FLATTENING * Math.sin(u), rc: Math.cos(u) };
}
function shadow(el, p, t) {
    const x = cubic(el.x, t);
    const y = cubic(el.y, t);
    const d = quad(el.d, t) * RAD;
    const dd = quadRate(el.d, t) * RAD;
    const dmu = quadRate(el.mu, t) * RAD;
    const h = (quad(el.mu, t) - 0.00417807 * el.dT) * RAD + p.lon;
    const xi = p.rc * Math.sin(h);
    const eta = p.rs * Math.cos(d) - p.rc * Math.cos(h) * Math.sin(d);
    const zeta = p.rs * Math.sin(d) + p.rc * Math.cos(h) * Math.cos(d);
    const dxi = dmu * p.rc * Math.cos(h);
    const deta = dmu * xi * Math.sin(d) - zeta * dd;
    const u = x - xi;
    const v = y - eta;
    const a = cubicRate(el.x, t) - dxi;
    const b = cubicRate(el.y, t) - deta;
    const alt = Math.asin(Math.sin(d) * Math.sin(p.lat) + Math.cos(d) * Math.cos(p.lat) * Math.cos(h)) / RAD;
    return {
        u, v, a, b, n2: a * a + b * b, m: Math.hypot(u, v),
        l1: quad(el.l1, t) - zeta * el.f1,
        l2: quad(el.l2, t) - zeta * el.f2,
        alt,
    };
}
function solarMaximum(el, p) {
    let t = 0;
    for (let i = 0; i < 50; i += 1) {
        const s = shadow(el, p, t);
        const tau = (s.u * s.a + s.v * s.b) / s.n2;
        t -= tau;
        if (Math.abs(tau) < 1e-8)
            break;
    }
    return t;
}
function contact(el, p, from, which, sign) {
    let t = from;
    for (let i = 0; i < 50; i += 1) {
        const s = shadow(el, p, t);
        const n = Math.sqrt(s.n2);
        const radius = s[which];
        const k = (s.a * s.v - s.u * s.b) / (n * radius);
        if (!(Math.abs(k) <= 1))
            return null;
        const tau = (s.u * s.a + s.v * s.b) / s.n2 - sign * Math.sqrt(1 - k * k) * radius / n;
        t -= tau;
        if (Math.abs(tau) < 1e-7)
            return t;
    }
    return null;
}
export function solarContacts(el, o) {
    const p = place(o);
    const base = Date.parse(el.t0) - el.dT * 1000;
    const ms = (t) => base + t * HOUR;
    const tm = solarMaximum(el, p);
    const s = shadow(el, p, tm);
    if ((s.l1 - s.m) / (s.l1 + s.l2) <= 0)
        return null;
    const c1 = contact(el, p, tm, 'l1', -1);
    const c4 = contact(el, p, tm, 'l1', 1);
    if (c1 === null || c4 === null || c1 < -4 || c4 > 4)
        return null;
    const out = { c1: ms(c1), c4: ms(c4), tmax: ms(tm) };
    if (s.m < Math.abs(s.l2)) {
        const a = contact(el, p, tm, 'l2', -1);
        const b = contact(el, p, tm, 'l2', 1);
        if (a !== null && b !== null) {
            out.c2 = ms(Math.min(a, b));
            out.c3 = ms(Math.max(a, b));
        }
    }
    return out;
}
function obscurationOf(l1, l2, m) {
    const rs = (l1 + l2) / 2;
    const rm = (l1 - l2) / 2;
    if (m >= rs + rm)
        return 0;
    if (m <= Math.abs(rm - rs))
        return Math.min(1, (rm / rs) ** 2);
    const a1 = rs * rs * Math.acos((m * m + rs * rs - rm * rm) / (2 * m * rs));
    const a2 = rm * rm * Math.acos((m * m + rm * rm - rs * rs) / (2 * m * rm));
    const a3 = 0.5 * Math.sqrt((-m + rs + rm) * (m + rs - rm) * (m - rs + rm) * (m + rs + rm));
    return (a1 + a2 - a3) / (Math.PI * rs * rs);
}
export function solarLocal(el, o) {
    const c = solarContacts(el, o);
    if (!c)
        return null;
    const p = place(o);
    const base = Date.parse(el.t0) - el.dT * 1000;
    const at = (ms) => (ms - base) / HOUR;
    const sunUp = (ms) => shadow(el, p, at(ms)).alt > SUN_LIMIT_DEG;
    const seen = seenOf(upSpans(sunUp, c.c1, c.c4), c.tmax);
    if (!seen)
        return null;
    const { start, end, max } = seen;
    const s = shadow(el, p, at(max));
    const inTotality = c.c2 !== undefined && c.c3 !== undefined && max >= c.c2 && max <= c.c3;
    const magnitude = inTotality ? (s.l1 - s.l2) / (s.l1 + s.l2) : (s.l1 - s.m) / (s.l1 + s.l2);
    let type = 'partial';
    if (c.c2 !== undefined && c.c3 !== undefined && upSpans(sunUp, c.c2, c.c3).length > 0) {
        type = shadow(el, p, at(c.tmax)).l2 < 0 ? 'total' : 'annular';
    }
    return {
        id: el.id, type, start, end, max,
        startsAtRise: start > c.c1,
        endsAtSet: end < c.c4,
        gap: seen.gap,
        magnitude,
        obscuration: inTotality && s.l2 < 0 ? 1 : obscurationOf(s.l1, s.l2, s.m),
    };
}
function moonAltitude(el, p, t) {
    const ra = quad(el.ra, t);
    const dec = quad(el.dec, t) * RAD;
    const h = (15 * (el.gst + (t - el.dT / 3600) * 1.00273791) - ra) * RAD + p.lon;
    const geocentric = Math.asin(Math.sin(p.lat) * Math.sin(dec) + Math.cos(p.lat) * Math.cos(dec) * Math.cos(h));
    return (geocentric - Math.asin(Math.sin(el.hp * RAD) * Math.cos(geocentric))) / RAD;
}
export function lunarLocal(el, o) {
    const p = place(o);
    const base = Date.parse(el.t0) - el.dT * 1000;
    const ms = (t) => base + t * HOUR;
    const at = (x) => (x - base) / HOUR;
    const [p1, u1, u2, greatest, u3, u4, p4] = el.c;
    const moonUp = (x) => moonAltitude(el, p, at(x)) > -(REFRACTION_DEG + el.sd);
    const penumbral = u1 === null || u4 === null;
    const test = upSpans(moonUp, ms(penumbral ? p1 : (u1 ?? p1)), ms(penumbral ? p4 : (u4 ?? p4)));
    if (test.length === 0)
        return null;
    const seen = seenOf(mergeSpans(upSpans(moonUp, ms(p1), ms(p4)), test), ms(greatest));
    if (!seen)
        return null;
    const { start, end, max } = seen;
    let type = 'penumbral';
    if (!penumbral) {
        type = u2 !== null && u3 !== null && upSpans(moonUp, ms(u2), ms(u3)).length > 0 ? 'total' : 'partial';
    }
    return {
        id: el.id, type, start, end, max,
        startsAtRise: start > ms(p1),
        endsAtSet: end < ms(p4),
        gap: seen.gap,
        altitude: moonAltitude(el, p, at(max)),
    };
}
export function sunAltitude(el, o, epochMs) {
    return shadow(el, place(o), (epochMs - (Date.parse(el.t0) - el.dT * 1000)) / HOUR).alt;
}
export function moonAltitudeAt(el, o, epochMs) {
    return moonAltitude(el, place(o), (epochMs - (Date.parse(el.t0) - el.dT * 1000)) / HOUR);
}
const SOLAR = new Map(SOLAR_ELEMENTS.map((el) => [el.id, el]));
const LUNAR = new Map(LUNAR_ELEMENTS.map((el) => [el.id, el]));
export function localFor(e, o) {
    if (e.kind === 'solar') {
        const el = SOLAR.get(e.id);
        return el ? solarLocal(el, o) : null;
    }
    const el = LUNAR.get(e.id);
    return el ? lunarLocal(el, o) : null;
}
export function localAll(o) {
    const out = new Map();
    for (const el of SOLAR_ELEMENTS) {
        const l = solarLocal(el, o);
        if (l)
            out.set(el.id, l);
    }
    for (const el of LUNAR_ELEMENTS) {
        const l = lunarLocal(el, o);
        if (l)
            out.set(el.id, l);
    }
    return out;
}
