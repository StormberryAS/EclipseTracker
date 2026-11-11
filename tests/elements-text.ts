// Reads one solar element set straight from the vendored NASA file (tools/nasa-elements/JSEX_SE2001.txt),
// so a test can use an eclipse that is not in the list (2026-08-12) and so the data path differs from
// ts/core/elements.ts. The file is read as text, never run. Not a test file itself.

import { readFileSync } from 'node:fs';
import type { SolarElements } from '#core/elements.js';

const TEXT = readFileSync(new URL('../tools/nasa-elements/JSEX_SE2001.txt', import.meta.url), 'ascii');
const J2000 = Date.UTC(2000, 0, 1, 12);

/** The element set of the solar eclipse of this date (month 1 to 12), parsed from the NASA file. */
export function solarFromText(year: number, month: number, day: number): SolarElements {
  const head = new RegExp(`^// ${year}\\s+${month}\\s+${day}\\s*$`, 'm').exec(TEXT);
  if (!head) throw new Error(`no element set for ${year}-${month}-${day}`);
  const body = TEXT.slice(head.index + head[0].length).split(/^\/\/ \d{4}/m)[0] ?? '';
  const n = body.replace(/\)\);[\s\S]*$/, '').split(',').map((t) => t.trim()).filter(Boolean).map(Number);
  if (n.length !== 28 || n.some((v) => Number.isNaN(v))) throw new Error(`${year}-${month}-${day}: ${n.length} numbers`);
  const [jd = 0, t0Hours = 0, , , dT = 0] = n;
  const td = J2000 + (jd - 2451545) * 86_400_000;
  let t0 = Date.UTC(year, month - 1, day) + t0Hours * 3_600_000;
  if (t0 - td > 12 * 3_600_000) t0 -= 86_400_000;
  if (td - t0 > 12 * 3_600_000) t0 += 86_400_000;
  const id = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-solar`;
  return {
    id, t0: new Date(t0).toISOString().replace(/:00\.000Z$/, ':00Z'), dT,
    x: [n[6] ?? 0, n[7] ?? 0, n[8] ?? 0, n[9] ?? 0], y: [n[10] ?? 0, n[11] ?? 0, n[12] ?? 0, n[13] ?? 0],
    d: [n[14] ?? 0, n[15] ?? 0, n[16] ?? 0], mu: [n[17] ?? 0, n[18] ?? 0, n[19] ?? 0],
    l1: [n[20] ?? 0, n[21] ?? 0, n[22] ?? 0], l2: [n[23] ?? 0, n[24] ?? 0, n[25] ?? 0], f1: n[26] ?? 0, f2: n[27] ?? 0,
  };
}
