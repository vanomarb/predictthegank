/**
 * Generates public/timer-typeface.json — the glyph outlines the 3D countdown
 * extrudes (see public/timer3d.js).
 *
 *   npm run build:typeface
 *
 * Three.js can only extrude text from its own "typeface.json" format, and
 * nobody publishes one for Poppins. So this converts the real Poppins SemiBold
 * TTF into that format, subset to the twelve characters a countdown can ever
 * show. Two things fall out of doing it here rather than pointing at a CDN:
 *
 *   - the file is ~6KB instead of the ~70KB a full-alphabet typeface costs, and
 *   - it is served from our own origin, so the countdown makes no cross-origin
 *     runtime fetch at all and needs no connect-src allowance of its own.
 *
 * The output is committed, so nothing here runs at install or boot time. Re-run
 * it only to change the weight or the character set.
 */

const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const TTF_URL = process.env.POPPINS_TTF_URL
  || 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf';
const OUT = path.join(__dirname, '..', 'public', 'timer-typeface.json');

// Must stay in sync with GLYPHS in public/timer3d.js: the digits, the
// separator, and the dash the '--:--:--' placeholder is built from.
const SUBSET = '0123456789:-';

/**
 * Re-encodes one opentype.js path into a typeface.json outline string.
 *
 * The command order is the part worth being careful about: three's FontLoader
 * reads 'q' as (endX endY controlX controlY) and 'b' as (endX endY c1x c1y c2x
 * c2y) — end point FIRST, which is the reverse of every other path format.
 * Getting it backwards still parses, it just renders subtly mangled glyphs.
 */
function encodeOutline(glyphPath) {
  const out = [];
  const n = (v) => Math.round(v);
  for (const cmd of glyphPath.commands) {
    switch (cmd.type) {
      case 'M': out.push('m', n(cmd.x), n(cmd.y)); break;
      case 'L': out.push('l', n(cmd.x), n(cmd.y)); break;
      case 'Q': out.push('q', n(cmd.x), n(cmd.y), n(cmd.x1), n(cmd.y1)); break;
      case 'C': out.push('b', n(cmd.x), n(cmd.y), n(cmd.x1), n(cmd.y1), n(cmd.x2), n(cmd.y2)); break;
      case 'Z': break; // typeface.json contours are implicitly closed
      default: throw new Error(`unhandled path command ${cmd.type}`);
    }
  }
  return out.join(' ');
}

async function fetchTtf() {
  const res = await fetch(TTF_URL);
  if (!res.ok) throw new Error(`${TTF_URL} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const ttf = await fetchTtf();
  const font = opentype.parse(
    ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength),
  );

  const glyphs = {};
  for (const ch of SUBSET) {
    const glyph = font.charToGlyph(ch);
    if (!glyph || glyph.index === 0) throw new Error(`Poppins has no glyph for ${JSON.stringify(ch)}`);
    // glyph.path is in font units with y pointing up — the same convention
    // typeface.json uses, so no flip or rescale is needed.
    const bbox = glyph.path.getBoundingBox();
    glyphs[ch] = {
      ha: Math.round(glyph.advanceWidth),
      x_min: Math.round(bbox.x1),
      x_max: Math.round(bbox.x2),
      o: encodeOutline(glyph.path),
    };
  }

  // opentype.js buckets the name table by platform; Google's Poppins only ships
  // the Windows record, so read through both rather than assuming either.
  const name = (key, fallback) => font.names.windows?.[key]?.en
    || font.names.macintosh?.[key]?.en
    || font.names.unicode?.[key]?.en
    || fallback;

  const data = {
    glyphs,
    familyName: name('fontFamily', 'Poppins'),
    ascender: Math.round(font.ascender),
    descender: Math.round(font.descender),
    underlinePosition: Math.round(font.tables.post?.underlinePosition ?? -100),
    underlineThickness: Math.round(font.tables.post?.underlineThickness ?? 50),
    boundingBox: {
      xMin: Math.round(font.tables.head.xMin),
      xMax: Math.round(font.tables.head.xMax),
      yMin: Math.round(font.tables.head.yMin),
      yMax: Math.round(font.tables.head.yMax),
    },
    resolution: font.unitsPerEm,
    original_font_information: {
      full_font_name: name('fullName', 'Poppins SemiBold'),
      license: name('license', 'SIL Open Font License, Version 1.1'),
      manufacturer: name('manufacturer', 'Indian Type Foundry'),
    },
    cssFontWeight: 'normal',
    cssFontStyle: 'normal',
    subsetOf: SUBSET,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(data)}\n`);

  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`Wrote public/timer-typeface.json — ${data.original_font_information.full_font_name}, ${SUBSET.length} glyphs, ${size}KB`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
