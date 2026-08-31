/* Phosphor Icons, inlined.

   Icon geometry from @phosphor-icons/core 2.1.1 (bold weight), MIT licensed.
   Inlined rather than pulled from a CDN webfont or a sprite sheet for three
   reasons: no extra request on a page whose whole point is a live countdown, no
   icon-font flash before the glyphs arrive, and nothing new to allow in the CSP.
   All nine paths together are under 3KB.

   Icons inherit the surrounding text colour (fill="currentColor") and size
   (width/height in em), so one can be dropped anywhere a character used to sit.

   Usage:
     Icons.svg('eye')        -> markup string
     Icons.set(el, 'moon')   -> replaces el's contents
     Icons.hydrate(root)     -> fills every [data-icon] under root
   Markup:
     <span data-icon="eye"></span>   -> hydrated automatically on DOM ready
*/

const Icons = (() => {
  const PATHS = {
    'eye': 'M251,123.13c-.37-.81-9.13-20.26-28.48-39.61C196.63,57.67,164,44,128,44S59.37,57.67,33.51,83.52C14.16,102.87,5.4,122.32,5,123.13a12.08,12.08,0,0,0,0,9.75c.37.82,9.13,20.26,28.49,39.61C59.37,198.34,92,212,128,212s68.63-13.66,94.48-39.51c19.36-19.35,28.12-38.79,28.49-39.61A12.08,12.08,0,0,0,251,123.13Zm-46.06,33C183.47,177.27,157.59,188,128,188s-55.47-10.73-76.91-31.88A130.36,130.36,0,0,1,29.52,128,130.45,130.45,0,0,1,51.09,99.89C72.54,78.73,98.41,68,128,68s55.46,10.73,76.91,31.89A130.36,130.36,0,0,1,226.48,128,130.45,130.45,0,0,1,204.91,156.12ZM128,84a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,84Zm0,64a20,20,0,1,1,20-20A20,20,0,0,1,128,148Z',
    'sun': 'M116,36V20a12,12,0,0,1,24,0V36a12,12,0,0,1-24,0Zm80,92a68,68,0,1,1-68-68A68.07,68.07,0,0,1,196,128Zm-24,0a44,44,0,1,0-44,44A44.05,44.05,0,0,0,172,128ZM51.51,68.49a12,12,0,1,0,17-17l-12-12a12,12,0,0,0-17,17Zm0,119-12,12a12,12,0,0,0,17,17l12-12a12,12,0,1,0-17-17ZM196,72a12,12,0,0,0,8.49-3.51l12-12a12,12,0,0,0-17-17l-12,12A12,12,0,0,0,196,72Zm8.49,115.51a12,12,0,0,0-17,17l12,12a12,12,0,0,0,17-17ZM48,128a12,12,0,0,0-12-12H20a12,12,0,0,0,0,24H36A12,12,0,0,0,48,128Zm80,80a12,12,0,0,0-12,12v16a12,12,0,0,0,24,0V220A12,12,0,0,0,128,208Zm108-92H220a12,12,0,0,0,0,24h16a12,12,0,0,0,0-24Z',
    'moon': 'M236.37,139.4a12,12,0,0,0-12-3A84.07,84.07,0,0,1,119.6,31.59a12,12,0,0,0-15-15A108.86,108.86,0,0,0,49.69,55.07,108,108,0,0,0,136,228a107.09,107.09,0,0,0,64.93-21.69,108.86,108.86,0,0,0,38.44-54.94A12,12,0,0,0,236.37,139.4Zm-49.88,47.74A84,84,0,0,1,68.86,69.51,84.93,84.93,0,0,1,92.27,48.29Q92,52.13,92,56A108.12,108.12,0,0,0,200,164q3.87,0,7.71-.27A84.79,84.79,0,0,1,186.49,187.14Z',
    'smiley-x-eyes': 'M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm56.49-92.49a12,12,0,0,1-17,17L162,131l-5.51,5.52a12,12,0,0,1-17-17L145,114l-5.52-5.51a12,12,0,0,1,17-17L162,97l5.51-5.52a12,12,0,0,1,17,17L179,114Zm-68,17a12,12,0,0,1-17,0L94,131l-5.51,5.52a12,12,0,0,1-17-17L77,114l-5.52-5.51a12,12,0,0,1,17-17L94,97l5.51-5.52a12,12,0,0,1,17,17L111,114l5.52,5.51A12,12,0,0,1,116.49,136.49ZM144,180a16,16,0,1,1-16-16A16,16,0,0,1,144,180Z',
    'arrow-right': 'M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z',
    'arrow-left': 'M228,128a12,12,0,0,1-12,12H69l51.52,51.51a12,12,0,0,1-17,17l-72-72a12,12,0,0,1,0-17l72-72a12,12,0,0,1,17,17L69,116H216A12,12,0,0,1,228,128Z',
    'x': 'M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z',
    'clock-countdown': 'M236,137A108.13,108.13,0,1,1,119,20,12,12,0,0,1,121,44,84.12,84.12,0,1,0,212,135,12,12,0,1,1,236,137ZM116,76v52a12,12,0,0,0,12,12h52a12,12,0,0,0,0-24H140V76a12,12,0,0,0-24,0Zm92,20a16,16,0,1,0-16-16A16,16,0,0,0,208,96ZM176,64a16,16,0,1,0-16-16A16,16,0,0,0,176,64Z',
    'lock-simple': 'M208,76H180V56A52,52,0,0,0,76,56V76H48A20,20,0,0,0,28,96V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V96A20,20,0,0,0,208,76ZM100,56a28,28,0,0,1,56,0V76H100ZM204,204H52V100H204Z',
    'bell': 'M225.29,165.93C216.61,151,212,129.57,212,104a84,84,0,0,0-168,0c0,25.58-4.59,47-13.27,61.93A20.08,20.08,0,0,0,30.66,186,19.77,19.77,0,0,0,48,196H84.18a44,44,0,0,0,87.64,0H208a19.77,19.77,0,0,0,17.31-10A20.08,20.08,0,0,0,225.29,165.93ZM128,212a20,20,0,0,1-19.6-16h39.2A20,20,0,0,1,128,212ZM54.66,172C63.51,154,68,131.14,68,104a60,60,0,0,1,120,0c0,27.13,4.48,50,13.33,68Z',
    'bell-slash': 'M216.88,207.93l-160-176A12,12,0,1,0,39.12,48.07l14.8,16.29A83.58,83.58,0,0,0,44,104c0,25.58-4.59,47-13.27,61.93A20.08,20.08,0,0,0,30.68,186,19.75,19.75,0,0,0,48,196H84.19a44,44,0,0,0,87.62,0h1.79l25.52,28.07a12,12,0,0,0,17.76-16.14ZM68,104a59.84,59.84,0,0,1,3.52-20.29L151.78,172H54.68C63.52,154,68,131.14,68,104Zm60,108a20,20,0,0,1-19.6-16h39.2A20,20,0,0,1,128,212ZM88.89,42.35a12,12,0,0,1,6.37-15.73A84,84,0,0,1,212,104c0,18.68,2.38,34.93,7.07,48.28a12,12,0,1,1-22.64,8C190.83,144.32,188,125.4,188,104a60,60,0,0,0-83.38-55.28A12,12,0,0,1,88.89,42.35Z',
    'confetti': 'M114.32,49.8A19.79,19.79,0,0,0,81.72,57L29.22,201.41A19.82,19.82,0,0,0,47.75,228a20,20,0,0,0,6.84-1.22L199,174.28a19.79,19.79,0,0,0,7.24-32.6ZM104.19,183.21l-31.4-31.4L82.94,123.9l49.16,49.16Zm-52.42,26.4Zm12-32.91L79.3,192.26l-24.45,8.89ZM157,164,92,99l10-27.58L184.57,154ZM128,40V16a12,12,0,0,1,24,0V40a12,12,0,0,1-24,0Zm116.48,83.51a12,12,0,0,1-17,17l-16-16a12,12,0,0,1,17-17Zm-.69-40.13-24,8a12,12,0,0,1-7.59-22.77l24-8a12,12,0,1,1,7.59,22.77ZM156.6,65.93C159.83,47.47,173.39,36,192,36c6.45,0,8.69-2.49,10-4.92a18,18,0,0,0,2-7.22V24a12,12,0,0,1,24,0c0,14.47-9.59,36-36,36-4.94,0-10.21,1.19-11.76,10.06A12,12,0,0,1,168.43,80a12.35,12.35,0,0,1-2.08-.18A12,12,0,0,1,156.6,65.93Z',
    'check': 'M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z',
    // Shown only on a phase whose prediction came from the model, so a reader can
    // tell at a glance which numbers are the AI's and which are the counts'.
    'sparkle': 'M197.9,152.2l-38.6-14.5a12,12,0,0,1-7-7L137.8,92.1a10.5,10.5,0,0,0-19.6,0L103.7,130.7a12,12,0,0,1-7,7L58.1,152.2a10.5,10.5,0,0,0,0,19.6l38.6,14.5a12,12,0,0,1,7,7l14.5,38.6a10.5,10.5,0,0,0,19.6,0l14.5-38.6a12,12,0,0,1,7-7l38.6-14.5A10.5,10.5,0,0,0,197.9,152.2ZM128,203.4l-9.2-24.5a35.9,35.9,0,0,0-21.1-21.1L73.2,148.6l24.5-9.2a35.9,35.9,0,0,0,21.1-21.1l9.2-24.5,9.2,24.5a35.9,35.9,0,0,0,21.1,21.1l24.5,9.2-24.5,9.2a35.9,35.9,0,0,0-21.1,21.1ZM172,60h16V76a12,12,0,0,0,24,0V60h16a12,12,0,0,0,0-24H212V20a12,12,0,0,0-24,0V36H172a12,12,0,0,0,0,24Z',
    'caret-down': 'M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z',
  };

  // Utilities, not a class of our own: this app has no stylesheet of class
  // selectors left, only Tailwind. Rendered at 1em so an icon takes the size and
  // colour of whatever it sits in; the negative baseline shift is what stops it
  // riding high next to text.
  const ICON_CLASS = 'inline-block shrink-0 align-[-0.14em]';

  // Rendered at 1em so an icon sits on the text baseline at whatever size its
  // container already uses — no per-icon sizing rules to keep in sync.
  function svg(name, opts = {}) {
    const d = PATHS[name];
    if (!d) {
      console.warn('[icons] unknown icon', name);
      return '';
    }
    const size = opts.size || '1em';
    const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : 'aria-hidden="true"';
    return `<svg class="${ICON_CLASS}" viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" ${a11y} focusable="false"><path d="${d}"/></svg>`;
  }

  function set(el, name, opts) {
    if (!el) return;
    el.innerHTML = svg(name, opts);
    // Record what it now holds, so a later hydrate() — which runs on DOM ready,
    // possibly after a script has already swapped an icon for a stateful one —
    // re-renders the current icon instead of reverting to the markup's original.
    if (el.dataset) el.dataset.icon = name;
  }

  // data-icon is the declarative form: the markup stays readable and no page
  // has to carry hundreds of characters of path data inline.
  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      set(el, el.dataset.icon, el.dataset.iconLabel ? { label: el.dataset.iconLabel } : undefined);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();

  return { PATHS, svg, set, hydrate, names: Object.keys(PATHS) };
})();
