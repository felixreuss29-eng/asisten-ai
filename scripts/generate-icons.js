"use strict";

/* Generator ikon PNG 192 & 512 tanpa dependency.
 * Jalankan: node scripts/generate-icons.js */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const panjang = Buffer.alloc(4);
  panjang.writeUInt32BE(data.length, 0);
  const nama = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([nama, data])), 0);
  return Buffer.concat([panjang, nama, data, crc]);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

function buatPng(size) {
  const baris = size * 4 + 1; // 1 byte filter per baris
  const raw = Buffer.alloc(baris * size);
  const s = size;

  for (let y = 0; y < s; y += 1) {
    const offset = y * baris;
    raw[offset] = 0; // filter None
    for (let x = 0; x < s; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = clamp((px / s) * 0.45 + (py / s) * 0.55, 0, 1);

      // Latar gradien ungu -> biru.
      let r = Math.round(99 + (34 - 99) * t);
      let g = Math.round(102 + (211 - 102) * t);
      let b = Math.round(241 + (238 - 241) * t);

      // Bentuk mikrofon putih.
      const badan = sdRoundRect(px, py, s * 0.5, s * 0.44, s * 0.09, s * 0.16, s * 0.09);
      const garis = sdRoundRect(px, py, s * 0.5, s * 0.76, s * 0.018, s * 0.06, s * 0.018);
      const alas = sdRoundRect(px, py, s * 0.5, s * 0.83, s * 0.115, s * 0.02, s * 0.02);
      const jariJari = Math.hypot(px - s * 0.5, py - s * 0.57);
      const busur = Math.abs(jariJari - s * 0.155) - s * 0.018;
      const bawah = py >= s * 0.57 ? busur : Infinity;
      const jarak = Math.min(badan, garis, alas, bawah);
      const alpha = clamp(0.5 - jarak, 0, 1);

      r = Math.round(r * (1 - alpha) + 255 * alpha);
      g = Math.round(g * (1 - alpha) + 255 * alpha);
      b = Math.round(b * (1 - alpha) + 255 * alpha);

      const i = offset + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const folder = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(folder, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(folder, `icon-${size}.png`);
  fs.writeFileSync(file, buatPng(size));
  console.log(`Ikon dibuat: ${file} (${size}x${size})`);
}
