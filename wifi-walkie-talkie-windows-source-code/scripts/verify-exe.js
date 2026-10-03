'use strict';
/**
 * scripts/verify-exe.js — Inspect a built Windows executable without running it.
 *
 * Checks the things that silently break a Windows release and cannot be seen by
 * launching the app on a Linux/macOS build machine:
 *
 *   1. the multi-resolution icon group is present in the PE resource section
 *      (Explorer, Start menu, Alt-Tab and the taskbar all pick a different
 *      entry from it),
 *   2. the version resource carries a real product name, description and version
 *      so "Properties" is not a blank page,
 *   3. the embedded manifest asks for `asInvoker`, so the app never demands
 *      administrator rights merely to open, and declares Windows 10/11 support.
 *
 * Usage:  node scripts/verify-exe.js <path-to.exe>
 */
const fs = require('fs');
const path = require('path');

const resedit = require('resedit');
const { NtExecutable, NtExecutableResource } = resedit;
const { IconGroupEntry, VersionInfo } = resedit.Resource;

/** PE resource type ids (winuser.h). */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
const RT_MANIFEST = 24;

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-exe.js <path-to.exe>');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/**
 * resedit hands back Node Buffers, but its parsers build a `DataView` over the
 * value, which requires a real ArrayBuffer. Normalise before parsing.
 */
function asArrayBuffer(entry) {
  const bin = entry.bin;
  if (bin instanceof ArrayBuffer) return bin;
  const view = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function main() {
  console.log(`\n=== PE resource check: ${path.basename(target)} ===`);
  console.log(`  file size: ${(fs.statSync(target).size / 1048576).toFixed(1)} MB\n`);

  const exe = NtExecutable.from(fs.readFileSync(target));
  const rsrc = NtExecutableResource.from(exe);
  const entries = rsrc.entries || [];

  // ------------------------------------------------------------------ icon
  const groupEntry = entries.find((e) => e.type === RT_GROUP_ICON);
  const iconEntries = entries.filter((e) => e.type === RT_ICON);

  if (groupEntry) {
    // IconGroupEntry takes a single entry and resolves its own icons from the
    // full resource-entry list, so every entry handed to it must be normalised.
    const normalised = entries.map((e) => ({ ...e, bin: asArrayBuffer(e) }));
    const group = new IconGroupEntry(normalised.find((e) => e.type === RT_GROUP_ICON));
    // In an icon group a stored dimension of 0 means 256 — there is no room for
    // the value 256 in a uint8. Reporting "0x0" would be technically correct and
    // practically useless.
    const sizes = group.icons.map((i) => `${i.width || 256}x${i.height || 256}`);
    check('icon group resource present', sizes.length > 0, sizes.join(', '));
    for (const want of [16, 32, 48, 256]) {
      check(`icon group contains a ${want}x${want} entry`, sizes.includes(`${want}x${want}`), sizes.join(', '));
    }
    check('icon group references every embedded icon', sizes.length === iconEntries.length,
      `${sizes.length} referenced / ${iconEntries.length} embedded`);
  } else {
    check('icon group resource present', false);
  }

  // --------------------------------------------------------------- version
  const verEntry = entries.find((e) => e.type === RT_VERSION);
  if (verEntry) {
    const info = new VersionInfo({ ...verEntry, bin: asArrayBuffer(verEntry) });
    // String values are keyed by {lang, codepage}; getDefaultVersionLang() may
    // hand back a bare language id, which would silently match nothing.
    const langs = info.getAllLanguagesForStringValues();
    const lang = langs[0] || { lang: 0x0409, codepage: 1200 };
    const get = (id) => {
      try {
        const v = info.getStringValues(lang)[id];
        return v === undefined || v === null ? '' : String(v);
      } catch (_e) {
        return '';
      }
    };
    check('version: product name', get('ProductName') === 'WiFi Walkie-Talkie', get('ProductName'));
    check('version: file description present', !!get('FileDescription'), get('FileDescription'));
    check('version: company name present', !!get('CompanyName'), get('CompanyName'));
    check('version: 1.0.0.x', /^1\.0\.0/.test(get('ProductVersion')), get('ProductVersion'));
    check('version: internal name is the shipped executable',
      get('InternalName') === 'wifi-walkie-talkie', get('InternalName'));
  } else {
    check('version resource present', false);
  }

  // -------------------------------------------------------------- manifest
  const manEntry = entries.find((e) => e.type === RT_MANIFEST);
  if (manEntry) {
    const manifest = Buffer.from(asArrayBuffer(manEntry)).toString('utf8');
    const level = /requestedExecutionLevel[^>]*Level\s*=\s*"([^"]+)"/i.exec(manifest);
    check(
      'manifest runs as a normal user (asInvoker)',
      !!level && level[1].toLowerCase() === 'asinvoker',
      level ? level[1] : 'no requestedExecutionLevel',
    );
    check(
      'manifest declares Windows 10/11 support',
      /supportedOS[^>]*Id\s*=\s*"\{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a\}"/i.test(manifest),
    );
  } else {
    check('manifest present', false);
  }

  console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error('verify-exe crashed:', e);
  process.exit(1);
}