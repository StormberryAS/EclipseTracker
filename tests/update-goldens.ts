// Rewrites tests/goldens/ from the current code. Run only after reading the diff of a deliberate
// change: node tests/update-goldens.ts
import { writeFileSync } from 'node:fs';
import { goldenIcs } from './golden-case.ts';

writeFileSync(new URL('./goldens/eclipse-2027-02-06-solar.ics', import.meta.url), goldenIcs());
console.log('wrote tests/goldens/eclipse-2027-02-06-solar.ics');
