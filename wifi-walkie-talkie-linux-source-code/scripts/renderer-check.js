'use strict';
/**
 * Static consistency check between the renderer controller and the markup.
 *
 * app.js resolves every element through $('someId'). A single typo there becomes a
 * runtime TypeError in the middle of an interaction (exactly the bug that made
 * push-to-talk always report "Microphone unavailable"). This verifies that every
 * id and class the controller touches actually exists in index.html, and that
 * CSS selectors used by the JS (via classList) exist in the stylesheet.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const audio = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'audio.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
);

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };

// 1. Every $('x') lookup must resolve to an id present in the markup.
const lookups = new Set();
for (const src of [js, audio]) {
  for (const m of src.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) lookups.add(m[1]);
}
console.log('Checking ' + lookups.size + " $('id') lookups against index.html...");
for (const id of [...lookups].sort()) {
  if (!htmlIds.has(id)) fail(`$('${id}') — no element with id="${id}" in index.html`);
}

// 2. classList.add/remove/toggle targets must be styled somewhere. They are applied
//    at runtime, so they legitimately may not appear in the static markup — but if the
//    stylesheet has no rule for them the state change is silently invisible.
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const classOps = new Set();
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) classOps.add(m[1]);
console.log('Checking ' + classOps.size + ' classList operations against styles.css...');
for (const cls of [...classOps].sort()) {
  if (!cssClasses.has(cls)) fail(`classList('${cls}') — styles.css defines no rule for .${cls}`);
  else if (!htmlClasses.has(cls)) console.log(`  OK    .${cls} (runtime-only class, styled)`);
  else console.log(`  OK    .${cls}`);
}

// 3. Renderer scripts are classic <script> tags, so they all share ONE global
//    lexical scope. Two top-level `const`/`let`/`class` with the same name in
//    different files is a fatal SyntaxError that kills the whole file at parse
//    time (the app silently does nothing). This has bitten us twice, so it is
//    checked explicitly.
console.log('Checking for duplicate top-level declarations across renderer scripts...');
const scripts = ['audio.js', 'app.js', 'pcm-tap.js'].filter((f) =>
  fs.existsSync(path.join(ROOT, 'src', 'renderer', f)));
const seenDecl = new Map();
for (const f of scripts) {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'renderer', f), 'utf8');
  // Only top-level declarations: start of line, no leading indentation.
  for (const m of text.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seenDecl.has(name)) {
      fail(`top-level '${name}' declared in both ${seenDecl.get(name)} and ${f} — duplicate lexical binding kills the page`);
    } else {
      seenDecl.set(name, f);
    }
  }
}
if (!failures) console.log(`  OK    ${seenDecl.size} unique top-level declarations`);

// 4. The AudioWorklet module referenced by audio.js must exist as a real file.
console.log('Checking AudioWorklet module is a real same-origin file...');
const wm = audio.match(/new URL\('([^']+)',\s*window\.location\.href\)/);
if (!wm) {
  fail('audio.js does not resolve its worklet module via new URL(...)');
} else {
  const target = path.join(ROOT, 'src', 'renderer', wm[1]);
  if (!fs.existsSync(target)) fail(`worklet module missing on disk: src/renderer/${wm[1]}`);
  else if (!/registerProcessor\(\s*'pcm-tap'/.test(fs.readFileSync(target, 'utf8'))) {
    fail(`worklet module does not registerProcessor('pcm-tap')`);
  } else {
    console.log(`  OK    src/renderer/${wm[1]} exists and registers 'pcm-tap'`);
  }
  // The CSP must permit a same-origin module load (and must not be the reason it fails).
  const csp = (html.match(/content="([^"]*default-src[^"]*)"/) || [])[1] || '';
  console.log(`  CSP   ${csp}`);
  if (/script-src[^;]*'none'/.test(csp)) fail('CSP forbids all scripts');
  if (!/script-src[^;]*'self'/.test(csp)) fail("CSP script-src does not include 'self' (same-origin modules blocked)");
}

// 5. Script/style tags referenced by the markup must exist on disk.
console.log('Checking markup references...');
for (const m of html.matchAll(/<(?:script[^>]*src|link[^>]*href)="([^"]+)"/g)) {
  const ref = m[1];
  const p = path.join(ROOT, 'src', 'renderer', ref);
  if (!fs.existsSync(p)) fail(`index.html references missing file: ${ref}`);
  else console.log(`  OK    ${ref}`);
}

console.log('');
console.log(failures === 0 ? 'RENDERER CHECKS PASSED' : `${failures} renderer check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);