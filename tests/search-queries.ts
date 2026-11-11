// The city search queries behind tests/search-vectors.json: plain and accented names, English
// exonyms, country-only matches, prefix against substring ordering, case and spaces, one letter,
// HTML, no match, punctuation and a query that folds to nothing. MoonApp's tests/capture-search.ts
// ran them against the MoonApp 90d11dd page (the last hand-written app.js) and froze the results.
// Copied byte for byte from MoonApp on 11 November 2026, with only this comment changed, for the
// city filter: tests/citysearch.test.ts replays them against core/citysearch.js. Not a test file itself.

const ch = (...codes: number[]): string => String.fromCharCode(...codes);

export const SEARCH_QUERIES: readonly string[] = [
  // Plain names, Norway first.
  'bergen', 'oslo', 'tromso', 'askoy', 'kleppesto', 'stavanger', 'trondheim', 'bodo', 'alesund',
  'kristiansand', 'drammen', 'alta', 'kirkenes', 'hammerfest', 'narvik', 'harstad', 'longyearbyen',
  'voss', 'odda', 'molde',
  // Plain names elsewhere.
  'herat', 'reykjavik', 'nuuk', 'murmansk', 'anchorage', 'singapore', 'sydney', 'ushuaia', 'apia',
  'kiritimati', 'honolulu', 'london', 'paris', 'madrid', 'lisbon', 'porto', 'dublin', 'edinburgh',
  'stockholm', 'helsinki', 'tallinn', 'riga', 'berlin', 'hamburg', 'zurich', 'geneva', 'amsterdam',
  'cairo', 'lagos', 'nairobi', 'tokyo', 'delhi', 'mumbai', 'karachi', 'santiago', 'sao paulo',
  'rio', 'bogota', 'lima', 'mexico', 'los angeles', 'new york', 'toronto', 'montreal', 'quebec',
  // Accented as typed.
  `troms${ch(0xF8)}`, `ask${ch(0xF8)}y`, `her${ch(0x101)}t`, `${ch(0xC5)}lesund`, `bod${ch(0xF8)}`,
  `s${ch(0xE3)}o paulo`, `z${ch(0xFC)}rich`, `krak${ch(0xF3)}w`, `malm${ch(0xF6)}`, `reykjav${ch(0xED)}k`,
  `bras${ch(0xED)}lia`, `montr${ch(0xE9)}al`, `c${ch(0xF3)}rdoba`, `d${ch(0xFC)}sseldorf`, `${ch(0xF8)}rsta`,
  // English exonyms and local names.
  'gothenburg', 'goteborg', 'cologne', 'koln', 'munich', 'munchen', 'copenhagen', 'warsaw', 'prague',
  'vienna', 'florence', 'venice', 'naples', 'moscow', 'kiev', 'kyiv', 'bucharest', 'belgrade',
  // Country only, or mostly.
  'norway', 'brazil', 'sweden', 'iceland', 'greenland', 'japan', 'chile', 'samoa', 'fiji', 'kiribati',
  'usa', 'uk', 'svalbard',
  // Prefix against substring ordering, and short fragments.
  'erdal', 'san', 'new', 'port', 'saint', 'st', 'el', 'al', 'la', 'de', 'ber', 'osl', 'ham', 'burg',
  'ville', 'ford', 'sk', 'by',
  // Case and spaces.
  'BERGEN', '  bergen  ', 'Bergen', 'bErGeN', ' new york', 'new  york', 'NEW YORK',
  // One letter.
  'a', 'b', 'z', ch(0xF8), ch(0xE9),
  // HTML and quotes.
  '&', '<b>', '"', "'", '<script>', '&amp;',
  // No match.
  'zz', 'qqq', 'xyzzy', '12345', '?', 'the very long name that matches nothing at all',
  // Punctuation.
  "st. john's", "o'", '-', '.', ',', 'washington, dc',
  // A combining mark alone folds to nothing (the documented divergence from the Android search).
  ch(0x301), ch(0x308),
  // Digits.
  '1',
];
