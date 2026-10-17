// The eclipse list: which eclipse is next, which are still to come, filtering and grouping by
// year. Pure: "now" always comes in as an argument.

import { ECLIPSES } from './data.js';
import { greatestMinute } from './format.js';
import type { Eclipse, EclipseKind, EclipseType } from './types.js';

export { ECLIPSES };

const byId = new Map(ECLIPSES.map((e) => [e.id, e] as const));

/** The eclipse with this id, or undefined. */
export function eclipseById(id: string): Eclipse | undefined {
  return byId.get(id);
}

/** Epoch milliseconds of greatest eclipse. */
export function greatestMs(e: Pick<Eclipse, 'greatest'>): number {
  return Date.parse(e.greatest);
}

/**
 * Every eclipse whose greatest eclipse is still to come at `now`, in order. "Still to come" uses
 * greatest eclipse rounded to the minute, the time the page shows and counts down to, so the
 * countdown reaches zero at the minute shown and the eclipse leaves the list then (code review
 * C-20), not up to 30 seconds before or after.
 */
export function upcoming(now: number, list: readonly Eclipse[] = ECLIPSES): Eclipse[] {
  return list.filter((e) => greatestMinute(e) > now);
}

/** The next eclipse after `now` (by the rounded minute, as upcoming()), or undefined once the list has run out (after 2100). */
export function nextEclipse(now: number, list: readonly Eclipse[] = ECLIPSES): Eclipse | undefined {
  return list.find((e) => greatestMinute(e) > now);
}

/** What the list shows. kind 'all' or one kind; type 'all' or one type. */
export interface Filter {
  readonly kind: EclipseKind | 'all';
  readonly type: EclipseType | 'all';
}

export function matches(e: Eclipse, f: Filter): boolean {
  return (f.kind === 'all' || e.kind === f.kind) && (f.type === 'all' || e.type === f.type);
}

/** The types an eclipse of this kind can have. */
export function typesFor(kind: EclipseKind | 'all'): EclipseType[] {
  if (kind === 'solar') return ['total', 'annular', 'hybrid', 'partial'];
  if (kind === 'lunar') return ['total', 'partial', 'penumbral'];
  return ['total', 'annular', 'hybrid', 'partial', 'penumbral'];
}

/**
 * The eclipses grouped by year, years in order. yearOf gives an eclipse's year: the UTC year by
 * default; the page passes the year in the person's own time zone.
 */
export function groupByYear(
  list: readonly Eclipse[],
  yearOf: (e: Eclipse) => number = (e) => Number(e.greatest.slice(0, 4)),
): Array<{ year: number; eclipses: Eclipse[] }> {
  const out: Array<{ year: number; eclipses: Eclipse[] }> = [];
  for (const e of list) {
    const year = yearOf(e);
    const last = out[out.length - 1];
    if (last && last.year === year) last.eclipses.push(e);
    else out.push({ year, eclipses: [e] });
  }
  return out;
}
