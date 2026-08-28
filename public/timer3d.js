/* ============================================================
   timer3d.js — the extruded 3D countdown clock used by the public tracker's
   hero (index.html) and the admin console's "next window" panel (admin.html).

   Contract with public.js / admin.js (both drive it the same way):
     const t = window.Timer3D.init(canvasEl, '--:--:--');
     t.setText('01:23:45');   // re-rendered digit-by-digit, animated
     t.setUrgent(true);       // under a minute — red pulse
     t.setTheme(isDark);      // re-reads the design tokens from shared.css
     t.dispose();

   Three.js is an ES module loaded from a CDN via the importmap in the two HTML
   documents (which is why server.js threads a CSP nonce into them, and why
   cdn.jsdelivr.net is allowed under script-src). The typeface is ours: a
   12-glyph Poppins subset built by scripts/generate-timer-typeface.js and
   served from our own origin, so the runtime fetch() FontLoader makes is
   covered by connect-src 'self' and needs no cross-origin allowance of its own.

   Because this file is a module it is deferred, so public.js/admin.js have
   already run by the time it executes: they check for window.Timer3D first and
   otherwise wait for the 'timer3d-ready' event dispatched at the bottom.
   ============================================================ */

import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

// Poppins SemiBold, subset to the twelve characters below — the page's display
// face, so the countdown matches the rest of the type instead of falling back
// to whatever generic bold a CDN typeface happens to be.
const FONT_URL = '/timer-typeface.json';

// Every glyph the countdown can ever show: the digits, the separator, and the
// dash used by the '--:--:--' placeholder. Extruding text is expensive, so all
// twelve are built once up front and the meshes just swap geometry references.
const GLYPHS = '0123456789:-';

const GLYPH_SIZE = 1;           // cap height, in world units — everything scales off this
const GLYPH_DEPTH = 0.26;       // extrusion depth: what makes the digits read as 3D
const TRACKING = 0.09;          // gap between slots — tight, so the glyphs get the width
const SEPARATOR_SQUEEZE = 0.45; // ':' gets a much narrower slot than a digit
const SWAP_MS = 380;            // one digit morphing into the next
const PULSE_MS = 1100;          // urgent red heartbeat

// Framing margins around the digit row, as plain taste — a hair of air at the
// sides, more above and below so the vertical tilt has somewhere to go. The
// room the hover state needs is NOT in here: frameCamera() derives that from
// HOVER_SCALE and HOVER_LIFT_Z, because the amount depends on the camera
// distance. Padding twice for the same thing is how the type ends up
// needlessly small.
const FIT_PAD_X = 1.02;
const FIT_PAD_Y = 1.28;

// Hover response, kept here because the framing above depends on both.
const HOVER_SCALE = 0.04;   // how much the whole row grows
const HOVER_LIFT_Z = 0.3;   // how far the digits under the cursor rise
const HOVER_TILT_Y = 0.42;  // radians, at the left/right edge of the canvas
const HOVER_TILT_X = 0.26;  // radians, at the top/bottom edge

const DISPLAY_STACK = "'Poppins', system-ui, -apple-system, 'Segoe UI', sans-serif";
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// Slight overshoot on the incoming digit, so the roll lands with a mechanical
// snap. The two coefficients must stay c and c+1 or the curve no longer passes
// through 0 at t=0, and every digit starts its roll mid-air.
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
// Frame-rate independent smoothing: the same visual damping at 30fps and
// 144fps. Exponential decay never actually arrives, so it snaps once the gap is
// imperceptible — otherwise a stale sliver of "urgent" keeps tinting the digits
// long after the countdown left the last minute.
const APPROACH_EPSILON = 0.0005;
const approach = (current, target, rate, dt) => {
  const next = current + (target - current) * (1 - Math.exp(-rate * dt));
  return Math.abs(target - next) < APPROACH_EPSILON ? target : next;
};

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function colorFromVar(name, fallback) {
  const c = new THREE.Color();
  try { c.setStyle(cssVar(name, fallback)); } catch (e) { c.setStyle(fallback); }
  return c;
}

// The urgent state's outer glow is an animate-urgent-glow utility toggled on the
// canvas (keyframes live in tailwind-config.js), and the tap-highlight reset is
// a utility in the markup. This file used to inject a small stylesheet of its
// own for both; it does not need to any more, and the app now has no class
// selectors outside Tailwind.
const URGENT_GLOW_CLASS = 'animate-urgent-glow';

// Parsed once per page and shared by every clock on it (each page has only one,
// but this also means a second init() never re-fetches the typeface).
let fontPromise = null;
function loadFont() {
  if (!fontPromise) {
    fontPromise = new Promise((resolve, reject) => {
      new FontLoader().load(FONT_URL, resolve, undefined, reject);
    });
  }
  return fontPromise;
}

// Probed on a throwaway canvas, never the real one: creating a WebGL context on
// an element permanently forecloses getContext('2d') on it, and the flat
// fallback below needs that 2D context to still be available.
function webglSupported() {
  try {
    const probe = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------- 3D clock */

function createClock3D(canvas, font, state) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const root = new THREE.Group(); // the whole digit row: hover tilt/spin/scale live here
  scene.add(root);

  // ---- lights. The point lights use decay 0 so their intensity stays a plain
  // multiplier rather than an inverse-square falloff we'd have to re-tune.
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(-1.5, 2, 3);
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
  rimLight.position.set(1.8, -1.3, 1.4);
  const pointerLight = new THREE.PointLight(0xffffff, 0, 0, 0); // follows the cursor
  const urgentLight = new THREE.PointLight(0xff4433, 0, 0, 0);  // the red heartbeat
  urgentLight.position.set(0, 0, 2.4);
  scene.add(ambient, keyLight, rimLight, pointerLight, urgentLight);

  // ---- glyph geometry cache
  const geoms = new Map();
  let maxDigitWidth = 0;
  // GLYPH_SIZE is the em size, not the height of a digit — cap height is about
  // 0.7em in Poppins. Framing against the em would waste roughly a third of the
  // vertical space, so the real ink height is measured here and used instead.
  let maxDigitHeight = 0;
  for (const ch of GLYPHS) {
    const geo = new TextGeometry(ch, {
      font,
      size: GLYPH_SIZE,
      height: GLYPH_DEPTH, // r160's name for the extrusion; `depth` is the newer alias
      depth: GLYPH_DEPTH,
      curveSegments: 5,
      bevelEnabled: true,
      bevelThickness: 0.022,
      bevelSize: 0.016,
      bevelSegments: 2,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const width = bb.max.x - bb.min.x;
    // Re-centre each glyph on its own origin: the roll animation rotates a slot
    // about the digit's middle, and TextGeometry would otherwise leave it
    // hinged at the baseline's left corner.
    geo.translate(
      -(bb.max.x + bb.min.x) / 2,
      -(bb.max.y + bb.min.y) / 2,
      -(bb.max.z + bb.min.z) / 2,
    );
    geoms.set(ch, geo);
    if (/[0-9]/.test(ch)) {
      maxDigitWidth = Math.max(maxDigitWidth, width);
      maxDigitHeight = Math.max(maxDigitHeight, bb.max.y - bb.min.y);
    }
  }
  const contentHeight = maxDigitHeight || GLYPH_SIZE;

  // Digits share one advance width so the clock never shuffles sideways as the
  // numbers change — a proportional "1" would make the whole row twitch.
  const DIGIT_ADVANCE = maxDigitWidth + TRACKING;
  const advanceFor = (ch) => (ch === ':' ? DIGIT_ADVANCE * SEPARATOR_SQUEEZE : DIGIT_ADVANCE);

  // ---- palette, re-read from shared.css on every theme change
  const baseColor = new THREE.Color();
  const amberColor = new THREE.Color();
  const urgentColor = new THREE.Color();
  const scratch = new THREE.Color();
  const emissiveScratch = new THREE.Color();

  function applyTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    baseColor.copy(colorFromVar('--text-primary', dark ? '#f3f1e7' : '#1c1811'));
    amberColor.copy(colorFromVar('--amber-500', '#f2a93b'));
    urgentColor.copy(colorFromVar('--status-bad', dark ? '#ef6a5a' : '#b23a26'));
    ambient.intensity = dark ? 1.0 : 1.9;
    keyLight.intensity = dark ? 2.4 : 2.9;
    rimLight.color.copy(amberColor);
    rimLight.intensity = dark ? 1.3 : 0.9;
    urgentLight.color.copy(urgentColor);
    for (const slot of slots) {
      // Dark digits on paper read better as a polished solid; light digits at
      // night read better as brushed metal catching the amber rim.
      for (const mesh of [slot.front, slot.back]) {
        mesh.material.metalness = dark ? 0.55 : 0.28;
        mesh.material.roughness = dark ? 0.32 : 0.42;
      }
    }
  }

  // ---- slots: one per character, each holding the current glyph mesh plus the
  // outgoing one it is rolling over.
  const slots = [];

  // Deliberately opaque. The digits used to cross-fade, which meant two
  // half-transparent extruded solids overlapping in the same slot — and a
  // transparent mesh still writes depth, so the pair produced a hard bright
  // band across the glyphs mid-swap. The morph below never needs opacity.
  function makeMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.5,
      roughness: 0.34,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
  }

  function restMesh(mesh) {
    mesh.scale.setScalar(1);
    mesh.rotation.z = 0;
    mesh.position.z = 0;
  }

  function setSlotChar(slot, ch, instant) {
    const geo = geoms.get(ch) || geoms.get('-');
    if (instant) {
      slot.front.geometry = geo;
      slot.front.visible = true;
      restMesh(slot.front);
      slot.back.visible = false;
      slot.t = 1;
    } else {
      // Hand the outgoing glyph to the back mesh, then morph the new one out of it.
      slot.back.geometry = slot.front.geometry;
      slot.back.visible = true;
      restMesh(slot.back);
      slot.front.geometry = geo;
      slot.front.visible = true;
      slot.front.scale.setScalar(0);
      slot.t = 0;
    }
    slot.ch = ch;
    slot.advance = advanceFor(ch);
  }

  function addSlot(ch) {
    const group = new THREE.Group();
    const front = new THREE.Mesh(geoms.get('-'), makeMaterial());
    const back = new THREE.Mesh(geoms.get('-'), makeMaterial());
    back.visible = false;
    group.add(front, back);
    root.add(group);
    const slot = { ch: null, group, front, back, t: 1, advance: DIGIT_ADVANCE, x: 0 };
    slots.push(slot);
    setSlotChar(slot, ch, true);
    return slot;
  }

  function clearSlots() {
    for (const slot of slots) {
      slot.front.material.dispose();
      slot.back.material.dispose();
      root.remove(slot.group);
    }
    slots.length = 0;
  }

  let contentWidth = 1;
  let viewHalfW = 1;
  let viewHalfH = 1;

  function layout() {
    let total = 0;
    for (const slot of slots) total += slot.advance;
    let x = -total / 2;
    for (const slot of slots) {
      slot.x = x + slot.advance / 2;
      slot.group.position.x = slot.x;
      x += slot.advance;
    }
    contentWidth = Math.max(0.1, total - TRACKING); // trailing tracking isn't ink
    frameCamera();
  }

  // Pulls the camera back to exactly frame the digit row — whichever of width or
  // height is the binding constraint. With FIT_PAD_X at 1.03 that means the
  // numbers run nearly edge to edge, which is the point.
  function frameCamera() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Zero-sized means hidden — public.js swaps the canvas for "HAPPENING NOW"
    // with display:none, and admin.html's panel starts hidden behind the login
    // form. Bailing matters: setSize() multiplies by the pixel ratio, so
    // re-framing off a collapsed box would double the drawing buffer on every
    // hide/show cycle. The ResizeObserver fires again on the way back to
    // visible, which is when the real numbers arrive.
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const fit = (boxW, boxH) => Math.max(
      (boxH / 2) / Math.tan(vFov / 2),
      (boxW / 2) / Math.tan(hFov / 2),
    ) + GLYPH_DEPTH;

    // Two passes. The first frames the row at rest; the second re-frames with
    // the extra room the hover state needs, which can only be worked out once
    // the camera distance is known — a digit lifted HOVER_LIFT_Z toward the
    // camera is magnified by dist / (dist - lift), and that factor depends on
    // dist. One refinement is plenty: the correction moves dist by a few
    // percent, and its effect on the factor is second-order.
    //
    // The worst case is not "everything at once". A digit is only lifted while
    // the cursor is near it, and the cursor being out at the edge — where it
    // would lift an outermost digit — is also where the tilt is largest, and
    // tilt foreshortens that axis by cos(angle). So the margin each axis needs
    // is the larger of "cursor centred" (scale only) and "cursor at the edge"
    // (scale x foreshortening x lift), and the two axes need different amounts.
    const restDist = fit(contentWidth * FIT_PAD_X, contentHeight * FIT_PAD_Y);
    const liftMagnify = restDist / (restDist - HOVER_LIFT_Z);
    const magnifyX = (1 + HOVER_SCALE) * Math.max(1, liftMagnify * Math.cos(HOVER_TILT_Y));
    const magnifyY = (1 + HOVER_SCALE) * Math.max(1, liftMagnify * Math.cos(HOVER_TILT_X));
    const dist = fit(
      contentWidth * FIT_PAD_X * magnifyX,
      contentHeight * FIT_PAD_Y * magnifyY,
    );
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    // Cached so pointer coordinates map onto the z=0 plane without a raycast.
    viewHalfH = Math.tan(vFov / 2) * dist;
    viewHalfW = viewHalfH * camera.aspect;
  }

  function setText(text) {
    const chars = Array.from(String(text == null ? '' : text)).map((c) => (geoms.has(c) ? c : '-'));
    if (chars.length === 0) chars.push('-');
    if (chars.length !== slots.length) {
      clearSlots();
      chars.forEach(addSlot);
      applyTheme();
      layout();
      return;
    }
    // Only the slots that actually changed animate — at one tick per second
    // that is usually just the seconds digit, occasionally a carry.
    const instant = reducedMotion.matches || !running;
    chars.forEach((ch, i) => {
      if (slots[i].ch !== ch) setSlotChar(slots[i], ch, instant);
    });
  }

  /* ---- interaction: hover tilt, a cursor-tracking light, per-digit lift, and a
     full tumble on click/tap. Pointer events cover mouse and touch alike (both
     canvases already opt out of default touch panning). */
  let hover = 0;
  let hoverTarget = 0;
  let pointerNdcX = 0;
  let pointerNdcY = 0;
  let tiltX = 0;
  let tiltY = 0;
  let spinT = 1;
  const priorCursor = canvas.style.cursor;

  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNdcX = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    pointerNdcY = clamp(-((((e.clientY - rect.top) / rect.height) * 2) - 1), -1, 1);
    hoverTarget = 1;
    // Set on the element, not via a class: admin.html pins cursor:default in an
    // inline style, which no stylesheet rule can outrank.
    canvas.style.cursor = 'pointer';
  }

  function onPointerOut() {
    hoverTarget = 0;
    canvas.style.cursor = priorCursor;
  }

  function onPointerDown(e) {
    onPointerMove(e);
    if (spinT >= 1 && !reducedMotion.matches) spinT = 0; // one tumble at a time
  }

  function onPointerUp(e) {
    if (e.pointerType !== 'mouse') onPointerOut(); // touch has no "leave"
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerenter', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerOut);
  canvas.addEventListener('pointercancel', onPointerOut);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  /* ---- render loop */
  let urgentMix = 0;
  let elapsed = 0;
  let raf = 0;
  let running = false;
  let onScreen = true;
  const clock = new THREE.Clock();

  function update(dt) {
    const still = reducedMotion.matches;
    elapsed += dt;
    hover = approach(hover, hoverTarget, 9, dt);
    urgentMix = approach(urgentMix, state.urgent ? 1 : 0, 5, dt);
    const pulse = 0.5 - 0.5 * Math.cos((elapsed * 2 * Math.PI * 1000) / PULSE_MS);
    const beat = still ? 0.75 : pulse;

    // whole-row transform: tilt toward the cursor, a click tumble on top
    if (!still) {
      tiltY = approach(tiltY, pointerNdcX * HOVER_TILT_Y * hover, 8, dt);
      tiltX = approach(tiltX, -pointerNdcY * HOVER_TILT_X * hover, 8, dt);
      if (spinT < 1) spinT = Math.min(1, spinT + dt / 0.9);
      // Drops back to 0 once the tumble finishes rather than resting on a
      // permanent full turn — the same angle on screen, but it keeps the row's
      // resting rotation actually zero.
      const spin = spinT < 1 ? easeInOutCubic(spinT) * Math.PI * 2 : 0;
      root.rotation.y = tiltY + spin;
      root.rotation.x = tiltX;
      root.scale.setScalar(1 + hover * HOVER_SCALE + urgentMix * beat * 0.03);

      // Tilting swings one end of the row toward the camera, by
      // sin(tilt) x halfWidth — for a clock this wide that is over a world
      // unit, and perspective then magnifies that end by ~45%. THAT is what cut
      // the outermost digit off at the canvas edge on hover. Reserving margin
      // for it would have cost about a third of the type size, so the row
      // recedes by exactly the distance its near end advanced instead: the tilt
      // becomes a true vanishing-point rotation (the far end shrinks away) and
      // the near end stays at the depth the camera was framed for.
      root.position.z = -(
        Math.abs(Math.sin(tiltY)) * (contentWidth / 2)
        + Math.abs(Math.sin(tiltX)) * (contentHeight / 2)
        + (spinT < 1 ? Math.abs(Math.sin(spin)) * (contentWidth / 2) : 0)
      );
    }

    const pointerX = pointerNdcX * viewHalfW;
    const pointerY = pointerNdcY * viewHalfH;
    pointerLight.position.set(pointerX, pointerY, 2);
    pointerLight.intensity = hover * 3.2;
    pointerLight.color.copy(urgentMix > 0.5 ? urgentColor : amberColor);
    urgentLight.intensity = urgentMix * (0.5 + 2 * beat);

    // digit colour: fully red under a minute, with the emissive channel doing
    // the actual pulsing (hover adds a warm highlight to the nearest digits)
    scratch.copy(baseColor).lerp(urgentColor, urgentMix);
    emissiveScratch.copy(amberColor).lerp(urgentColor, urgentMix);

    for (const slot of slots) {
      const nearness = still
        ? 0
        : Math.pow(Math.max(0, 1 - Math.abs(pointerX - slot.x) / (DIGIT_ADVANCE * 2.2)), 2);
      const lift = hover * nearness;
      slot.group.position.z = lift * HOVER_LIFT_Z;
      slot.group.position.y = lift * 0.07;

      const emissive = urgentMix * (0.12 + 0.78 * beat) + lift * 0.4;
      for (const mesh of [slot.front, slot.back]) {
        mesh.material.color.copy(scratch);
        mesh.material.emissive.copy(emissiveScratch);
        mesh.material.emissiveIntensity = emissive;
      }

      if (slot.t < 1) {
        slot.t = Math.min(1, slot.t + (dt * 1000) / SWAP_MS);
        stepMorph(slot);
      }
    }
  }

  /**
   * One digit becoming another.
   *
   * This used to be a split-flap flip: both glyphs rotated about their
   * horizontal axis, which meant that twice per swap a glyph passed through
   * edge-on and showed the flat, brightly lit face of its own extrusion — the
   * pale bar that swept across the number on every tick. The cross-fade made it
   * worse: a half-transparent mesh still writes depth, so the two overlapping
   * glyphs cut hard-edged holes in each other.
   *
   * So nothing rotates about a horizontal axis any more, and nothing is
   * transparent. The outgoing glyph collapses into the slot while the incoming
   * one swells out of it, overlapping briefly in the middle where both are
   * small — the digit reads as changing shape rather than turning over, and no
   * extruded edge is ever pointed at the camera. Squash (wider as it loses
   * height, the way a compressed solid behaves) and a small counter-twist about
   * z — the axis facing the viewer, which shows no edge — give it some weight.
   */
  const MORPH_OUT_END = 0.55;   // the outgoing glyph is fully gone by here
  const MORPH_IN_START = 0.42;  // the incoming one starts here: a slight overlap
  function stepMorph(slot) {
    const t = slot.t;

    const outT = clamp(t / MORPH_OUT_END, 0, 1);
    const outScale = 1 - easeInCubic(outT);
    slot.back.visible = outScale > 0.001;
    slot.back.scale.set(outScale * (1 + 0.3 * (1 - outScale)), outScale, Math.max(outScale, 0.001));
    slot.back.rotation.z = -0.18 * outT;
    slot.back.position.z = -0.04; // just off the incoming glyph plane

    const inT = clamp((t - MORPH_IN_START) / (1 - MORPH_IN_START), 0, 1);
    const inScale = inT <= 0 ? 0 : easeOutBack(inT);
    slot.front.scale.set(
      inScale * (1 + 0.22 * (1 - clamp(inScale, 0, 1))),
      inScale,
      Math.max(inScale, 0.001),
    );
    slot.front.rotation.z = 0.16 * (1 - easeOutCubic(inT));

    if (t >= 1) {
      restMesh(slot.front);
      slot.back.visible = false;
    }
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    update(Math.min(clock.getDelta(), 0.05)); // clamped: a backgrounded tab must not jump
    renderer.render(scene, camera);
  }

  function start() {
    if (running) return;
    running = true;
    clock.getDelta();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }

  // Nothing to animate while the tab is hidden or the clock is scrolled out of
  // view, and a spinning GPU loop is exactly the kind of thing that shows up in
  // someone's battery report.
  function syncRunning() {
    if (onScreen && !document.hidden) start();
    else stop();
  }
  const onVisibility = () => syncRunning();
  document.addEventListener('visibilitychange', onVisibility);

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting;
        syncRunning();
      }, { threshold: 0 })
    : null;
  if (io) io.observe(canvas);

  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => frameCamera()) : null;
  if (ro) ro.observe(canvas);
  const onResize = () => frameCamera();
  window.addEventListener('resize', onResize);

  // ---- boot
  Array.from(String(state.text)).forEach((c) => addSlot(geoms.has(c) ? c : '-'));
  if (slots.length === 0) addSlot('-');
  applyTheme();
  layout();
  urgentMix = state.urgent ? 1 : 0;
  syncRunning();
  update(0);
  renderer.render(scene, camera); // paint frame one immediately, even if paused

  return {
    setText,
    setUrgent() { /* colour and pulse are driven from state.urgent each frame */ },
    setTheme: applyTheme,
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerenter', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerOut);
      canvas.removeEventListener('pointercancel', onPointerOut);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      clearSlots();
      for (const geo of geoms.values()) geo.dispose();
      geoms.clear();
      renderer.dispose();
    },
  };
}

/* ------------------------------------------------- flat 2D fallback clock */

// No WebGL, or the typeface failed to load. The countdown is the whole point of
// the page, so it still has to be readable — just flat, in the display face,
// keeping the red urgent pulse.
function createFlatClock(canvas, state) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { setText() {}, setUrgent() {}, setTheme() {}, dispose() {} };

  let raf = 0;
  let animating = false;

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const pxW = Math.round(w * dpr);
    const pxH = Math.round(h * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let size = h * 0.82;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${size}px ${DISPLAY_STACK}`;
    const measured = ctx.measureText(state.text).width || 1;
    if (measured > w * 0.96) {
      size *= (w * 0.96) / measured;
      ctx.font = `700 ${size}px ${DISPLAY_STACK}`;
    }

    const pulse = 0.5 - 0.5 * Math.cos((performance.now() * 2 * Math.PI) / PULSE_MS);
    ctx.globalAlpha = state.urgent && !reducedMotion.matches ? 0.55 + 0.45 * pulse : 1;
    ctx.fillStyle = state.urgent
      ? cssVar('--status-bad', '#b23a26')
      : cssVar('--text-primary', '#1c1811');
    ctx.fillText(state.text, w / 2, h / 2);
    ctx.globalAlpha = 1;
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    draw();
  }

  // Only the urgent pulse needs a continuous loop; the rest of the time this is
  // one repaint per second, on demand.
  function syncLoop() {
    const shouldAnimate = state.urgent && !reducedMotion.matches && !document.hidden;
    if (shouldAnimate && !animating) {
      animating = true;
      draw(); // repaint now — every caller of this expects the change on screen
      raf = requestAnimationFrame(loop);
    } else if (!shouldAnimate && animating) {
      animating = false;
      cancelAnimationFrame(raf);
      draw();
    } else {
      draw();
    }
  }

  const onVisibility = () => syncLoop();
  const onResize = () => draw();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(canvas);
  // Poppins arrives with the stylesheet, usually after the first paint.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw).catch(() => {});

  syncLoop();

  return {
    setText: draw,
    setUrgent: syncLoop,
    setTheme: draw,
    dispose() {
      if (animating) cancelAnimationFrame(raf);
      animating = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
    },
  };
}

/* ----------------------------------------------------------------- public */

function init(canvas, initialText = '--:--:--') {
  if (!canvas) throw new Error('Timer3D.init needs a <canvas>');

  // A façade, because the real renderer may not exist yet (the typeface is
  // still in flight) and may turn out to be the flat fallback. Callers get a
  // usable handle synchronously either way; state lives out here so whichever
  // renderer wins starts from the latest values, not the ones init() saw.
  const state = { text: String(initialText), urgent: false };
  let impl = null;

  const api = {
    setText(text) {
      const next = String(text == null ? '' : text);
      if (next === state.text) return;
      state.text = next;
      if (impl) impl.setText(next);
    },
    setUrgent(urgent) {
      const next = !!urgent;
      if (next === state.urgent) return;
      state.urgent = next;
      canvas.classList.toggle(URGENT_GLOW_CLASS, next);
      if (impl) impl.setUrgent(next);
    },
    setTheme(isDark) {
      if (impl) impl.setTheme(!!isDark);
    },
    dispose() {
      if (impl) impl.dispose();
      impl = null;
    },
  };

  if (!webglSupported()) {
    impl = createFlatClock(canvas, state);
    return api;
  }

  // Fade in rather than pop: the typeface fetch is usually well under a second,
  // but a hard cut from blank to full-size digits is jarring.
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 260ms ease';
  const reveal = () => { canvas.style.opacity = '1'; };

  loadFont().then((font) => {
    try {
      impl = createClock3D(canvas, font, state);
    } catch (e) {
      console.warn('[timer3d] 3D clock failed, falling back to flat', e);
      impl = createFlatClock(canvas, state);
    }
    reveal();
  }).catch((e) => {
    console.warn('[timer3d] typeface failed to load, falling back to flat', e);
    impl = createFlatClock(canvas, state);
    reveal();
  });

  return api;
}

window.Timer3D = { init };
window.dispatchEvent(new Event('timer3d-ready'));
