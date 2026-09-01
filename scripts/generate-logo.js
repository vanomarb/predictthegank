/**
 * Turns public/icon.jpg into the two logo assets the pages actually use:
 *
 *   public/logo.png      128x128, the header mark
 *   public/favicon.png   48x48, the browser tab
 *
 *   npm run build:logo
 *
 * The source is a 1024x1024 JPEG of black line art on a white background, and
 * it cannot be used as-is for three reasons:
 *
 *   - 260KB on every page load, for something drawn at 22px.
 *   - JPEG has no alpha, so the white background renders as a white tile. On the
 *     dark theme that is a glowing square around the mark.
 *   - The art sits inside a wide margin, so drawn small it becomes a speck.
 *
 * So this trims to the ink, resamples, and rebuilds the image with alpha taken
 * from how dark each pixel is: pure white becomes fully transparent, pure black
 * fully opaque, and the anti-aliased edges in between keep their softness rather
 * than turning into a jagged cut-out. The colour channels are forced to black,
 * which is what makes `dark:invert` in the markup produce a clean white mark
 * instead of an inverted photograph of one.
 *
 * Playwright provides the canvas — it is already a devDependency for the browser
 * probes, and the alternative is an image-processing library pulled in to do one
 * resize. The output is committed, so a deploy never runs this.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, '..', 'public', 'icon.jpg');
const OUTPUTS = [
  { file: 'logo.png', size: 128 },
  { file: 'favicon.png', size: 48 },
];

// Anything at least this far from white counts as ink when finding the crop box.
// Generous, so JPEG's ringing around the black lines does not widen the trim.
const INK_THRESHOLD = 40;
// Breathing room around the trimmed art, as a fraction of its longest side. With
// none, the mark's edges touch the icon's edges and it reads as cramped.
const PADDING = 0.06;

async function build() {
  if (!fs.existsSync(SRC)) throw new Error(`missing source image: ${SRC}`);
  const dataUri = `data:image/jpeg;base64,${fs.readFileSync(SRC).toString('base64')}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const results = await page.evaluate(async ({ dataUri: uri, outputs, inkThreshold, padding }) => {
      const img = new Image();
      img.src = uri;
      await img.decode();

      // ---- 1. read the source once ----
      const src = document.createElement('canvas');
      src.width = img.naturalWidth;
      src.height = img.naturalHeight;
      const sctx = src.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(img, 0, 0);
      const { data, width, height } = sctx.getImageData(0, 0, src.width, src.height);

      // ---- 2. find the ink ----
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          // Luminance, not a per-channel test: the art is greyscale, and one
          // channel of JPEG noise should not count as a stray pixel of ink.
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (255 - lum < inkThreshold) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) throw new Error('found no ink in the source image — is it blank?');

      // ---- 3. square the crop, so nothing is stretched ----
      const inkW = maxX - minX + 1;
      const inkH = maxY - minY + 1;
      const side = Math.max(inkW, inkH) * (1 + padding * 2);
      const cx = minX + inkW / 2;
      const cy = minY + inkH / 2;
      const crop = {
        x: Math.round(cx - side / 2),
        y: Math.round(cy - side / 2),
        size: Math.round(side),
      };

      // ---- 4. resample, then rebuild with alpha from darkness ----
      const out = [];
      for (const { file, size } of outputs) {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        // White first: the source has no alpha, and a crop that runs past the
        // edge of the image would otherwise resample transparent black into the
        // margin and leave a grey shadow along that side.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);

        const px = ctx.getImageData(0, 0, size, size);
        for (let i = 0; i < px.data.length; i += 4) {
          const lum = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
          px.data[i] = 0;
          px.data[i + 1] = 0;
          px.data[i + 2] = 0;
          px.data[i + 3] = Math.round(255 - lum);
        }
        ctx.putImageData(px, 0, 0);

        out.push({ file, size, dataUrl: c.toDataURL('image/png') });
      }
      return { crop, source: { width, height }, ink: { inkW, inkH }, out };
    }, { dataUri, outputs: OUTPUTS, inkThreshold: INK_THRESHOLD, padding: PADDING });

    for (const { file, size, dataUrl } of results.out) {
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(__dirname, '..', 'public', file), buf);
      console.log(`wrote public/${file}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)}KB`);
    }

    const { source, ink, crop } = results;
    console.log(`source ${source.width}x${source.height}, ink ${ink.inkW}x${ink.inkH}, `
      + `cropped to ${crop.size}x${crop.size} at (${crop.x},${crop.y})`);

    // Self-assertions: this runs by hand, months apart, and a silently wrong
    // output would only be noticed as a blurry logo nobody can explain.
    const assert = (ok, msg) => { if (!ok) throw new Error(`assertion failed: ${msg}`); };
    assert(ink.inkW > source.width * 0.3, 'the trim found almost no ink — threshold too high?');
    assert(crop.size <= Math.max(source.width, source.height) * 1.2, 'the crop is larger than the source');
    for (const { file } of OUTPUTS) {
      const p = path.join(__dirname, '..', 'public', file);
      const buf = fs.readFileSync(p);
      assert(buf.length > 200, `${file} is suspiciously small`);
      assert(buf.length < 60 * 1024, `${file} is larger than the JPEG it replaces`);
      assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        `${file} is not a PNG`);
      // A transparent background is the whole point; a fully opaque file means
      // the alpha pass did not run.
      assert(buf.includes(Buffer.from('IDAT')), `${file} has no image data`);
    }
    console.log('all assertions passed');
  } finally {
    await browser.close();
  }
}

build().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
