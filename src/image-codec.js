"use strict";

const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");

function decodeImage(buffer, mimeType = "") {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const pngSignature = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (pngSignature || /png/i.test(mimeType)) {
    const image = PNG.sync.read(bytes);
    return { width: image.width, height: image.height, data: Buffer.from(image.data) };
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xd8) || /jpe?g/i.test(mimeType)) {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: image.width, height: image.height, data: Buffer.from(image.data) };
  }
  throw new Error(`unsupported icon image MIME: ${mimeType || "unknown"}`);
}

function encodePng(image) {
  const output = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data).copy(output.data);
  return PNG.sync.write(output, { colorType: 6 });
}

module.exports = { decodeImage, encodePng };
