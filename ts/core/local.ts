// An eclipse as seen from one place: whether it can be seen, when it starts and ends there, and
// how deep it is. Pure functions with no DOM, no Date.now() and no Intl, so the Kotlin app can copy
// them one day; the zone and the clock never come in here. The inputs are the element sets of
// elements.ts (NASA's Besselian elements of the solar eclipses and the lunar eclipse elements, both
// by Fred Espenak and Jean Meeus) and the place: a latitude and a longitude, at sea level.
//
// The method is the published one, written out here from the description of it and not from the
// code of NASA's explorers (that code is GPL and is not copied): the observer's place on the
// fundamental plane, the shadow axis and the radii of the penumbral and umbral cones there, and the
// first, last, second and third contacts as the moments the observer is at the edge of a cone.
// For the Moon the elements give its right ascension and declination; its altitude follows from
// the sidereal time, with the parallax. tools/vectors/build-local-vectors.py is a separate
// implementation of the method in Python (it shares the element parser and the T0 rule with
// tools/build-local-elements.py) that writes tests/local-vectors.json; tests/local.test.ts replays it.
//
// What the rule leaves out is on the page (the city note): hills, buildings, clouds, the height of
// the observer, the real refraction near the horizon, and the lunar limb profile. A city is one
// point (the catalogue's coordinate).

import { LUNAR_ELEMENTS, SOLAR_ELEMENTS } from './elements.js';
import type { LunarElements, SolarElements } from './elements.js';
import type { Eclipse } from './types.js';


/** A place: degrees, north and east positive; sea level. */
export interface Observer {
  readonly lat: number;
  readonly lon: number;
}

/** What the eclipse is like at the place, at its deepest while the body is up. */
export type LocalType = 'total' | 'annular' | 'partial' | 'penumbral';

export interface Local {
  readonly id: string;
  /** The deepest phase seen from the place. */
  readonly type: LocalType;
  /** Epoch milliseconds (UTC), exact: the first moment of the eclipse with the Sun or the Moon up. */
  readonly start: number;
  /** The last moment of the eclipse with the Sun or the Moon up. */
  readonly end: number;
  /** The moment of the deepest phase seen: greatest eclipse there, or the end of an up stretch nearest to it. */
  readonly max: number;
  /** The eclipse is already under way when the body rises: start is later than first contact. */
  readonly startsAtRise: boolean;
  /** The body sets before the eclipse ends: end is earlier than last contact. */
  readonly endsAtSet: boolean;
  /** The body sets and rises again between start and end (66 degrees of latitude or more): it is down for part of that time. */
  readonly gap: boolean;
  /** Solar only, at max: the fraction of the Sun's diameter covered (more than 1 for a total eclipse: the ratio of the discs). */
  readonly magnitude?: number;
  /** Solar only, at max: the fraction of the Sun's disc covered, 0 to 1. */
  readonly obscuration?: number;
  /** Lunar only, at max: the Moon's altitude in degrees (topocentric, no refraction). */
  readonly altitude?: number;
}

/** The Sun is up when its centre is above this geometric altitude: 34' of refraction and 16' of radius, as SunApp's sunrise. */
export const SUN_LIMIT_DEG = -0.833;
/** The refraction at the horizon, degrees. */
export const REFRACTION_DEG = 0.5667;

const HOUR = 3_600_000;
const STEP = 60_000;
const FINE = 1000;
const RAD = Math.PI / 180;
const FLATTENING = 0.99664719;

// ==== Finding the part of a window in which a body is up =======================================

/** A stretch of time in which a body is up: epoch milliseconds, both ends inside the stretch (to 1 s). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every stretch of [from, to] in which up(ms) is true, in order: sampled at the start of the
 * window, every 60 s and at the end, then each edge narrowed to 1 s by halving where up changes.
 * Empty when the body is never up at a sample. A pass shorter than a minute can be missed. More
 * than one stretch means the body sets and rises again inside the window (66 degrees of latitude
 * or more).
 */
function upSpans(up: (ms: number) => boolean, from: number, to: number): Span[] {
  const samples: number[] = [];
  for (let t = from; t < to; t += STEP) samples.push(t);
  samples.push(to);
  const flags = samples.map(up);
  const out: Span[] = [];
  let i = 0;
  while (i < samples.length) {
    if (!flags[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && flags[j + 1]) j += 1;
    let start = samples[i] ?? from;
    if (i > 0) {
      let lo = samples[i - 1] ?? from; // down
      let hi = start; // up
      while (hi - lo > FINE) {
        const mid = (lo + hi) / 2;
        if (up(mid)) hi = mid;
        else lo = mid;
      }
      start = hi;
    }
    let end = samples[j] ?? to;
    if (j < samples.length - 1) {
      let lo = end; // up
      let hi = samples[j + 1] ?? to; // down
      while (hi - lo > FINE) {
        const mid = (lo + hi) / 2;
        if (up(mid)) lo = mid;
        else hi = mid;
      }
      end = lo;
    }
    out.push({ start, end });
    i = j + 1;
  }
  return out;
}

/** The stretches of both lists as one list in order, stretches that overlap or lie within 1 s of each other joined. */
function mergeSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...a, ...b].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + FINE) out[out.length - 1] = { start: last.start, end: Math.max(last.end, s.end) };
    else out.push(s);
  }
  return out;
}

/**
 * What is seen of an eclipse: from the first moment with the body up to the last, whether the body
 * sets and rises again between them, and the moment of the deepest phase seen. That moment is
 * `deepest` when the body is up then, else the end of an up stretch that lies nearest to it. Null
 * when the body is never up.
 */
function seenOf(spans: readonly Span[], deepest: number): { start: number; end: number; gap: boolean; max: number } | null {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!first || !last) return null;
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

// ==== Solar ====================================================================================

type Cubic = readonly [number, number, number, number];
type Quad = readonly [number, number, number];

const cubic = (c: Cubic, t: number): number => c[0] + t * (c[1] + t * (c[2] + t * c[3]));
const cubicRate = (c: Cubic, t: number): number => c[1] + t * (2 * c[2] + t * 3 * c[3]);
const quad = (c: Quad, t: number): number => c[0] + t * (c[1] + t * c[2]);
const quadRate = (c: Quad, t: number): number => c[1] + t * 2 * c[2];

interface Place {
  readonly lat: number; // radians, geodetic
  readonly lon: number; // radians
  readonly rs: number; // rho sin(phi')
  readonly rc: number; // rho cos(phi')
}

function place(o: Observer): Place {
  const lat = o.lat * RAD;
  const u = Math.atan(FLATTENING * Math.tan(lat));
  return { lat, lon: o.lon * RAD, rs: FLATTENING * Math.sin(u), rc: Math.cos(u) };
}

interface Shadow {
  readonly u: number;
  readonly v: number;
  readonly a: number;
  readonly b: number;
  readonly n2: number;
  readonly m: number;
  readonly l1: number;
  readonly l2: number;
  /** The Sun's geometric altitude, degrees. */
  readonly alt: number;
}

/** The shadow axis, the penumbral and umbral radii and the Sun's altitude at the place, t hours after t0 (TD). */
function shadow(el: SolarElements, p: Place, t: number): Shadow {
  const x = cubic(el.x, t);
  const y = cubic(el.y, t);
  const d = quad(el.d, t) * RAD;
  const dd = quadRate(el.d, t) * RAD;
  const dmu = quadRate(el.mu, t) * RAD;
  // mu is the hour angle in ephemeris time; 0.00417807 degrees per second of Delta T turns it into UT.
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

/** The moment (hours from t0) of least distance between the place and the shadow axis. */
function solarMaximum(el: SolarElements, p: Place): number {
  let t = 0;
  for (let i = 0; i < 50; i += 1) {
    const s = shadow(el, p, t);
    const tau = (s.u * s.a + s.v * s.b) / s.n2;
    t -= tau;
    if (Math.abs(tau) < 1e-8) break;
  }
  return t;
}

/** A contact (hours from t0): the moment the place is at the edge of the cone of radius `which`. Null when it does not converge. */
function contact(el: SolarElements, p: Place, from: number, which: 'l1' | 'l2', sign: 1 | -1): number | null {
  let t = from;
  for (let i = 0; i < 50; i += 1) {
    const s = shadow(el, p, t);
    const n = Math.sqrt(s.n2);
    const radius = s[which];
    const k = (s.a * s.v - s.u * s.b) / (n * radius);
    if (!(Math.abs(k) <= 1)) return null;
    const tau = (s.u * s.a + s.v * s.b) / s.n2 - sign * Math.sqrt(1 - k * k) * radius / n;
    t -= tau;
    if (Math.abs(tau) < 1e-7) return t;
  }
  return null;
}

/** First, second, third and last contact and the maximum, epoch ms (UTC), for a transparent Earth; null when the shadow does not reach the place. */
export function solarContacts(el: SolarElements, o: Observer): { c1: number; c2?: number; c3?: number; c4: number; tmax: number } | null {
  const p = place(o);
  const base = Date.parse(el.t0) - el.dT * 1000;
  const ms = (t: number): number => base + t * HOUR;
  const tm = solarMaximum(el, p);
  const s = shadow(el, p, tm);
  if ((s.l1 - s.m) / (s.l1 + s.l2) <= 0) return null;
  const c1 = contact(el, p, tm, 'l1', -1);
  const c4 = contact(el, p, tm, 'l1', 1);
  if (c1 === null || c4 === null || c1 < -4 || c4 > 4) return null;
  const out: { c1: number; c2?: number; c3?: number; c4: number; tmax: number } = { c1: ms(c1), c4: ms(c4), tmax: ms(tm) };
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

/** The fraction of the Sun's disc the Moon covers: the overlap of two circles over the Sun's area. */
function obscurationOf(l1: number, l2: number, m: number): number {
  const rs = (l1 + l2) / 2;
  const rm = (l1 - l2) / 2;
  if (m >= rs + rm) return 0;
  if (m <= Math.abs(rm - rs)) return Math.min(1, (rm / rs) ** 2);
  const a1 = rs * rs * Math.acos((m * m + rs * rs - rm * rm) / (2 * m * rs));
  const a2 = rm * rm * Math.acos((m * m + rm * rm - rs * rs) / (2 * m * rm));
  const a3 = 0.5 * Math.sqrt((-m + rs + rm) * (m + rs - rm) * (m - rs + rm) * (m + rs + rm));
  return (a1 + a2 - a3) / (Math.PI * rs * rs);
}

/** A solar eclipse as seen from the place, or null when no part of it happens with the Sun up. */
export function solarLocal(el: SolarElements, o: Observer): Local | null {
  const c = solarContacts(el, o);
  if (!c) return null;
  const p = place(o);
  const base = Date.parse(el.t0) - el.dT * 1000;
  const at = (ms: number): number => (ms - base) / HOUR;
  const sunUp = (ms: number): boolean => shadow(el, p, at(ms)).alt > SUN_LIMIT_DEG;
  const seen = seenOf(upSpans(sunUp, c.c1, c.c4), c.tmax);
  if (!seen) return null;
  const { start, end, max } = seen;
  const s = shadow(el, p, at(max));
  const inTotality = c.c2 !== undefined && c.c3 !== undefined && max >= c.c2 && max <= c.c3;
  const magnitude = inTotality ? (s.l1 - s.l2) / (s.l1 + s.l2) : (s.l1 - s.m) / (s.l1 + s.l2);
  let type: LocalType = 'partial';
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

// ==== Lunar ====================================================================================

/** The Moon's topocentric altitude (degrees, no refraction), t hours after t0 (TD). */
function moonAltitude(el: LunarElements, p: Place, t: number): number {
  const ra = quad(el.ra, t);
  const dec = quad(el.dec, t) * RAD;
  const h = (15 * (el.gst + (t - el.dT / 3600) * 1.00273791) - ra) * RAD + p.lon;
  const geocentric = Math.asin(Math.sin(p.lat) * Math.sin(dec) + Math.cos(p.lat) * Math.cos(dec) * Math.cos(h));
  return (geocentric - Math.asin(Math.sin(el.hp * RAD) * Math.cos(geocentric))) / RAD;
}

/** A lunar eclipse as seen from the place, or null when the Moon is not up during the phase that counts. */
export function lunarLocal(el: LunarElements, o: Observer): Local | null {
  const p = place(o);
  const base = Date.parse(el.t0) - el.dT * 1000;
  const ms = (t: number): number => base + t * HOUR;
  const at = (x: number): number => (x - base) / HOUR;
  const [p1, u1, u2, greatest, u3, u4, p4] = el.c;
  const moonUp = (x: number): boolean => moonAltitude(el, p, at(x)) > -(REFRACTION_DEG + el.sd);
  const penumbral = u1 === null || u4 === null;
  // A partial or total eclipse counts when the Moon is up during the umbral phase, a penumbral one during the penumbral phase.
  const test = upSpans(moonUp, ms(penumbral ? p1 : (u1 ?? p1)), ms(penumbral ? p4 : (u4 ?? p4)));
  if (test.length === 0) return null;
  // The part seen is the penumbral window's; the test window lies inside it, so a stretch that the
  // 1 s halving trims at the very edge of the test window is joined to it (never an end before the test window's start).
  const seen = seenOf(mergeSpans(upSpans(moonUp, ms(p1), ms(p4)), test), ms(greatest));
  if (!seen) return null;
  const { start, end, max } = seen;
  let type: LocalType = 'penumbral';
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

/** The Sun's geometric altitude in degrees at a place and an instant (epoch ms), for a solar eclipse's element set. */
export function sunAltitude(el: SolarElements, o: Observer, epochMs: number): number {
  return shadow(el, place(o), (epochMs - (Date.parse(el.t0) - el.dT * 1000)) / HOUR).alt;
}

/** The Moon's topocentric altitude in degrees at a place and an instant (epoch ms), for a lunar eclipse's element set. */
export function moonAltitudeAt(el: LunarElements, o: Observer, epochMs: number): number {
  return moonAltitude(el, place(o), (epochMs - (Date.parse(el.t0) - el.dT * 1000)) / HOUR);
}

// ==== Every eclipse ==============================================================================

const SOLAR = new Map(SOLAR_ELEMENTS.map((el) => [el.id, el] as const));
const LUNAR = new Map(LUNAR_ELEMENTS.map((el) => [el.id, el] as const));

/** The eclipse as seen from the place, or null (not seen, or no element set for it). */
export function localFor(e: Pick<Eclipse, 'id' | 'kind'>, o: Observer): Local | null {
  if (e.kind === 'solar') {
    const el = SOLAR.get(e.id);
    return el ? solarLocal(el, o) : null;
  }
  const el = LUNAR.get(e.id);
  return el ? lunarLocal(el, o) : null;
}

/** Every eclipse that can be seen from the place, by id. About 30 of the 168 solar and 100 of the 169 lunar eclipses. */
export function localAll(o: Observer): Map<string, Local> {
  const out = new Map<string, Local>();
  for (const el of SOLAR_ELEMENTS) {
    const l = solarLocal(el, o);
    if (l) out.set(el.id, l);
  }
  for (const el of LUNAR_ELEMENTS) {
    const l = lunarLocal(el, o);
    if (l) out.set(el.id, l);
  }
  return out;
}
