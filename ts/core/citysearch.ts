// The city search and the remembered city, with no DOM and no browser global: the page passes the
// catalogue's rows and its fold function in. The catalogue (cities.js) is the shared Labs city
// catalogue written by SunApp's update_cities.py; this search is MoonApp's onCityInput, step for
// step, and tests/citysearch.test.ts replays MoonApp's 162 captured results against it.

import { isKnownZone } from './zoned.js';

/** One decoded catalogue row (the shape SunApp, MoonApp and the other Labs apps decode). */
export interface City {
  /** Display name, for example "Tromso". */
  readonly name: string;
  /** Name folded for search: accents stripped, lower case. */
  readonly fold: string;
  /** Country display name. */
  readonly country: string;
  /** Country name folded the same way as `fold`. */
  readonly cfold: string;
  /** Decimal degrees, north positive. */
  readonly lat: number;
  /** Decimal degrees, east positive. */
  readonly lon: number;
  /** IANA time zone identifier, for example "Europe/Oslo". */
  readonly tz: string;
  /** Folded English exonym where the catalogue stores the local name, otherwise "". */
  readonly alt: string;
}

/** The most rows the list shows. */
export const MAX_CITY_ROWS = 8;

/**
 * The cities for what the person typed: names that start with it first (the folded name or the
 * folded English exonym), then names or countries that contain it; at most MAX_CITY_ROWS.
 * Order matters for the captured results: trim and lower-case, test for empty, then fold. A lone
 * combining mark folds to "" and then matches the first rows of the catalogue.
 */
export function searchCities(cities: readonly City[], fold: (s: string) => string, typed: string): City[] {
  const query = typed.trim().toLowerCase();
  if (query.length < 1) return [];
  const qf = fold(query);
  const startsWith: City[] = [];
  const contains: City[] = [];
  for (const c of cities) {
    // c.alt is the folded English exonym where GeoNames stores the local name, so "gothenburg"
    // finds Goteborg and "cologne" finds Koeln.
    if (c.fold.startsWith(qf) || c.alt.startsWith(qf)) startsWith.push(c);
    else if (c.fold.includes(qf) || c.alt.includes(qf) || c.cfold.includes(qf)) contains.push(c);
  }
  return startsWith.concat(contains).slice(0, MAX_CITY_ROWS);
}

/** What is kept of a chosen city: enough to filter and to show times, with no catalogue needed. */
export interface StoredCity {
  readonly name: string;
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
}

/** The version of the kept record; MeteorWatch keeps the same record (key `meteorwatch.city`) with the same version. */
export const STORED_CITY_VERSION = 1;

const KEYS = ['v', 'name', 'country', 'lat', 'lon', 'tz'];

/** The kept text of a city: the six keys, in this order, the first being the version (`v: 1`), as MeteorWatch keeps it. */
export function storedCityText(c: StoredCity): string {
  return JSON.stringify({ v: STORED_CITY_VERSION, name: c.name, country: c.country, lat: c.lat, lon: c.lon, tz: c.tz });
}

/** 1 to 200 characters and no control character (U+0000 to U+001F, U+007F to U+009F): the text goes into a calendar file and an app's settings. */
const textOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const inRange = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -limit && v <= limit;

/**
 * The city in kept text, or null when the text is not exactly a city this version wrote: a JSON
 * object with exactly the six keys, `v` equal to 1, name and country of 1 to 200 characters with no
 * control character, a latitude from -90 to 90, a longitude from -180 to 180 and a time zone this runtime knows. Anything else is null.
 * With `anyZone` the zone need only be text of 1 to 200 characters: the page asks that to tell a
 * city it cannot use in this browser from text that is no city, and removes only the second.
 */
export function parseStoredCity(text: string | null, options: { readonly anyZone?: boolean } = {}): StoredCity | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  const { v, name, country, lat, lon, tz } = o;
  if (v !== STORED_CITY_VERSION || !textOk(name) || !textOk(country) || !inRange(lat, 90) || !inRange(lon, 180) || typeof tz !== 'string' || tz.length < 1 || tz.length > 200 || (options.anyZone !== true && !isKnownZone(tz))) return null;
  return { name, country, lat, lon, tz };
}
