const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");

const TONES = {
  focus: "#C0791B",
  short: "#3D9691",
  long: "#7587C1",
  paused: "#8C8884"
};

const DIALS = {
  16: { ring: [5, 7], wedge: 4, bars: [2, 6, 2] },
  24: { ring: [8, 11], wedge: 6, bars: [3, 10, 2] },
  32: { ring: [11, 15], wedge: 9, bars: [4, 12, 4] },
  48: { ring: [16.5, 21], wedge: 13.5, fillet: 1.125 },
  128: { ring: [44, 56], wedge: 36, fillet: 3 }
};

const TOOLBAR_SIZES = [16, 24, 32];

const ICONS = [
  ...[16, 32, 48, 128].map((size) => ({ file: `icons/icon${size}.png`, size, state: "focus" })),
  ...Object.keys(TONES).flatMap((state) =>
    TOOLBAR_SIZES.map((size) => ({ file: `icons/toolbar/${state}-${size}.png`, size, state }))
  )
];

const BACKDROPS = ["#FFFFFF", "#F1F3F4", "#3C3C3C", "#202124"];

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function inWedge(x, y, r, fillet) {
  if (Math.hypot(x, y) > r || (x > 0 && y < 0)) return false;
  if (!fillet) return true;
  const [u, v] = y < -x ? [-y, -x] : [x, y];
  const t = Math.sqrt((r - fillet) ** 2 - fillet ** 2);
  return !(u > t && v * t < fillet * u && Math.hypot(u - t, v - fillet) > fillet);
}

function inBars(x, y, [width, height, gap]) {
  const round = width / 4;
  const qx = Math.abs(Math.abs(x) - (gap + width) / 2) - (width / 2 - round);
  const qy = Math.abs(y) - (height / 2 - round);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= round;
}

function inDial(dial, paused, x, y) {
  const d = Math.hypot(x, y);
  if (d >= dial.ring[0] && d <= dial.ring[1]) return true;
  return paused ? inBars(x, y, dial.bars) : inWedge(x, y, dial.wedge, dial.fillet);
}

function coverage(size, paused) {
  const dial = DIALS[size];
  const ss = size <= 32 ? 16 : 8;
  const mid = size / 2;
  const cov = new Float64Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (inDial(dial, paused, px + (sx + 0.5) / ss - mid, py + (sy + 0.5) / ss - mid)) hits++;
        }
      }
      cov[py * size + px] = hits / (ss * ss);
    }
  }
  return cov;
}

function paint(cov, tone) {
  const [r, g, b] = rgb(tone);
  const rgba = Buffer.alloc(cov.length * 4);
  cov.forEach((c, i) => {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = Math.round(c * 255);
  });
  return rgba;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function contactSheet(rendered) {
  const byFile = new Map(rendered.map((icon) => [icon.file, icon]));
  const rows = [
    ...Object.keys(TONES).map((state) => TOOLBAR_SIZES.map((size) => byFile.get(`icons/toolbar/${state}-${size}.png`))),
    [48, 128].map((size) => byFile.get(`icons/icon${size}.png`))
  ];
  const pad = 16;
  const box = 128;
  const strip = 48;
  const cellW = pad + 3 * (box + pad) + strip + pad;
  const cellH = box + pad * 2;
  const width = cellW * BACKDROPS.length;
  const height = cellH * rows.length;
  const sheet = Buffer.alloc(width * height * 4, 255);
  const put = (x, y, color) => color.forEach((v, k) => { sheet[(y * width + x) * 4 + k] = v; });
  rows.forEach((icons, row) => {
    BACKDROPS.forEach((hex, col) => {
      const bg = rgb(hex);
      const x0 = col * cellW;
      const y0 = row * cellH;
      for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) put(x0 + x, y0 + y, bg);
      let stripY = y0 + pad;
      icons.forEach(({ size, rgba }, slot) => {
        const zoom = Math.max(1, Math.floor(box / size));
        const sample = (sx, sy) => {
          const i = (sy * size + sx) * 4;
          const a = rgba[i + 3] / 255;
          return bg.map((v, k) => Math.round(rgba[i + k] * a + v * (1 - a)));
        };
        const bx = x0 + pad + slot * (box + pad);
        for (let y = 0; y < size * zoom; y++) {
          for (let x = 0; x < size * zoom; x++) put(bx + x, y0 + pad + y, sample(Math.floor(x / zoom), Math.floor(y / zoom)));
        }
        if (zoom === 1) return;
        const sx0 = x0 + pad + 3 * (box + pad);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(sx0 + x, stripY + y, sample(x, y));
        stripY += size + 8;
      });
    });
  });
  return encodePNG(width, height, sheet);
}

const rendered = ICONS.map((icon) => ({
  ...icon,
  rgba: paint(coverage(icon.size, icon.state === "paused"), TONES[icon.state])
}));

for (const { file, size, rgba } of rendered) {
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = encodePNG(size, size, rgba);
  fs.writeFileSync(out, png);
  console.log(`${file}  ${size}px  ${png.length} bytes`);
}

const sheetArg = process.argv.indexOf("--sheet");
if (sheetArg !== -1 && process.argv[sheetArg + 1]) {
  const sheetPath = path.resolve(process.argv[sheetArg + 1]);
  fs.mkdirSync(path.dirname(sheetPath), { recursive: true });
  fs.writeFileSync(sheetPath, contactSheet(rendered));
  console.log(`contact sheet  ${sheetPath}`);
}
