/**
 * Generates the full-page outcome animations:
 *
 *   public/confetti-page.lottie.json  — a hit. Confetti falls across the whole
 *                                       viewport behind the modal.
 *   public/dud-page.lottie.json       — a miss. The same physics with the life
 *                                       taken out of it: grey, slow, limp, no
 *                                       burst. Confetti for a thumbs-down.
 *
 *   npm run build:page-confetti
 *
 * These mount into the existing full-screen overlay (#confettiLottie, fixed
 * inset-0, pointer-events-none) with preserveAspectRatio 'xMidYMid slice', so
 * the composition fills any viewport by cropping rather than distorting —
 * stretching confetti into ovals is exactly what a page-scale animation must not
 * do. The composition is therefore sized to a common laptop aspect and simply
 * over-fills the rest.
 *
 * Every keyframe carries linear bezier handles: a keyframe without `i`/`o` makes
 * lottie evaluate the property to NaN and silently drop the layer.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public');

const W = 1280;
const H = 800;
const FPS = 60;
const SAMPLE_EVERY = 10; // frames between position samples; gravity is smooth

// The design system's accents for a hit; muted greys for a miss.
const BRIGHT = [
  [0.949, 0.663, 0.231], // --amber-500
  [1.0, 0.8, 0.478],     // --amber-300
  [0.435, 0.812, 0.482], // --status-good
  [0.937, 0.416, 0.353], // --status-bad
  [1.0, 0.92, 0.62],     // pale gold
];
const DULL = [
  [0.541, 0.502, 0.408],
  [0.424, 0.404, 0.353],
  [0.35, 0.35, 0.33],
];

const VARIANTS = {
  'confetti-page': {
    pieces: 72, duration: 200, colours: BRIGHT,
    gravity: [340, 200], drift: 150, spin: [200, 900], size: [7, 9],
    launch: -60, spread: 1.0, opacity: 100,
  },
  'dud-page': {
    pieces: 34, duration: 220, colours: DULL,
    gravity: [150, 90], drift: 40, spin: [40, 160], size: [6, 7],
    launch: -30, spread: 0.75, opacity: 70,
  },
};

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

const round = (n) => Math.round(n * 10) / 10;
const LINEAR_OUT = { x: [0], y: [0] };
const LINEAR_IN = { x: [1], y: [1] };
const eased = (keys) => keys.map((k, i, all) => (
  i === all.length - 1 ? k : { ...k, o: LINEAR_OUT, i: LINEAR_IN }
));

function piece(index, cfg, random) {
  const colour = cfg.colours[Math.floor(random() * cfg.colours.length)];
  const pieceW = cfg.size[0] + random() * cfg.size[1];
  const pieceH = pieceW * (0.35 + random() * 0.5);
  const spin = (random() < 0.5 ? -1 : 1) * (cfg.spin[0] + random() * cfg.spin[1]);
  const delay = Math.round(random() * cfg.duration * 0.45);
  const life = cfg.duration - delay;

  // Starts above the top edge, spread across the width, and falls. A little
  // horizontal drift and a per-piece gravity keeps the field from marching in
  // lockstep.
  let x = random() * W;
  let y = cfg.launch - random() * 220;
  let vx = (random() - 0.5) * 2 * cfg.drift * cfg.spread;
  let vy = 20 + random() * 90;
  const gravity = cfg.gravity[0] + random() * cfg.gravity[1];
  const dt = 1 / FPS;

  const samples = [];
  for (let f = 0; f <= life; f += 1) {
    if (f % SAMPLE_EVERY === 0 || f === life) samples.push({ f, x, y });
    vy += gravity * dt;
    vx *= 0.995;
    x += vx * dt;
    y += vy * dt;
  }

  return {
    ddd: 0, ind: index + 1, ty: 4, nm: `p${index + 1}`, sr: 1,
    ks: {
      o: { a: 1, ix: 11, k: eased([
        { t: delay, s: [0] },
        { t: delay + 6, s: [cfg.opacity] },
        { t: delay + Math.round(life * 0.75), s: [cfg.opacity] },
        { t: delay + life, s: [0] },
      ]) },
      r: { a: 1, ix: 10, k: eased(samples.map((s) => ({
        t: delay + s.f, s: [round((spin * s.f) / life)],
      }))) },
      p: { a: 1, ix: 2, k: eased(samples.map((s) => ({
        t: delay + s.f, s: [round(s.x), round(s.y)],
      }))) },
      a: { a: 0, k: [0, 0, 0], ix: 1 },
      s: { a: 0, k: [100, 100, 100], ix: 6 },
    },
    ao: 0,
    shapes: [{
      ty: 'gr', nm: 'P', bm: 0, hd: false,
      it: [
        { ty: 'rc', d: 1, s: { a: 0, k: [round(pieceW), round(pieceH)], ix: 2 },
          p: { a: 0, k: [0, 0], ix: 3 }, r: { a: 0, k: 1, ix: 4 }, nm: 'R', hd: false },
        { ty: 'fl', c: { a: 0, k: [colour[0], colour[1], colour[2], 1], ix: 4 },
          o: { a: 0, k: 100, ix: 5 }, r: 1, bm: 0, nm: 'F', hd: false },
        { ty: 'tr', p: { a: 0, k: [0, 0], ix: 2 }, a: { a: 0, k: [0, 0], ix: 1 },
          s: { a: 0, k: [100, 100], ix: 3 }, r: { a: 0, k: 0, ix: 6 },
          o: { a: 0, k: 100, ix: 7 }, sk: { a: 0, k: 0, ix: 4 }, sa: { a: 0, k: 0, ix: 5 }, nm: 'T' },
      ],
    }],
    ip: delay, op: delay + life + 1, st: delay, bm: 0,
  };
}

function assertEased(data, name) {
  for (const l of data.layers) {
    for (const [prop, p] of Object.entries(l.ks)) {
      if (!p || p.a !== 1 || !Array.isArray(p.k)) continue;
      p.k.forEach((k, i) => {
        if (i === p.k.length - 1) return;
        if (!k.o || !k.i) {
          console.error(`${name}: ${l.nm}.${prop} keyframe ${i} has no easing handles`);
          process.exit(1);
        }
      });
    }
  }
}

for (const [name, cfg] of Object.entries(VARIANTS)) {
  const random = makeRandom(name === 'confetti-page' ? 0x2a1f7c3b : 0x77c1e409);
  const layers = [];
  for (let i = 0; i < cfg.pieces; i += 1) layers.push(piece(i, cfg, random));

  const data = {
    v: '5.13.0', fr: FPS, ip: 0, op: cfg.duration + 10,
    w: W, h: H, nm: name, ddd: 0, assets: [], layers, markers: [],
  };
  assertEased(data, name);

  // Every piece must actually cross the visible area, or it is bytes for
  // nothing — a field that all falls off to one side reads as broken.
  const onScreen = data.layers.filter((l) => l.ks.p.k.some((k) => (
    k.s[0] > -40 && k.s[0] < W + 40 && k.s[1] > 0 && k.s[1] < H
  ))).length;
  if (onScreen < cfg.pieces * 0.9) {
    console.error(`${name}: only ${onScreen}/${cfg.pieces} pieces ever enter the frame`);
    process.exit(1);
  }

  const out = path.join(OUT_DIR, `${name}.lottie.json`);
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(`Wrote public/${name}.lottie.json (${cfg.pieces} pieces, `
    + `${(cfg.duration / FPS).toFixed(1)}s, ${onScreen} on screen, `
    + `${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
}
