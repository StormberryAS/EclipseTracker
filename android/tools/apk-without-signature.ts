// The SHA-256 of an APK with its APK Signing Block taken out, for comparing a release with your own
// build of the same tag (README.md, "Reproducible build"). Two APKs built from the same commit and
// signed with different keys differ only in that block (and in the one offset of the end-of-central-
// directory record that says where the central directory starts), so with the block removed they are
// byte for byte equal. An unsigned APK gives the sha256 of the file itself.
//
//   node android/tools/apk-without-signature.ts <file.apk> [...]
//
// TypeScript, run by Node 24 directly (erasable syntax only), type-checked with tests/tsconfig.json;
// the same algorithm as CheckLink's android/tools/apk-without-signature.py (17 October 2026).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

const EOCD = 0x06054b50;
const MAGIC = 'APK Sig Block 42';

/** The APK's bytes with the APK Signing Block removed and the central directory offset moved back. */
export function withoutSignature(apk: Uint8Array): Uint8Array {
  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  let at = -1;
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error('not a zip: no end-of-central-directory record');
  const cdSize = view.getUint32(at + 12, true);
  const cdOff = view.getUint32(at + 16, true);
  if (cdOff + cdSize !== at) throw new Error('unexpected zip layout: the central directory does not end at the record');
  if (cdOff < 32 || new TextDecoder('latin1').decode(apk.subarray(cdOff - 16, cdOff)) !== MAGIC) return apk;
  const size = view.getBigUint64(cdOff - 24, true);
  const start = cdOff - Number(size) - 8;
  if (start < 0 || view.getBigUint64(start, true) !== size) throw new Error('the two sizes of the signing block disagree');
  const out = new Uint8Array(apk.length - (cdOff - start));
  out.set(apk.subarray(0, start), 0);
  out.set(apk.subarray(cdOff), start);
  new DataView(out.buffer).setUint32(start + cdSize + 16, start, true);
  return out;
}

/** The lowercase hex SHA-256 of the APK without its signing block. */
export function strippedSha256(apk: Uint8Array): string {
  return createHash('sha256').update(withoutSignature(apk)).digest('hex');
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  const files = argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node android/tools/apk-without-signature.ts <file.apk> [...]');
    process.exitCode = 2;
  }
  for (const f of files) console.log(`${strippedSha256(readFileSync(f))}  ${f}`);
}
