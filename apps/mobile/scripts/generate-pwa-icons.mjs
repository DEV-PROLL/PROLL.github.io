import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(projectRoot, "public");

const outputs = [
  { file: "icon-180.png", size: 180, maskable: false },
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

await mkdir(publicDir, { recursive: true });

for (const output of outputs) {
  const png = renderIcon(output.size, output.maskable);
  await writeFile(join(publicDir, output.file), png);
}

function renderIcon(size, maskable) {
  const image = new Uint8Array(size * size * 4);
  fillRoundedRect(image, size, 0, 0, size, size, maskable ? 72 : 104, "#0d1117");
  fillRoundedRect(image, size, 54, 54, 404, 404, 92, "#121820");
  strokeRoundedRect(image, size, 54, 54, 404, 404, 92, 10, "#26313d");
  fillRoundedRect(image, size, 122, 122, 268, 268, 42, "#f0c78e");
  fillRect(image, size, 122, 122, 268, 94, "#8a6747");
  fillRect(image, size, 122, 122, 268, 38, "#a98255");
  fillRect(image, size, 177, 243, 34, 54, "#111820");
  fillRect(image, size, 301, 243, 34, 54, "#111820");
  fillRect(image, size, 122, 340, 268, 50, "#d8ad74");
  fillCircle(image, size, 370, 372, 30, "#3fb950");
  return encodePng(size, size, image);
}

function fillRect(image, size, x, y, width, height, color) {
  const [r, g, b, a] = rgba(color);
  const x0 = scale(x, size);
  const y0 = scale(y, size);
  const x1 = scale(x + width, size);
  const y1 = scale(y + height, size);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      setPixel(image, size, px, py, r, g, b, a);
    }
  }
}

function fillCircle(image, size, cx, cy, radius, color) {
  const [r, g, b, a] = rgba(color);
  const sx = scale(cx, size);
  const sy = scale(cy, size);
  const sr = scale(radius, size);
  const r2 = sr * sr;
  for (let py = sy - sr; py <= sy + sr; py += 1) {
    for (let px = sx - sr; px <= sx + sr; px += 1) {
      const dx = px - sx;
      const dy = py - sy;
      if (dx * dx + dy * dy <= r2) {
        setPixel(image, size, px, py, r, g, b, a);
      }
    }
  }
}

function fillRoundedRect(image, size, x, y, width, height, radius, color) {
  const [r, g, b, a] = rgba(color);
  drawRoundedRect(image, size, x, y, width, height, radius, (px, py) => {
    setPixel(image, size, px, py, r, g, b, a);
  });
}

function strokeRoundedRect(image, size, x, y, width, height, radius, stroke, color) {
  const [r, g, b, a] = rgba(color);
  drawRoundedRect(image, size, x, y, width, height, radius, (px, py, sourceX, sourceY) => {
    const insideInner = inRoundedRect(
      sourceX,
      sourceY,
      x + stroke,
      y + stroke,
      width - stroke * 2,
      height - stroke * 2,
      Math.max(0, radius - stroke),
    );
    if (!insideInner) setPixel(image, size, px, py, r, g, b, a);
  });
}

function drawRoundedRect(image, size, x, y, width, height, radius, draw) {
  const x0 = scale(x, size);
  const y0 = scale(y, size);
  const x1 = scale(x + width, size);
  const y1 = scale(y + height, size);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const sourceX = (px / size) * 512;
      const sourceY = (py / size) * 512;
      if (inRoundedRect(sourceX, sourceY, x, y, width, height, radius)) {
        draw(px, py, sourceX, sourceY);
      }
    }
  }
}

function inRoundedRect(px, py, x, y, width, height, radius) {
  const right = x + width;
  const bottom = y + height;
  const innerLeft = x + radius;
  const innerRight = right - radius;
  const innerTop = y + radius;
  const innerBottom = bottom - radius;
  const nearestX = Math.max(innerLeft, Math.min(px, innerRight));
  const nearestY = Math.max(innerTop, Math.min(py, innerBottom));
  const dx = px - nearestX;
  const dy = py - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function setPixel(image, size, x, y, r, g, b, a) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const index = (y * size + x) * 4;
  image[index] = r;
  image[index + 1] = g;
  image[index + 2] = b;
  image[index + 3] = a;
}

function scale(value, size) {
  return Math.round((value / 512) * size);
}

function rgba(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

function encodePng(width, height, rgbaData) {
  const rowLength = width * 4 + 1;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
    Buffer.from(rgbaData.buffer, y * width * 4, width * 4).copy(
      raw,
      y * rowLength + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([
    uint32(data.length),
    payload,
    uint32(crc32(payload)),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
