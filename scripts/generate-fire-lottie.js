/**
 * Generates public/fire.lottie.json — the toast "on fire" effect, modelled on
 * Messenger's: big flames rising from BEHIND the bubble rather than small
 * tongues sitting on each border.
 *
 *   npm run build:fire
 *
 * Layout. The composition is much taller than the bubble it decorates, and the
 * bubble occupies a known band inside it:
 *
 *     0,0 +------------------------------+
 *         |        flames rise here      |
 *         |   +----------------------+   |  <- BUBBLE band (BX..BX+BW, BY..BY+BH)
 *         |   +----------------------+   |
 *         +------------------------------+ W,H
 *
 * The player positions this so the band lands exactly on the toast (the
 * percentages in TOAST_FIRE_CLASS in viz.js are derived from these constants,
 * and this script prints them), and the layer sits behind the bubble's own
 * background so the flames appear to come out from underneath it.
 *
 * Three rules this file follows, each of which cost a rewrite:
 *
 *   - No flame may extend past the composition edge. An SVG clips to its
 *     viewBox, so an over-hanging tip renders as a rounded stub — the first
 *     version of this effect was a ring of coloured blobs for exactly that
 *     reason. Asserted below.
 *   - Every keyframe carries linear bezier handles. Without `i`/`o` lottie
 *     evaluates the property to NaN and drops the layer silently.
 *   - The flicker loops seamlessly: a toast lives a few seconds and a visible
 *     restart looks like a glitch. Also asserted.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'fire.lottie.json');

// The side margins have to be wide enough for the outward-leaning side flames:
// at 50px they overhung the left edge and the clipping guard rejected the file.
const W = 480;
const H = 220;

// Where the toast sits inside the composition. The aspect of this band is what
// keeps the stretch to a real toast close to uniform: 320x60 is 5.3:1, and a
// one-line toast measures about 234x44, which is 5.3:1 too.
const BX = 80;
// The rise is capped deliberately. Taller flames looked better in isolation but
// the toast rail lives near the top of the viewport, and anything above about
// 2x the bubble height gets clipped by the top of the window instead — a
// composition that cannot fit on screen is worse than a shorter one.
const BY = 110;
const BW = 320;
const BH = 60;

const FPS = 60;
const DURATION_F = 72; // 1.2s loop

// Messenger's fire reads as a hot pale core inside deeper orange. Ordered
// brightest first; the tall flames pick from the top of the list so the biggest
// tongues are the brightest.
const COLOURS = [
  [1.0, 0.93, 0.62],   // pale gold core
  [1.0, 0.78, 0.28],   // amber
  [1.0, 0.55, 0.14],   // orange
  [0.9, 0.33, 0.12],   // deep orange-red
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

const round = (n) => Math.round(n * 10) / 10;
const LINEAR_OUT = { x: [0], y: [0] };
const LINEAR_IN = { x: [1], y: [1] };
const eased = (keys) => keys.map((k, i, all) => (
  i === all.length - 1 ? k : { ...k, o: LINEAR_OUT, i: LINEAR_IN }
));

/** Keyframes that start and end on the same value, so the loop is seamless. */
function cycle(cycles, values, toValue) {
  const keys = [];
  const perCycle = DURATION_F / cycles;
  for (let c = 0; c < cycles; c += 1) {
    values.forEach((v, i) => {
      if (c > 0 && i === 0) return;
      keys.push({ t: Math.round(c * perCycle + (i * perCycle) / values.length), s: toValue(v) });
    });
  }
  keys.push({ t: DURATION_F, s: toValue(values[0]) });
  return eased(keys);
}

/**
 * A flame: a closed teardrop with its tip along -y and a wide, soft base.
 * Tangents are relative to their vertex, as the lottie path format expects. The
 * shoulders sit low and bulge, which is what makes it read as fire rather than
 * as a leaf.
 */
function flamePath(width, height) {
  const hw = width / 2;
  return {
    ty: 'sh', ix: 1, nm: 'Flame', hd: false,
    ks: { a: 0, ix: 2, k: {
      c: true,
      v: [
        [0, -height],
        [hw, -height * 0.1],
        [0, height * 0.12],
        [-hw, -height * 0.1],
      ],
      i: [
        [-hw * 0.5, -height * 0.34],
        [hw * 0.1, -height * 0.5],
        [hw * 0.62, 0],
        [-hw * 0.1, height * 0.26],
      ],
      o: [
        [hw * 0.5, -height * 0.34],
        [-hw * 0.1, height * 0.26],
        [-hw * 0.62, 0],
        [hw * 0.1, -height * 0.5],
      ],
    } },
  };
}

function flame(ind, { x, y, rotation, height, width, colour, cycles, phase }) {
  const heights = [1, 1.3, 0.84, 1.14].map((v) => v * (0.92 + phase * 0.16));
  const opacities = [78, 100, 62, 92];
  return {
    ddd: 0, ind, ty: 4, nm: `flame-${ind}`, sr: 1,
    ks: {
      o: { a: 1, ix: 11, k: cycle(cycles, opacities, (v) => [round(v)]) },
      r: { a: 0, k: rotation, ix: 10 },
      p: { a: 0, k: [round(x), round(y), 0], ix: 2 },
      a: { a: 0, k: [0, 0, 0], ix: 1 },
      // The anchor is the flame's base, so a flicker grows it upward rather
      // than making it float.
      s: { a: 1, ix: 6, k: cycle(cycles, heights, (v) => [
        round(100 * (0.96 + (v - 1) * 0.3)), round(100 * v), 100,
      ]) },
    },
    ao: 0,
    shapes: [{
      ty: 'gr', nm: 'G', bm: 0, hd: false,
      it: [
        flamePath(width, height),
        { ty: 'fl', c: { a: 0, k: [colour[0], colour[1], colour[2], 1], ix: 4 },
          o: { a: 0, k: 100, ix: 5 }, r: 1, bm: 0, nm: 'F', hd: false },
        { ty: 'tr', p: { a: 0, k: [0, 0], ix: 2 }, a: { a: 0, k: [0, 0], ix: 1 },
          s: { a: 0, k: [100, 100], ix: 3 }, r: { a: 0, k: 0, ix: 6 },
          o: { a: 0, k: 100, ix: 7 }, sk: { a: 0, k: 0, ix: 4 }, sa: { a: 0, k: 0, ix: 5 }, nm: 'T' },
      ],
    }],
    ip: 0, op: DURATION_F, st: 0, bm: 0,
  };
}

function build() {
  const random = makeRandom(0x9d2c5680);
  const specs = [];

  // The flicker scales a flame up to ~1.35x, so heights are budgeted against
  // that to keep the tallest tip inside the composition.
  const FLICKER_HEADROOM = 1.35;
  const maxRise = (BY - 14) / FLICKER_HEADROOM;

  // 1. The body of the fire: tall flames along the bubble's top edge, rising,
  //    tallest in the middle the way a real fire banks up.
  // Few, large and overlapping — not many narrow ones. A dense row of thin
  // flames reads as a comb or a soundwave; the reference effect is a handful of
  // big soft tongues that overlap each other.
  for (let x = BX - 10; x <= BX + BW + 10; x += 40) {
    const t = (x - BX) / BW;
    const centreBias = 1 - Math.abs(t - 0.5) * 0.65;
    const height = (0.5 + random() * 0.45) * maxRise * centreBias;
    specs.push({
      x, y: BY + 8, rotation: (random() - 0.5) * 14, // a slight lean
      height, width: height * (0.78 + random() * 0.4),
      colour: COLOURS[Math.floor(random() * 3)],
      cycles: 2 + Math.floor(random() * 3), phase: random(),
    });
  }

  // 2. Side flames, licking up and outward past the bubble's ends.
  for (const [edgeX, dir] of [[BX + 6, -1], [BX + BW - 6, 1]]) {
    for (let i = 0; i < 3; i += 1) {
      const height = (0.3 + random() * 0.34) * maxRise;
      specs.push({
        x: edgeX + dir * i * 14, y: BY + BH - i * 16,
        rotation: dir * (22 + random() * 22),
        height, width: height * (0.7 + random() * 0.34),
        colour: COLOURS[1 + Math.floor(random() * 3)],
        cycles: 2 + Math.floor(random() * 3), phase: random(),
      });
    }
  }

  // 3. A few small flames below the bubble, so it is not resting on nothing.
  const belowRoom = (H - (BY + BH) - 14) / FLICKER_HEADROOM;
  for (let x = BX + 34; x < BX + BW; x += 78) {
    const height = 14 + random() * Math.max(6, belowRoom - 14);
    specs.push({
      x: x + random() * 10, y: BY + BH - 6, rotation: 180 + (random() - 0.5) * 22,
      height, width: height * (0.85 + random() * 0.35),
      colour: COLOURS[2 + Math.floor(random() * 2)],
      cycles: 2 + Math.floor(random() * 3), phase: random(),
    });
  }

  // Tallest last, so the brightest, biggest tongues sit in front.
  specs.sort((a, b) => a.height - b.height);
  return {
    v: '5.13.0', fr: FPS, ip: 0, op: DURATION_F,
    w: W, h: H, nm: 'fire', ddd: 0, assets: [], markers: [],
    layers: specs.map((spec, i) => flame(i + 1, spec)),
  };
}

const data = build();

// ---- guards ----
for (const layer of data.layers) {
  for (const [name, prop] of Object.entries(layer.ks)) {
    if (!prop || prop.a !== 1 || !Array.isArray(prop.k)) continue;
    prop.k.forEach((k, i) => {
      if (i === prop.k.length - 1) return;
      if (!k.o || !k.i) {
        console.error(`${layer.nm}.${name} keyframe ${i} has no easing handles`);
        process.exit(1);
      }
    });
    const first = JSON.stringify(prop.k[0].s);
    const last = JSON.stringify(prop.k[prop.k.length - 1].s);
    if (first !== last) {
      console.error(`${layer.nm}.${name} does not loop: ${first} -> ${last}`);
      process.exit(1);
    }
  }

  // Clipping. Rotating the local tip (0,-h) by rot in lottie's y-down space
  // gives (h·sin, -h·cos); the flicker can push it 35% further out. Getting
  // these signs backwards checks the flame's base instead of its tip and passes
  // everything, which is how the blobs shipped the first time.
  const [x, y] = layer.ks.p.k;
  const rot = (layer.ks.r.k * Math.PI) / 180;
  const h = -layer.shapes[0].it[0].ks.k.v[0][1] * 1.35;
  const tipX = x + h * Math.sin(rot);
  const tipY = y - h * Math.cos(rot);
  if (tipX < -2 || tipX > W + 2 || tipY < -2 || tipY > H + 2) {
    console.error(`${layer.nm}: tip at ${tipX.toFixed(0)},${tipY.toFixed(0)} falls outside the `
      + `${W}x${H} composition — the viewBox would clip it into a blob`);
    process.exit(1);
  }
}

fs.writeFileSync(OUT, `${JSON.stringify(data)}\n`);
console.log(`Wrote public/fire.lottie.json (${data.layers.length} flames, ${W}x${H}, bubble band `
  + `${BX},${BY} ${BW}x${BH}, ${(DURATION_F / FPS).toFixed(1)}s seamless loop, `
  + `${(fs.statSync(OUT).size / 1024).toFixed(0)}KB)`);
console.log('  mount geometry for viz.js: '
  + `left-[${(-BX / BW * 100).toFixed(2)}%] top-[${(-BY / BH * 100).toFixed(2)}%] `
  + `w-[${(W / BW * 100).toFixed(2)}%] h-[${(H / BH * 100).toFixed(2)}%]`);
