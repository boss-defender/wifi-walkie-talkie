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
const ok = (msg) => console.log('  OK    ' + msg);

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
const scripts = ['icons.js', 'audio.js', 'app.js', 'pcm-tap.js'].filter((f) =>
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

// 4b. Ids must be unique. Duplicate ids are silent in HTML — the browser hands
//     both elements to document.getElementById — but every $('id') lookup in
//     app.js then resolves to only the FIRST match, so a control can be wired to
//     the wrong element or never wired at all.
console.log('Checking for duplicate element ids...');
const seenIds = new Map();
const dupes = [];
for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
  seenIds.set(m[1], (seenIds.get(m[1]) || 0) + 1);
}
for (const [id, count] of seenIds) {
  if (count > 1) dupes.push(`${id} (${count}x)`);
}
console.log(`  ${seenIds.size} unique id(s) in the markup`);
if (dupes.length) fail(`duplicate element id(s): ${dupes.join(', ')}`);
else ok('every element id is unique');

// 5. Script/style tags referenced by the markup must exist on disk, AND must be
//    listed in index.html before app.js runs (app.js executes immediately).
console.log('Checking markup references...');
const scriptRefs = [];
for (const m of html.matchAll(/<(?:script[^>]*src|link[^>]*href)="([^"]+)"/g)) {
  const ref = m[1];
  scriptRefs.push(ref);
  const p = path.join(ROOT, 'src', 'renderer', ref);
  if (!fs.existsSync(p)) fail(`index.html references missing file: ${ref}`);
  else console.log(`  OK    ${ref}`);
}
const appIndex = scriptRefs.indexOf('app.js');
const iconsIndex = scriptRefs.indexOf('icons.js');
if (iconsIndex >= 0 && appIndex >= 0 && iconsIndex > appIndex) {
  fail('icons.js loads after app.js — window.WalkieIcons would be undefined at boot');
}

// 6. Every <span data-icon="name"> and every iconSvg('name') must resolve to a
//    real entry in the icon set. A typo here renders an empty box, which is
//    exactly the class of defect the emoji icons were replaced to avoid.
console.log('Checking icon names against the icon set...');
const iconsPath = path.join(ROOT, 'src', 'renderer', 'icons.js');
if (!fs.existsSync(iconsPath)) {
  fail('src/renderer/icons.js is missing');
} else {
  const iconSrc = fs.readFileSync(iconsPath, 'utf8');
  // Parse the WT_ICON_PATHS literal specifically (from its declaration up to the
  // first top-level function) so the file-type map further down is not mistaken
  // for a set of icon definitions.
  const mapStart = iconSrc.indexOf('const WT_ICON_PATHS');
  const mapEnd = iconSrc.indexOf('\nfunction ', mapStart);
  if (mapStart < 0 || mapEnd < 0) fail('cannot locate WT_ICON_PATHS in icons.js');
  const iconBody = iconSrc.slice(mapStart, mapEnd);
  const available = new Set();
  for (const m of iconBody.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)) available.add(m[1]);

  /** Extract the balanced argument text of a call starting at `open`. */
function callArgs(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

const used = new Set();
for (const m of html.matchAll(/data-icon="([A-Za-z][A-Za-z0-9]*)"/g)) used.add(m[1]);

for (const m of js.matchAll(/\biconSvg\(/g)) {
  const args = callArgs(js, m.index + m[0].length - 1);
  // Drop everything after a `label:` option — that carries accessibility text,
  // not an icon name.
  const positional = args.split(/[{,]\s*(?:label|className)\s*:/)[0];
  for (const lit of positional.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(lit[1]);
}

for (const m of js.matchAll(/\bWalkieIcons\.set\(/g)) {
  const args = callArgs(js, m.index + m[0].length - 1);
  // The name is the second argument (host, name, filled).
  const second = args.indexOf(',') >= 0 ? args.slice(args.indexOf(',') + 1) : '';
  for (const lit of second.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(lit[1]);
}

  // The file-type -> icon map in icons.js must also resolve, otherwise an
  // attachment row can render with no icon at all.
  const fileMap = /const WT_FILE_ICONS = \{([\s\S]*?)\}/.exec(iconSrc);
  if (!fileMap) {
    fail('icons.js does not declare WT_FILE_ICONS');
  } else {
    for (const m of fileMap[1].matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(m[1]);
  }

  console.log(`  ${available.size} icon(s) defined, ${used.size} referenced`);
  for (const name of [...used].sort()) {
    if (!available.has(name)) fail(`icon "${name}" is used but not defined in icons.js`);
  }
  for (const name of [...available].sort()) {
    if (!used.has(name)) console.log(`  note  icon "${name}" is defined but unused`);
  }

  // 7. The icon set must not reintroduce emoji: they are the reason this file
  //    exists. Guard against a copy-paste bringing one back.
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
  if (emoji) fail(`index.html contains emoji characters: ${[...new Set(emoji)].join(' ')}`);
  const emojiJs = js.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
  if (emojiJs) fail(`app.js contains emoji characters: ${[...new Set(emojiJs)].join(' ')}`);
}

console.log('');
console.log(failures === 0 ? 'RENDERER CHECKS PASSED' : `${failures} renderer check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);