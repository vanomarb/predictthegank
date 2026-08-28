/**
 * Generates public/confetti.lottie.json — the burst that plays over the
 * "I see them" button (see playConfettiLottie in public/public.js).
 *
 *   node scripts/generate-confetti-lottie.js
 *
 * Written as a generator rather than a hand-authored blob for two reasons: a
 * 24-piece Lottie is thousands of lines of near-identical keyframes that nobody
 * can review or re-tune by hand, and the piece motion is a physics sim — easier
 * to state as gravity + drag here than to approximate with bezier handles.
 *
 * Keyframes are sampled from the sim every few frames and joined with LINEAR
 * bezier handles. The handles are not optional: a keyframe without `i`/`o` makes
 * lottie evaluate the property to NaN and drop the layer without a word, which
 * is how an earlier version of this file shipped animating nothing at all.
 * Deterministic on purpose too — a seeded PRNG, so re-running this produces a
 * byte-identical file instead of a noisy diff.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'confetti.lottie.json');

const W = 240;
const H = 240;
const FPS = 60;
const DURATION_F = 96; // 1.6s
const SAMPLE_EVERY = 6; // frames between position/rotation samples
const PIECES = 24;

// The design system's accent hues (shared.css), so the burst belongs to the
// same palette as everything else on the page.
const COLORS = [
  [0.949, 0.663, 0.231], // --amber-500  #f2a93b
  [1.0, 0.8, 0.478], // --amber-300  #ffcc7a
  [0.435, 0.812, 0.482], // --status-good #6fcf7b
  [0.937, 0.416, 0.353], // --status-bad  #ef6a5a
];

// Mulberry32 — small, seeded, and stable across Node versions.
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


/**
 * One confetti piece: launched upward-ish from the centre, then gravity and
 * air drag take over. Displacement is deliberately kept inside the 240x240
 * composition — the SVG renderer clips to the composition bounds, and a piece
 * vanishing at a hard edge looks like a bug rather than a flourish.
 */
function simulate(random) {
  const angle = Math.PI + random() * Math.PI; // upward half of the circle
  const speed = 120 + random() * 150; // px/s
  const gravity = 300 + random() * 160; // px/s^2
  const drag = 0.965;

  let x = 0;
  let y = 0;
  let vx = Math.cos(angle) * speed;
  let vy = Math.sin(angle) * speed;

  const samples = [];
  const dt = 1 / FPS;
  for (let f = 0; f <= DURATION_F; f += 1) {
    if (f % SAMPLE_EVERY === 0 || f === DURATION_F) {
      samples.push({ f, x, y });
    }
    vy += gravity * dt;
    vx *= drag;
    vy *= drag;
    x += vx * dt;
    y += vy * dt;
  }
  return samples;
}

function buildPiece(index, random) {
  const color = COLORS[index % COLORS.length];
  const pieceW = 5 + random() * 7;
  const pieceH = 3 + random() * 6;
  const spin = (random() < 0.5 ? -1 : 1) * (360 + random() * 720);
  const delay = Math.round(random() * 6); // a few frames of stagger, so it reads as a burst
  const life = DURATION_F - delay;
  const samples = simulate(random);

  const positionKeys = samples.map((s) => ({
    t: delay + s.f,
    s: [round(W / 2 + s.x), round(H / 2 + s.y)],
  }));

  const rotationKeys = samples.map((s) => ({
    t: delay + s.f,
    s: [round((spin * s.f) / DURATION_F)],
  }));

  // Pop in over 3 frames, hold, then fade out over the last third of the life.
  const opacityKeys = [
    { t: delay, s: [0] },
    { t: delay + 3, s: [100] },
    { t: delay + Math.round(life * 0.6), s: [100] },
    { t: delay + life, s: [0] },
  ];

  return {
    ddd: 0,
    ind: index + 1,
    ty: 4, // shape layer
    nm: `piece-${index + 1}`,
    sr: 1,
    ks: {
      o: { a: 1, k: eased(opacityKeys), ix: 11 },
      r: { a: 1, k: eased(rotationKeys), ix: 10 },
      p: { a: 1, k: eased(positionKeys), ix: 2 },
      a: { a: 0, k: [0, 0, 0], ix: 1 },
      s: { a: 0, k: [100, 100, 100], ix: 6 },
    },
    ao: 0,
    shapes: [
      {
        ty: 'gr',
        it: [
          {
            ty: 'rc',
            d: 1,
            s: { a: 0, k: [round(pieceW), round(pieceH)], ix: 2 },
            p: { a: 0, k: [0, 0], ix: 3 },
            r: { a: 0, k: 1, ix: 4 },
            nm: 'Rectangle',
            hd: false,
          },
          {
            ty: 'fl',
            c: { a: 0, k: [color[0], color[1], color[2], 1], ix: 4 },
            o: { a: 0, k: 100, ix: 5 },
            r: 1,
            bm: 0,
            nm: 'Fill',
            hd: false,
          },
          {
            ty: 'tr',
            p: { a: 0, k: [0, 0], ix: 2 },
            a: { a: 0, k: [0, 0], ix: 1 },
            s: { a: 0, k: [100, 100], ix: 3 },
            r: { a: 0, k: 0, ix: 6 },
            o: { a: 0, k: 100, ix: 7 },
            sk: { a: 0, k: 0, ix: 4 },
            sa: { a: 0, k: 0, ix: 5 },
            nm: 'Transform',
          },
        ],
        nm: 'Piece',
        bm: 0,
        hd: false,
      },
    ],
    ip: delay,
    op: delay + life + 1,
    st: delay,
    bm: 0,
  };
}

function build() {
  const random = makeRandom(0x9e3779b9);
  const layers = [];
  for (let i = 0; i < PIECES; i += 1) layers.push(buildPiece(i, random));
  return {
    v: '5.13.0',
    fr: FPS,
    ip: 0,
    op: DURATION_F + 8, // a little tail so the last fade finishes before 'complete'
    w: W,
    h: H,
    nm: 'confetti',
    ddd: 0,
    assets: [],
    layers,
    markers: [],
  };
}

const data = build();
assertEased(data);
fs.writeFileSync(OUT, `${JSON.stringify(data)}\n`);
console.log(`Wrote ${path.relative(path.join(__dirname, '..'), OUT)} (${PIECES} pieces, ${DURATION_F / FPS}s)`);
