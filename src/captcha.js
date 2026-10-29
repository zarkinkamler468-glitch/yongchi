'use strict';

const { randomInt } = require('node:crypto');
const { deflateSync } = require('node:zlib');

// 栅格化后只公开 PNG 像素，不公开按数字分组的几何结构或文字。
const GLYPHS = {
  2: ['01110','10001','00001','00010','00100','01000','11111'],
  3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'],
  7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'],
  9: ['01110','10001','10001','01111','00001','00001','01110']
};
function chunk(type, data) {
  const name = Buffer.from(type);
  const input = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, input, tail]);
}
function captchaPng(code) {
  const width = 180, height = 52, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 248);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  const dot = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const at = y * stride + 1 + x * 3;
      pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2];
    }
  };
  for (let i = 0; i < code.length; i++) {
    const glyph = GLYPHS[code[i]];
    const left = 10 + i * 27 + randomInt(-2, 3), top = randomInt(8, 15);
    const skew = randomInt(-4, 5) / 10, phase = randomInt(0, 7);
    const color = [randomInt(25, 100), randomInt(30, 100), randomInt(50, 145)];
    for (let y = 0; y < 28; y++) for (let x = 0; x < 20; x++) {
      if (glyph[Math.floor(y / 4)][Math.floor(x / 4)] === '1') dot(left + x + skew * (y - 14) + 1.8 * Math.sin(y / 6 + phase), top + y, color);
    }
  }
  for (let i = 0; i < 3; i++) {
    const y = randomInt(8, 43), phase = randomInt(0, 7);
    for (let x = 0; x < width; x++) dot(x, y + 4 * Math.sin(x / 15 + phase), [130, 145, 160]);
  }
  for (let i = 0; i < 180; i++) dot(randomInt(width), randomInt(height), [170, 180, 190]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { captchaPng };
