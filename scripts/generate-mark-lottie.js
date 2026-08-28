/**
 * Generates public/check.lottie.json and public/cross.lottie.json — the marks
 * that play inside the outcome modals: a tick for a hit, a cross for a miss.
 * The celebration itself happens across the whole page (see
 * generate-page-confetti-lottie.js); these are the verdict, stated once, in the
 * middle of the modal.
 *
 *   npm run build:marks
 *
 * Both draw themselves on with a trim path — a ring sweeps closed, then the mark
 * strokes in behind it — and then hold. They are the one place in this app where
 * an animation should NOT loop: a tick that keeps re-drawing reads as a spinner.
 *
 * Every keyframe carries linear bezier handles. This is not decoration: a
 * keyframe without `i`/`o` makes lottie evaluate the property to NaN and drop
 * the layer silently, which is exactly how an earlier round of these files
 * shipped animating nothing at all.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public');

const W = 240;
const H = 240;
const FPS = 60;
const DURATION_F = 78; // 1.3s, then hold

// Baked rather than tokenised: a lottie cannot read CSS custom properties, so
// these are picked to read against both --ink-900 surfaces (white paper and
// dark green).
const GREEN = [0.31, 0.72, 0.42];
const RED = [0.88, 0.33, 0.24];

const LINEAR_OUT = { x: [0], y: [0] };
const LINEAR_IN = { x: [1], y: [1] };
const eased = (keys) => keys.map((k, i, all) => (
  i === all.length - 1 ? k : { ...k, o: LINEAR_OUT, i: LINEAR_IN }
));

const transform = (extra = {}) => ({
  ty: 'tr',
  p: { a: 0, k: [0, 0], ix: 2 }, a: { a: 0, k: [0, 0], ix: 1 },
  s: { a: 0, k: [100, 100], ix: 3 }, r: { a: 0, k: 0, ix: 6 },
  o: { a: 0, k: 100, ix: 7 }, sk: { a: 0, k: 0, ix: 4 }, sa: { a: 0, k: 0, ix: 5 },
  nm: 'Transform', ...extra,
});

const stroke = (colour, width) => ({
  ty: 'st',
  c: { a: 0, k: [colour[0], colour[1], colour[2], 1], ix: 3 },
  o: { a: 0, k: 100, ix: 4 },
  w: { a: 0, k: width, ix: 5 },
  lc: 2, // round caps, so the mark has soft ends
  lj: 2, // round joins
  bm: 0, nm: 'Stroke', hd: false,
});

/**
 * Trim path: animating `e` from 0 to 100 draws the stroke on.
 *
 * Order inside the group matters and is easy to get wrong — the trim has to come
 * AFTER the path it modifies and BEFORE the stroke that renders it. Verified in
 * a real browser, not assumed.
 */
const trim = (fromF, toF) => ({
  ty: 'tm',
  s: { a: 0, k: 0, ix: 1 },
  e: { a: 1, ix: 2, k: eased([
    { t: fromF, s: [0] },
    { t: toF, s: [100] },
  ]) },
  o: { a: 0, k: 0, ix: 3 },
  m: 1, ix: 2, nm: 'Trim', hd: false,
});

/** An open polyline, straight segments (no tangents). */
const polyline = (points) => ({
  ty: 'sh', ix: 1, nm: 'Path', hd: false,
  ks: { a: 0, ix: 2, k: {
    c: false,
    v: points,
    i: points.map(() => [0, 0]),
    o: points.map(() => [0, 0]),
  } },
});

/** A circle as a closed 4-point bezier, so a trim path can sweep it. */
function circlePath(r) {
  const k = r * 0.5523;
  return {
    ty: 'sh', ix: 1, nm: 'Ring', hd: false,
    ks: { a: 0, ix: 2, k: {
      c: true,
      v: [[0, -r], [r, 0], [0, r], [-r, 0]],
      i: [[-k, 0], [0, -k], [k, 0], [0, k]],
      o: [[k, 0], [0, k], [-k, 0], [0, -k]],
    } },
  };
}

function layer(ind, name, shapes, ks) {
  return {
    ddd: 0, ind, ty: 4, nm: name, sr: 1,
    ks: {
      o: ks.o || { a: 0, k: 100, ix: 11 },
      r: ks.r || { a: 0, k: 0, ix: 10 },
      p: ks.p || { a: 0, k: [W / 2, H / 2, 0], ix: 2 },
      a: { a: 0, k: [0, 0, 0], ix: 1 },
      s: ks.s || { a: 0, k: [100, 100, 100], ix: 6 },
    },
    ao: 0, shapes, ip: 0, op: DURATION_F, st: 0, bm: 0,
  };
}

function build(kind) {
  const colour = kind === 'check' ? GREEN : RED;
  const layers = [];

  // 1. the ring sweeps closed first
  layers.push(layer(1, 'ring', [{
    ty: 'gr', nm: 'RingGroup', bm: 0, hd: false,
    it: [circlePath(86), trim(0, 34), stroke(colour, 12), transform()],
  }], {
    // starts a quarter turn back so the sweep begins at the top
    r: { a: 0, k: -90, ix: 10 },
  }));

  // 2. then the mark strokes in behind it
  const marks = kind === 'check'
    ? [polyline([[-40, 4], [-12, 32], [44, -30]])]
    : [polyline([[-34, -34], [34, 34]]), polyline([[34, -34], [-34, 34]])];

  marks.forEach((mark, i) => {
    const from = 30 + i * 12;
    layers.push(layer(2 + i, `mark-${i + 1}`, [{
      ty: 'gr', nm: 'MarkGroup', bm: 0, hd: false,
      it: [mark, trim(from, from + 26), stroke(colour, 16), transform()],
    }], {}));
  });

  // 3. a soft pop on the whole thing as the mark lands
  const popAt = kind === 'check' ? 56 : 68;
  layers.forEach((l) => {
    l.ks.s = { a: 1, ix: 6, k: eased([
      { t: 0, s: [88, 88, 100] },
      { t: 20, s: [100, 100, 100] },
      { t: popAt, s: [100, 100, 100] },
      { t: popAt + 8, s: [107, 107, 100] },
      { t: DURATION_F, s: [100, 100, 100] },
    ]) };
  });

  return {
    v: '5.13.0', fr: FPS, ip: 0, op: DURATION_F,
    w: W, h: H, nm: kind, ddd: 0, assets: [], layers, markers: [],
  };
}

function assertEased(data) {
  for (const l of data.layers) {
    for (const [name, prop] of Object.entries(l.ks)) {
      if (!prop || prop.a !== 1 || !Array.isArray(prop.k)) continue;
      prop.k.forEach((k, i) => {
        if (i === prop.k.length - 1) return;
        if (!k.o || !k.i) {
          console.error(`${l.nm}.${name} keyframe ${i} has no easing handles`);
          process.exit(1);
        }
      });
    }
    // trim paths are animated too, and just as fatal when unEased
    for (const group of l.shapes) {
      for (const item of group.it) {
        if (item.ty !== 'tm') continue;
        item.e.k.forEach((k, i) => {
          if (i === item.e.k.length - 1) return;
          if (!k.o || !k.i) {
            console.error(`${l.nm} trim keyframe ${i} has no easing handles`);
            process.exit(1);
          }
        });
      }
    }
  }
}

for (const kind of ['check', 'cross']) {
  const data = build(kind);
  assertEased(data);
  const out = path.join(OUT_DIR, `${kind}.lottie.json`);
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(`Wrote public/${kind}.lottie.json (${data.layers.length} layers, `
    + `${(DURATION_F / FPS).toFixed(2)}s, ${(fs.statSync(out).size / 1024).toFixed(1)}KB)`);
}
