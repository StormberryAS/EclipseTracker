import { isKnownZone } from './zoned.js?v=d3e47120';
export const MAX_CITY_ROWS = 8;
export function searchCities(cities, fold, typed) {
    const query = typed.trim().toLowerCase();
    if (query.length < 1)
        return [];
    const qf = fold(query);
    const startsWith = [];
    const contains = [];
    for (const c of cities) {
        if (c.fold.startsWith(qf) || c.alt.startsWith(qf))
            startsWith.push(c);
        else if (c.fold.includes(qf) || c.alt.includes(qf) || c.cfold.includes(qf))
            contains.push(c);
    }
    return startsWith.concat(contains).slice(0, MAX_CITY_ROWS);
}
export const STORED_CITY_VERSION = 1;
const KEYS = ['v', 'name', 'country', 'lat', 'lon', 'tz'];
export function storedCityText(c) {
    return JSON.stringify({ v: STORED_CITY_VERSION, name: c.name, country: c.country, lat: c.lat, lon: c.lon, tz: c.tz });
}
const textOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const inRange = (v, limit) => typeof v === 'number' && Number.isFinite(v) && v >= -limit && v <= limit;
export function parseStoredCity(text, options = {}) {
    if (text === null)
        return null;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const o = value;
    const keys = Object.keys(o);
    if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k)))
        return null;
    const { v, name, country, lat, lon, tz } = o;
    if (v !== STORED_CITY_VERSION || !textOk(name) || !textOk(country) || !inRange(lat, 90) || !inRange(lon, 180) || typeof tz !== 'string' || tz.length < 1 || tz.length > 200 || (options.anyZone !== true && !isKnownZone(tz)))
        return null;
    return { name, country, lat, lon, tz };
}
