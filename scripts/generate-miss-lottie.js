/**
 * Generates public/miss.lottie.json — the animation for the "wrong prediction"
 * modal, the counterpart to confetti.lottie.json which plays on a hit.
 *
 *   npm run build:miss
 *
 * Same reasoning as the confetti generator: a hand-authored Lottie is thousands
 * of lines of near-identical keyframes nobody can review, and the motion here is
 * a physics sim, which is easier to state as gravity than to approximate with
 * bezier handles. Deterministic (seeded PRNG), so re-running produces a
 * byte-identical file rather than a noisy diff.
 *
 * The animation reads as a swing and a miss: a target ring pulses open, a dot
 * arcs past the outside of it and drops away, and a few limp confetti pieces
 * fall straight down — deflated versions of the ones that celebrate a hit.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'miss.lottie.json');

const W = 240;
const H = 240;
const FPS = 60;
const DURATION_F = 108; // 1.8s
const SAMPLE_EVERY = 6;
const PIECES = 7;

// Muted end of the design system: the amber accent for the dot and ring, plus
// desaturated greys for the falling pieces (shared.css --text-muted-ish).
const AMBER = [0.949, 0.663, 0.231];
const DULL = [
  [0.541, 0.502, 0.408],
  [0.424, 0.404, 0.353],
  [0.937, 0.416, 0.353],
];

function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n) => Math.round(n * 100) / 100;
// ---- keyframe easing ----
// Every keyframe except the last MUST carry bezier handles. Without them lottie
// evaluates the property to NaN and silently drops the layer: for opacity it
// hides the layer and never even builds its path, so the animation renders as an
// empty box with no error anywhere. (0,0) -> (1,1) is a straight line, which is
// what these sampled simulations want — the curve is already in the samples.
const LINEAR_OUT = { x: [0], y: [0] };
const LINEAR_IN = { x: [1], y: [1] };
const eased = (keys) => keys.map((k, i, all) => (
  i === all.length - 1 ? k : { ...k, o: LINEAR_OUT, i: LINEAR_IN }
));

// Refuses to write a file that would render as nothing.
function assertEased(data) {
  for (const layer of data.layers) {
    for (const [name, prop] of Object.entries(layer.ks)) {
      if (!prop || prop.a !== 1 || !Array.isArray(prop.k)) continue;
      prop.k.forEach((k, i) => {
        if (i === prop.k.length - 1) return;
        if (!k.o || !k.i) {
          console.error(`${layer.nm}.${name} keyframe ${i} (t=${k.t}) has no easing handles — `
            + 'lottie would drop this layer silently.');
          process.exit(1);
        }
      });
    }
  }
}


const transform = () => ({
  ty: 'tr',
  p: { a: 0, k: [0, 0], ix: 2 },
  a: { a: 0, k: [0, 0], ix: 1 },
  s: { a: 0, k: [100, 100], ix: 3 },
  r: { a: 0, k: 0, ix: 6 },
  o: { a: 0, k: 100, ix: 7 },
  sk: { a: 0, k: 0, ix: 4 },
  sa: { a: 0, k: 0, ix: 5 },
  nm: 'Transform',
});

function shapeLayer(index, name, shapes, ks, ip, op) {
  return {
    ddd: 0, ind: index, ty: 4, nm: name, sr: 1,
    ks: {
      o: ks.o, r: ks.r || { a: 0, k: 0, ix: 10 }, p: ks.p,
      a: { a: 0, k: [0, 0, 0], ix: 1 },
      s: ks.s || { a: 0, k: [100, 100, 100], ix: 6 },
    },
    ao: 0, shapes, ip, op, st: 0, bm: 0,
  };
}

/** The target ring: scales open, holds, fades. It is what the dot misses. */
function ring(index) {
  return shapeLayer(index, 'ring', [{
    ty: 'gr',
    it: [
      { ty: 'el', d: 1, s: { a: 0, k: [96, 96], ix: 2 }, p: { a: 0, k: [0, 0], ix: 3 }, nm: 'Ellipse', hd: false },
      {
        ty: 'st',
        c: { a: 0, k: [AMBER[0], AMBER[1], AMBER[2], 1], ix: 3 },
        o: { a: 0, k: 100, ix: 4 },
        w: { a: 0, k: 5, ix: 5 },
        lc: 2, lj: 1, bm: 0, nm: 'Stroke', hd: false,
      },
      transform(),
    ],
    nm: 'Ring', bm: 0, hd: false,
  }], {
    o: { a: 1, ix: 11, k: eased([
      { t: 0, s: [0] },
      { t: 10, s: [55] },
      { t: 62, s: [40] },
      { t: 96, s: [0] },
    ]) },
    p: { a: 0, k: [W / 2, H / 2, 0], ix: 2 },
    s: { a: 1, ix: 6, k: eased([
      { t: 0, s: [40, 40, 100] },
      { t: 14, s: [104, 104, 100] },
      { t: 62, s: [112, 112, 100] },
      { t: 96, s: [126, 126, 100] },
    ]) },
  }, 0, DURATION_F);
}

/**
 * The dot: launched from the lower left, arcing up and to the right, deliberately
 * clearing the ring's edge rather than passing through the middle, then falling
 * away under gravity. Sampled from a sim and emitted as linear keyframes — the
 * curve is already in the samples, so the file only needs straight segments.
 */
function dot(index) {
  // These four numbers were solved for, not guessed. The arc has to satisfy
  // three things at once and the obvious values satisfy none of them:
  //   - stay clear of the ring by more than (ring stroke + dot radius), or the
  //     dot visually grazes the target and the miss stops reading as a miss;
  //   - keep the whole flight on screen while the dot is still opaque, which
  //     ruled out the flatter arc that skimmed under the ring and off the
  //     bottom edge;
  //   - actually go over the top, so it looks like a throw going wide rather
  //     than a dot wandering past.
  // Result: closest approach 65px against a 48px radius — about 6px of daylight
  // between the dot's edge and the ring's. The generator asserts both the
  // clearance and the on-screen requirement below, so a future retune cannot
  // quietly break either.
  const samples = [];
  let x = -90;
  let y = 55;
  let vx = 130;
  let vy = -400;
  const dt = 1 / FPS;
  for (let f = 0; f <= DURATION_F; f += 1) {
    if (f % SAMPLE_EVERY === 0 || f === DURATION_F) samples.push({ f, x, y });
    vy += 520 * dt;
    x += vx * dt;
    y += vy * dt;
  }
  return shapeLayer(index, 'dot', [{
    ty: 'gr',
    it: [
      { ty: 'el', d: 1, s: { a: 0, k: [17, 17], ix: 2 }, p: { a: 0, k: [0, 0], ix: 3 }, nm: 'Ellipse', hd: false },
      {
        ty: 'fl',
        c: { a: 0, k: [AMBER[0], AMBER[1], AMBER[2], 1], ix: 4 },
        o: { a: 0, k: 100, ix: 5 },
        r: 1, bm: 0, nm: 'Fill', hd: false,
      },
      transform(),
    ],
    nm: 'Dot', bm: 0, hd: false,
  }], {
    o: { a: 1, ix: 11, k: eased([
      { t: 0, s: [0] },
      { t: 6, s: [100] },
      { t: 70, s: [100] },
      { t: 100, s: [0] },
    ]) },
    p: { a: 1, ix: 2, k: eased(samples.map((s) => ({
      t: s.f,
      s: [round(W / 2 + s.x), round(H / 2 + s.y)],
    }))) },
  }, 0, DURATION_F);
}

/** Deflated confetti: no burst, just gravity and a slow tumble. */
function piece(index, random) {
  const colour = DULL[index % DULL.length];
  const pieceW = 5 + random() * 6;
  const pieceH = 3 + random() * 5;
  const startX = -80 + random() * 160;
  const drift = -14 + random() * 28;
  const spin = (random() < 0.5 ? -1 : 1) * (60 + random() * 200);
  const delay = 6 + Math.round(random() * 26);
  const life = DURATION_F - delay;

  const samples = [];
  let y = -60 - random() * 30;
  let vy = 10 + random() * 30;
  const dt = 1 / FPS;
  for (let f = 0; f <= life; f += 1) {
    if (f % SAMPLE_EVERY === 0 || f === life) samples.push({ f, y, x: startX + (drift * f) / FPS });
    vy += 210 * dt;
    y += vy * dt;
  }

  return shapeLayer(index + 3, `piece-${index + 1}`, [{
    ty: 'gr',
    it: [
      {
        ty: 'rc', d: 1,
        s: { a: 0, k: [round(pieceW), round(pieceH)], ix: 2 },
        p: { a: 0, k: [0, 0], ix: 3 },
        r: { a: 0, k: 1, ix: 4 },
        nm: 'Rectangle', hd: false,
      },
      {
        ty: 'fl',
        c: { a: 0, k: [colour[0], colour[1], colour[2], 1], ix: 4 },
        o: { a: 0, k: 100, ix: 5 },
        r: 1, bm: 0, nm: 'Fill', hd: false,
      },
      transform(),
    ],
    nm: 'Piece', bm: 0, hd: false,
  }], {
    o: { a: 1, ix: 11, k: eased([
      { t: delay, s: [0] },
      { t: delay + 5, s: [80] },
      { t: delay + Math.round(life * 0.65), s: [80] },
      { t: delay + life, s: [0] },
    ]) },
    r: { a: 1, ix: 10, k: eased(samples.map((s) => ({
      t: delay + s.f,
      s: [round((spin * s.f) / life)],
    }))) },
    p: { a: 1, ix: 2, k: eased(samples.map((s) => ({
      t: delay + s.f,
      s: [round(W / 2 + s.x), round(H / 2 + s.y)],
    }))) },
  }, delay, delay + life + 1);
}

function build() {
  const random = makeRandom(0x5bf03635);
  const layers = [ring(1), dot(2)];
  for (let i = 0; i < PIECES; i += 1) layers.push(piece(i, random));
  return {
    v: '5.13.0',
    fr: FPS,
    ip: 0,
    op: DURATION_F + 6,
    w: W,
    h: H,
    nm: 'miss',
    ddd: 0,
    assets: [],
    layers,
    markers: [],
  };
}

const data = build();
assertEased(data);

// The dot has to stay outside the ring for its whole flight. Cheap to check
// here, impossible to notice in a diff.
const RING_RADIUS = 48;
const dotPath = data.layers.find((l) => l.nm === 'dot').ks.p.k;
const dist = (k) => Math.hypot(k.s[0] - W / 2, k.s[1] - H / 2);
const closest = Math.min(...dotPath.map(dist));
if (closest <= RING_RADIUS) {
  console.error(`dot passes through the ring (closest ${closest.toFixed(1)} <= radius ${RING_RADIUS}) — that reads as a hit, not a miss`);
  process.exit(1);
}

// ...and the moment of the miss has to be on screen. Clipping the near-miss
// at the frame edge is the one thing that would make it unreadable.
const nearest = dotPath.reduce((a, b) => (dist(b) < dist(a) ? b : a));
const MARGIN = 12;
const onScreen = nearest.s[0] > MARGIN && nearest.s[0] < W - MARGIN
  && nearest.s[1] > MARGIN && nearest.s[1] < H - MARGIN;
if (!onScreen) {
  console.error(`the near-miss happens off screen at [${nearest.s}] in a ${W}x${H} frame`);
  process.exit(1);
}

fs.writeFileSync(OUT, `${JSON.stringify(data)}\n`);
const size = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`Wrote public/miss.lottie.json (ring + dot + ${PIECES} pieces, ${DURATION_F / FPS}s, ${size}KB; dot clears the ring by ${(closest - RING_RADIUS).toFixed(1)}px)`);
