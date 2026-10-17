import { ECLIPSES } from './data.js?v=f0f28d45';
import { greatestMinute } from './format.js?v=be22d0d5';
export { ECLIPSES };
const byId = new Map(ECLIPSES.map((e) => [e.id, e]));
export function eclipseById(id) {
    return byId.get(id);
}
export function greatestMs(e) {
    return Date.parse(e.greatest);
}
export function upcoming(now, list = ECLIPSES) {
    return list.filter((e) => greatestMinute(e) > now);
}
export function nextEclipse(now, list = ECLIPSES) {
    return list.find((e) => greatestMinute(e) > now);
}
export function matches(e, f) {
    return (f.kind === 'all' || e.kind === f.kind) && (f.type === 'all' || e.type === f.type);
}
export function typesFor(kind) {
    if (kind === 'solar')
        return ['total', 'annular', 'hybrid', 'partial'];
    if (kind === 'lunar')
        return ['total', 'partial', 'penumbral'];
    return ['total', 'annular', 'hybrid', 'partial', 'penumbral'];
}
export function groupByYear(list, yearOf = (e) => Number(e.greatest.slice(0, 4))) {
    const out = [];
    for (const e of list) {
        const year = yearOf(e);
        const last = out[out.length - 1];
        if (last && last.year === year)
            last.eclipses.push(e);
        else
            out.push({ year, eclipses: [e] });
    }
    return out;
}
