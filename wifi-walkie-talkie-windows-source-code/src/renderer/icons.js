'use strict';
/**
 * icons.js — Inline SVG icon set.
 *
 * Why not emoji
 * -------------
 * The UI previously used emoji characters (📻 📞 ⚙ …) as icons. That looks fine
 * on a developer machine and falls apart everywhere else:
 *
 *   - the glyph comes from whichever emoji font the OS happens to pick, so the
 *     same build renders a phone on one machine and a hollow rectangle on the
 *     next (this is visible immediately under Wine, which has no Segoe UI Emoji),
 *   - metrics are not controllable, so icons sit at different optical sizes and
 *     never line up with the text baseline,
 *   - Windows substitutes a monochrome fallback for a whole family of emoji on
 *     machines where the colour font is missing or disabled, and the result is a
 *     grey vertical bar,
 *   - they cannot inherit `currentColor`, so hover/disabled states are
 *     impossible to express.
 *
 * Inline SVG fixes all of that: identical on every Windows version and UI
 * language, colour follows the surrounding text, and each icon scales crisply at
 * any DPI.
 *
 * Every icon is drawn on a 24x24 grid with a 1.8 stroke, round caps and round
 * joins, so the family reads as one consistent set.
 */

const WT_ICON_PATHS = {
  /* --- navigation ------------------------------------------------------- */
  radio:
    '<path d="M13.6 7.2V3.4"/><path d="M12.1 3.4h3"/>' +
    '<rect x="7" y="7.2" width="10" height="13.8" rx="2.6"/>' +
    '<rect x="9.1" y="9.6" width="5.8" height="3.4" rx="1"/>' +
    '<path d="M9.7 15.8h4.6"/><path d="M9.7 18.2h4.6"/>',
  broadcast:
    '<circle cx="12" cy="18.2" r="1.5" fill="currentColor" stroke="none"/>' +
    '<path d="M8.4 14.6a5.2 5.2 0 0 1 7.2 0"/>' +
    '<path d="M5.4 11.6a9.4 9.4 0 0 1 13.2 0"/>' +
    '<path d="M2.4 8.6a13.6 13.6 0 0 1 19.2 0"/>',
  chat:
    '<path d="M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 8.7 8.7 0 0 1-3.6-.8L3.5 20.5l1.8-4.4a7.7 7.7 0 0 1-.9-3.6 7.9 7.9 0 0 1 8-7.8 7.9 7.9 0 0 1 8.1 7.9z"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12.22 2.2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.73v.51a2 2 0 0 1-1 1.73l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73v.18a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.73v-.51a2 2 0 0 1 1-1.73l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73v-.18a2 2 0 0 0-2-2z"/>',

  /* --- actions ---------------------------------------------------------- */
  send: '<path d="M21 3.6 10.6 14"/><path d="M21 3.6 14.4 21l-3.8-7-7-3.8z"/>',
  attach:
    '<path d="M20.4 11.6 12 20a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/>',
  trash:
    '<path d="M3.6 6.4h16.8"/><path d="M8.4 6.4V4.9a1.3 1.3 0 0 1 1.3-1.3h4.6a1.3 1.3 0 0 1 1.3 1.3v1.5"/>' +
    '<path d="M18.2 6.4v13.1a1.5 1.5 0 0 1-1.5 1.5H7.3a1.5 1.5 0 0 1-1.5-1.5V6.4"/>' +
    '<path d="M10.2 11v5.4"/><path d="M13.8 11v5.4"/>',
  refresh:
    '<path d="M20.6 12a8.6 8.6 0 1 1-2.6-6.1"/><path d="M20.8 4.3v4.9h-4.9"/>',

  /* --- calls ------------------------------------------------------------ */
  phone:
    '<path d="M20.6 16.9v2.6a1.7 1.7 0 0 1-1.9 1.7 17 17 0 0 1-7.4-2.6 16.7 16.7 0 0 1-5.1-5.1A17 17 0 0 1 3.6 6a1.7 1.7 0 0 1 1.7-1.9h2.6a1.7 1.7 0 0 1 1.7 1.5 11 11 0 0 0 .6 2.6 1.7 1.7 0 0 1-.4 1.8l-1.1 1.1a14 14 0 0 0 5.1 5.1l1.1-1.1a1.7 1.7 0 0 1 1.8-.4 11 11 0 0 0 2.6.6 1.7 1.7 0 0 1 1.5 1.6z"/>',
  phoneOff:
    '<path d="M10.7 5.1c.5-.1 1-.1 1.5-.1a15.6 15.6 0 0 1 6.8 1.5 1.7 1.7 0 0 1 1 1.5v2.6a1.7 1.7 0 0 1-1.9 1.7c-.9-.1-1.8-.3-2.6-.6a1.7 1.7 0 0 1-.9-1.6v-1.1"/>' +
    '<path d="M6.5 6.9v-1a1.7 1.7 0 0 1 1.7-1.6c.9.1 1.7.3 2.5.6a1.7 1.7 0 0 1 .9 1.6v1"/>' +
    '<path d="M14.6 14.6a14 14 0 0 1-3.6 3.9l-1.1-1.1a1.7 1.7 0 0 0-1.8-.4c-.8.3-1.7.5-2.6.6a1.7 1.7 0 0 1-1.9-1.7v-2.6a1.7 1.7 0 0 1 1.5-1.7c.4 0 .9-.1 1.3-.2"/>' +
    '<path d="M2.6 2.6 21.4 21.4"/>',
  video:
    '<path d="M22.2 8.3 16.6 12l5.6 3.7a.6.6 0 0 0 .9-.5V8.8a.6.6 0 0 0-.9-.5z"/>' +
    '<rect x="1.6" y="5.6" width="15" height="12.8" rx="2.4"/>',
  camera:
    '<path d="M22.2 18.6a2 2 0 0 1-2 2H3.8a2 2 0 0 1-2-2V8.4a2 2 0 0 1 2-2h3.1l1.6-2.4a1 1 0 0 1 .9-.5h4.3a1 1 0 0 1 .9.5l1.6 2.4h3.1a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="3.8"/>',
  mic:
    '<rect x="9" y="2.2" width="6" height="11.4" rx="3"/>' +
    '<path d="M19 10.6v1.6a7 7 0 0 1-14 0v-1.6"/>' +
    '<path d="M12 19.2v2.6"/>',
  micOff:
    '<path d="M9 5.2A3 3 0 0 1 15 5.2v4.4"/>' +
    '<path d="M15 12.6a3 3 0 0 1-5.2 2"/>' +
    '<path d="M19 10.6v1.6a7 7 0 0 1-10.4 6.1"/><path d="M5 10.6v1.6a7 7 0 0 0 2.4 5.3"/>' +
    '<path d="M12 19.2v2.6"/><path d="M2.6 2.6 21.4 21.4"/>',
  phoneIncoming:
    '<path d="M20.6 16.9v2.6a1.7 1.7 0 0 1-1.9 1.7 17 17 0 0 1-7.4-2.6 16.7 16.7 0 0 1-5.1-5.1A17 17 0 0 1 3.6 6a1.7 1.7 0 0 1 1.7-1.9h2.6a1.7 1.7 0 0 1 1.7 1.5 11 11 0 0 0 .6 2.6 1.7 1.7 0 0 1-.4 1.8l-1.1 1.1a14 14 0 0 0 5.1 5.1l1.1-1.1a1.7 1.7 0 0 1 1.8-.4 11 11 0 0 0 2.6.6 1.7 1.7 0 0 1 1.5 1.6z"/>' +
    '<path d="M14.6 2.6 20 8"/><path d="M20 3.4V8h-4.6"/>',

  /* --- messages --------------------------------------------------------- */
  file:
    '<path d="M14.4 2.6H6.6a2 2 0 0 0-2 2v14.8a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2V7.6z"/>' +
    '<path d="M14.2 2.6v5h5.2"/>',
  image:
    '<rect x="2.6" y="3.6" width="18.8" height="16.8" rx="2.4"/>' +
    '<circle cx="8.4" cy="9.2" r="1.8"/>' +
    '<path d="M21.4 15.6 16 10.2 5.2 21"/>',
  film:
    '<rect x="2.6" y="3.6" width="18.8" height="16.8" rx="2.4"/>' +
    '<path d="M7.4 3.6v16.8"/><path d="M16.6 3.6v16.8"/>' +
    '<path d="M2.6 12h18.8"/><path d="M2.6 7.8h4.8"/><path d="M2.6 16.2h4.8"/>' +
    '<path d="M16.6 7.8h4.8"/><path d="M16.6 16.2h4.8"/>',
  audio:
    '<path d="M9.2 17.6V5.2l10-2v12.4"/>' +
    '<circle cx="6.2" cy="17.6" r="2.8"/><circle cx="16.2" cy="15.6" r="2.8"/>',
  star:
    '<path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.6l6.5-.9z"/>',

  /* --- status --------------------------------------------------------- */
  check: '<path d="M20 6.4 9.4 17 4 11.6"/>',
  checkDouble: '<path d="M2 12.6 6.4 17 15 8.4"/><path d="m10.6 15.4 1.4 1.4 8.2-8.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2"/>',
  cross: '<path d="M18.4 5.6 5.6 18.4"/><path d="m5.6 5.6 12.8 12.8"/>',
  shield:
    '<path d="M12 22s8-3.6 8-9.6V5.4l-8-3-8 3V12.4c0 6 8 9.6 8 9.6z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  users:
    '<path d="M16.4 20.8v-1.9a4 4 0 0 0-4-4H6.2a4 4 0 0 0-4 4v1.9"/>' +
    '<circle cx="9.3" cy="7.4" r="3.7"/>' +
    '<path d="M21.8 20.8v-1.9a4 4 0 0 0-3-3.8"/>' +
    '<path d="M15.6 3.8a4 4 0 0 1 0 7.4"/>',
  folder:
    '<path d="M21.6 19.4a2 2 0 0 1-2 2H4.4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.8l2.4 3.2h7.6a2 2 0 0 1 2 2z"/>',
  alert:
    '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
    '<path d="M12 9v4.4"/><path d="M12 17.2h.01"/>',
};

/**
 * Build an inline SVG icon.
 *
 * @param {string} name        key in WT_ICON_PATHS
 * @param {object} [options]
 * @param {string} [options.className]  extra classes on the <svg>
 * @param {number} [options.size]       pixel size (CSS also controls this)
 * @param {boolean} [options.filled]    fill the shape instead of stroking it
 * @param {string} [options.label]      accessible name; omit for decorative use
 */
function wtIconSvg(name, options) {
  const opts = options || {};
  const paths = WT_ICON_PATHS[name];
  if (!paths) return '';

  const classes = ['ico'];
  if (opts.className) classes.push(opts.className);
  const size = opts.size ? ` style="width:${opts.size}px;height:${opts.size}px"` : '';
  const paint = opts.filled
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const a11y = opts.label
    ? ` role="img" aria-label="${String(opts.label).replace(/"/g, '&quot;')}"`
    : ' aria-hidden="true"';

  return `<svg class="${classes.join(' ')}" viewBox="0 0 24 24"${size} ${paint}${a11y}>` +
    `${paths}</svg>`;
}

/**
 * Replace every `<span data-icon="name">` inside `root` with its SVG.
 *
 * Declarative markup stays readable in index.html while the icon set itself
 * lives in one reviewable place. Safe to call repeatedly.
 */
function wtHydrateIcons(root) {
  const scope = root || document;
  for (const host of scope.querySelectorAll('[data-icon]')) {
    const name = host.getAttribute('data-icon');
    const filled = host.getAttribute('data-icon-filled') === 'true';
    const label = host.getAttribute('data-icon-label');
    const svg = wtIconSvg(name, { filled, label: label || undefined });
    if (svg) host.innerHTML = svg;
  }
}

/** Swap the SVG inside an already-hydrated host (used for starred toggling). */
function wtSetIcon(host, name, filled) {
  if (!host) return;
  const svg = wtIconSvg(name, { filled });
  if (svg) host.innerHTML = svg;
}

/**
 * File-type -> icon name.
 *
 * Kept next to the icon set (rather than inline in app.js) so the mapping can be
 * validated against the available icons automatically, instead of a typo in a
 * ternary producing an empty attachment row.
 */
const WT_FILE_ICONS = {
  IMAGE: 'image',
  VIDEO: 'film',
  VOICE_NOTE: 'audio',
  FILE: 'file',
};

/** Icon for a stored message type; falls back to the generic file icon. */
function wtFileIcon(type) {
  return WT_FILE_ICONS[type] || WT_FILE_ICONS.FILE;
}

window.WalkieIcons = {
  paths: WT_ICON_PATHS,
  fileIcons: WT_FILE_ICONS,
  svg: wtIconSvg,
  file: wtFileIcon,
  hydrate: wtHydrateIcons,
  set: wtSetIcon,
};