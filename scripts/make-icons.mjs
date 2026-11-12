// Génère les icônes PWA et les écrans de démarrage iOS de Hub, sans dépendance.
// Le logo est décrit par des formes simples (champs de distance), rendues avec
// anticrénelage puis encodées en PNG via zlib.  Usage : node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { t = Math.min(1, Math.max(0, t)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };

// ---- Logo (repère 512 × 512) : mêmes cotes que icons/icon.svg ----
const TILE_TOP = hex("#1C232B"), TILE_BOT = hex("#0D1013"), TILE_EDGE = hex("#2B333C");
const H_TOP = hex("#7AA5FF"), H_BOT = hex("#3E76F0");
const DOT = hex("#3DBE7E");
const TILE_R = 116;
const BARS = [[148, 132, 206, 380, 13], [306, 132, 364, 380, 13], [190, 228, 322, 284, 0]];
const DOT_C = [380, 128], DOT_R = 30, NOTCH_R = 44;

const sdRound = (px, py, [x0, y0, x1, y1, r]) => {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (px, py, [cx, cy], r) => Math.hypot(px - cx, py - cy) - r;

// Dessine le logo dans `buf` (RGBA) à (ox, oy), sur `size` pixels.
//   tile : "round" (carré arrondi, coins transparents) | "full" (plein cadre, pour maskable / iOS)
//   k    : échelle du motif (H + pastille) autour du centre — < 1 pour la zone sûre maskable
function drawMark(buf, W, ox, oy, size, { tile = "round", k = 1 } = {}) {
  const s = 512 / size; // unités du repère par pixel
  const cov = (d) => Math.min(1, Math.max(0, 0.5 - d / s));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * s, v = (y + 0.5) * s;
      const tileCol = mix(TILE_TOP, TILE_BOT, v / 512);
      let rgb = tileCol, a = 1;
      if (tile === "round") {
        const d = sdRound(u, v, [0, 0, 512, 512, TILE_R]);
        a = cov(d);
        if (a <= 0) continue;
        const edge = a - cov(d + 3); // liseré intérieur discret
        rgb = mix(tileCol, TILE_EDGE, edge);
      }
      // Motif, éventuellement réduit autour du centre
      const mu = (u - 256) / k + 256, mv = (v - 256) / k + 256;
      const covM = (d) => Math.min(1, Math.max(0, 0.5 - (d * k) / s));
      const dH = Math.min(sdRound(mu, mv, BARS[0]), sdRound(mu, mv, BARS[1]), sdRound(mu, mv, BARS[2]));
      const aH = covM(dH) * (1 - covM(sdCircle(mu, mv, DOT_C, NOTCH_R)));
      if (aH > 0) rgb = mix(rgb, mix(H_TOP, H_BOT, (mv - 132) / 248), aH);
      const aD = covM(sdCircle(mu, mv, DOT_C, DOT_R));
      if (aD > 0) rgb = mix(rgb, DOT, aD);

      const i = ((oy + y) * W + ox + x) * 4;
      const ia = buf[i + 3] / 255; // fond déjà présent (splash) ou transparent (icône)
      const outA = a + ia * (1 - a);
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round((rgb[c] * a + buf[i + c] * ia * (1 - a)) / (outA || 1));
      buf[i + 3] = Math.round(outA * 255);
    }
  }
}

// ---- Encodeur PNG minimal (8 bits, RGB ou RGBA, filtre « Up ») ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(rgba, w, h, alpha) {
  const ch = alpha ? 4 : 3, stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = y ? 2 : 0;
    for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
      const cur = rgba[(y * w + x) * 4 + c];
      raw[o + 1 + x * ch + c] = y ? (cur - rgba[((y - 1) * w + x) * 4 + c]) & 255 : cur;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function save(rel, buf) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  console.log(rel.padEnd(40), (buf.length / 1024).toFixed(1) + " Ko");
}

function icon(rel, size, opts) {
  const buf = new Uint8ClampedArray(size * size * 4);
  drawMark(buf, size, 0, 0, size, opts);
  save(rel, encodePng(buf, size, size, opts.tile === "round"));
}
function splash(rel, w, h, bg) {
  const buf = new Uint8ClampedArray(w * h * 4);
  const [r, g, b] = hex(bg);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
  const size = Math.round(w * 0.26);
  drawMark(buf, w, Math.round((w - size) / 2), Math.round((h - size) / 2), size, { tile: "round" });
  save(rel, encodePng(buf, w, h, false));
}

// Tailles d'écran iPhone (portrait) : [largeur CSS, hauteur CSS, densité]
export const IPHONES = [
  [320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3], [360, 780, 3],
  [390, 844, 3], [428, 926, 3], [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3], [420, 912, 3],
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  icon("icons/icon-192.png", 192, { tile: "round" });
  icon("icons/icon-512.png", 512, { tile: "round" });
  icon("icons/icon-maskable-512.png", 512, { tile: "full", k: 0.8 });
  icon("icons/apple-touch-icon.png", 180, { tile: "full", k: 0.92 });
  icon("icons/favicon-32.png", 32, { tile: "round" });
  for (const [cw, chh, dpr] of IPHONES) {
    const w = cw * dpr, h = chh * dpr;
    splash(`splash/ios-${w}x${h}-dark.png`, w, h, "#0D1013");
    splash(`splash/ios-${w}x${h}-light.png`, w, h, "#F1F3F5");
  }
  // Balises <link> à coller dans index.html
  if (process.argv.includes("--links")) {
    for (const [cw, chh, dpr] of IPHONES) for (const sch of ["dark", "light"]) {
      console.log(`<link rel="apple-touch-startup-image" media="(device-width: ${cw}px) and (device-height: ${chh}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${sch})" href="splash/ios-${cw * dpr}x${chh * dpr}-${sch}.png">`);
    }
  }
}
