"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { decodeImage, encodePng } = require("./image-codec");
const { writeContentAddressedIcon } = require("./icon-cache");

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function foregroundGeometry(data, width, height) {
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  let pixelCount = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (data[(y * width + x) * 4 + 3] < 32) continue;
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    pixelCount += 1;
  }
  if (!pixelCount) return { bounds: null, pixelCount: 0, touchesEdge: true };
  const visited = new Uint8Array(width * height);
  const componentSizes = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (visited[pixel] || data[pixel * 4 + 3] < 32) continue;
    let componentSize = 0;
    const pending = [pixel];
    visited[pixel] = 1;
    while (pending.length) {
      const current = pending.pop();
      componentSize += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || data[neighbor * 4 + 3] < 32) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    componentSizes.push(componentSize);
  }
  const largestComponent = Math.max(...componentSizes);
  return {
    bounds: {
      x: minimumX,
      y: minimumY,
      width: maximumX - minimumX + 1,
      height: maximumY - minimumY + 1,
    },
    componentCount: componentSizes.length,
    largestComponentFraction: Number((largestComponent / pixelCount).toFixed(6)),
    pixelCount,
    touchesEdge: minimumX === 0 || minimumY === 0 || maximumX === width - 1 || maximumY === height - 1,
  };
}

function removeUniformBackground(source, width, height) {
  const data = Buffer.from(source);
  const border = [];
  for (let x = 0; x < width; x += 1) { border.push((x * 4), (((height - 1) * width + x) * 4)); }
  for (let y = 1; y + 1 < height; y += 1) { border.push((y * width * 4), ((y * width + width - 1) * 4)); }
  const background = [0, 1, 2].map((channel) => border.reduce((sum, offset) => sum + data[offset + channel], 0) / Math.max(1, border.length));
  const borderVariance = border.reduce((sum, offset) => sum + Math.sqrt((data[offset] - background[0]) ** 2 + (data[offset + 1] - background[1]) ** 2 + (data[offset + 2] - background[2]) ** 2), 0) / Math.max(1, border.length);
  if (borderVariance > 18) return { data, applied: false, background: null, foreground: null };
  const distances = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    distances.push(Math.sqrt((data[offset] - background[0]) ** 2 + (data[offset + 1] - background[1]) ** 2 + (data[offset + 2] - background[2]) ** 2));
  }
  const foregroundFraction = distances.filter((distance) => distance > 32).length / distances.length;
  if (foregroundFraction < 0.04 || foregroundFraction > 0.92) return { data, applied: false, background: null, foreground: null };
  distances.forEach((distance, pixel) => {
    const offset = pixel * 4;
    const mask = clamp((distance - 10) / 38, 0, 1);
    data[offset + 3] = Math.round(data[offset + 3] * mask);
  });
  return {
    data,
    applied: true,
    background: background.map((channel) => Math.round(channel)),
    foreground: foregroundGeometry(data, width, height),
  };
}

function cropScreenshot(screenshotBody, target) {
  const image = decodeImage(screenshotBody, target.mimeType || "image/png");
  const viewportWidth = Number(target.viewport?.width);
  const viewportHeight = Number(target.viewport?.height);
  const rawBounds = target.bounds || {};
  const inset = Math.max(0, Math.min(Number(rawBounds.width), Number(rawBounds.height)) * Number(target.insetRatio || 0));
  const bounds = { x: Number(rawBounds.x) + inset, y: Number(rawBounds.y) + inset, width: Number(rawBounds.width) - inset * 2, height: Number(rawBounds.height) - inset * 2 };
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) throw new Error("screenshot viewport dimensions are required");
  const scaleX = image.width / viewportWidth;
  const scaleY = image.height / viewportHeight;
  const x = clamp(Math.round(Number(bounds.x) * scaleX), 0, image.width);
  const y = clamp(Math.round(Number(bounds.y) * scaleY), 0, image.height);
  const right = clamp(Math.round((Number(bounds.x) + Number(bounds.width)) * scaleX), x, image.width);
  const bottom = clamp(Math.round((Number(bounds.y) + Number(bounds.height)) * scaleY), y, image.height);
  const width = right - x;
  const height = bottom - y;
  if (width < 1 || height < 1) throw new Error("runtime screenshot bounds are empty or outside the viewport");
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * image.width + x) * 4;
    image.data.copy(data, row * width * 4, sourceStart, sourceStart + width * 4);
  }
  const normalized = removeUniformBackground(data, width, height);
  return {
    png: encodePng({ width, height, data: normalized.data }),
    observedItemId: String(target.observedItemId),
    pixelCrop: { x, y, width, height },
    scale: { x: scaleX, y: scaleY, devicePixelRatio: Number(target.devicePixelRatio || scaleX) },
    backgroundRemoval: {
      applied: normalized.applied,
      estimatedRgb: normalized.background,
      foreground: normalized.foreground,
    },
  };
}

function sample(image, width = 32, height = 32) {
  const output = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = clamp(Math.floor((x + 0.5) * image.width / width), 0, image.width - 1);
    const sourceY = clamp(Math.floor((y + 0.5) * image.height / height), 0, image.height - 1);
    const source = (sourceY * image.width + sourceX) * 4;
    const target = (y * width + x) * 4;
    const alpha = image.data[source + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) output[target + channel] = image.data[source + channel] * alpha;
    output[target + 3] = image.data[source + 3];
  }
  return output;
}

function luminance(rgba, pixel) {
  const offset = pixel * 4;
  return rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
}

function perceptualBits(image) {
  const pixels = sample(image, 9, 8);
  const bits = [];
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits.push(luminance(pixels, y * 9 + x) <= luminance(pixels, y * 9 + x + 1) ? 1 : 0);
  return bits;
}

function bitSimilarity(left, right) {
  let equal = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] === right[index]) equal += 1;
  return equal / left.length;
}

function structureSimilarity(left, right) {
  const a = sample(left, 32, 32);
  const b = sample(right, 32, 32);
  let difference = 0;
  for (let pixel = 0; pixel < 1024; pixel += 1) difference += Math.abs(luminance(a, pixel) - luminance(b, pixel)) / 255;
  return clamp(1 - difference / 1024, 0, 1);
}

function colorHistogram(image) {
  const pixels = sample(image, 32, 32);
  const histogram = new Float64Array(64);
  for (let pixel = 0; pixel < 1024; pixel += 1) {
    const offset = pixel * 4;
    const bin = Math.min(3, Math.floor(pixels[offset] / 64)) * 16 + Math.min(3, Math.floor(pixels[offset + 1] / 64)) * 4 + Math.min(3, Math.floor(pixels[offset + 2] / 64));
    histogram[bin] += pixels[offset + 3] / 255;
  }
  const total = histogram.reduce((sum, value) => sum + value, 0) || 1;
  return histogram.map((value) => value / total);
}

function histogramSimilarity(left, right) {
  let intersection = 0;
  for (let index = 0; index < left.length; index += 1) intersection += Math.min(left[index], right[index]);
  return clamp(intersection, 0, 1);
}

function contourSimilarity(left, right) {
  const a = sample(left, 32, 32);
  const b = sample(right, 32, 32);
  let intersection = 0, union = 0;
  for (let pixel = 0; pixel < 1024; pixel += 1) {
    const presentA = a[pixel * 4 + 3] >= 128;
    const presentB = b[pixel * 4 + 3] >= 128;
    if (presentA && presentB) intersection += 1;
    if (presentA || presentB) union += 1;
  }
  return union ? intersection / union : 1;
}

function compareIcons(leftBody, rightBody, leftMimeType = "image/png", rightMimeType = "image/png") {
  const leftBytes = Buffer.from(leftBody);
  const rightBytes = Buffer.from(rightBody);
  const left = decodeImage(leftBytes, leftMimeType);
  const right = decodeImage(rightBytes, rightMimeType);
  const metrics = {
    perceptualHash: bitSimilarity(perceptualBits(left), perceptualBits(right)),
    structure: structureSimilarity(left, right),
    colorHistogram: histogramSimilarity(colorHistogram(left), colorHistogram(right)),
    transparentContour: contourSimilarity(left, right),
  };
  const composite = metrics.perceptualHash * 0.3 + metrics.structure * 0.3 + metrics.colorHistogram * 0.3 + metrics.transparentContour * 0.1;
  return {
    exactMatch: leftBytes.length === rightBytes.length && crypto.timingSafeEqual(crypto.createHash("sha256").update(leftBytes).digest(), crypto.createHash("sha256").update(rightBytes).digest()),
    composite: Number(composite.toFixed(6)),
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number(value.toFixed(6))])),
  };
}

function chooseStableFrame(frames) {
  if (!Array.isArray(frames) || !frames.length) throw new Error("at least one screenshot frame is required");
  const hashes = frames.map((frame) => crypto.createHash("sha256").update(frame).digest("hex"));
  const groups = new Map();
  hashes.forEach((hash, index) => groups.set(hash, [...(groups.get(hash) || []), index]));
  const majority = [...groups.values()].sort((left, right) => right.length - left.length || left[0] - right[0])[0];
  if (majority.length > 1) return { index: majority[0], acceptedFrameIndexes: majority, rejectedFrameIndexes: frames.map((_, index) => index).filter((index) => !majority.includes(index)), reason: "exact-majority" };
  const totals = frames.map((frame, index) => frames.reduce((sum, candidate, candidateIndex) => sum + (index === candidateIndex ? 1 : compareIcons(frame, candidate).composite), 0));
  const index = totals.indexOf(Math.max(...totals));
  const similarities = frames.map((frame) => compareIcons(frames[index], frame).composite);
  const acceptedFrameIndexes = similarities.map((similarity, frameIndex) => ({ similarity, frameIndex })).filter(({ similarity }) => similarity >= 0.82).map(({ frameIndex }) => frameIndex);
  return { index, acceptedFrameIndexes, rejectedFrameIndexes: frames.map((_, frameIndex) => frameIndex).filter((frameIndex) => !acceptedFrameIndexes.includes(frameIndex)), reason: "similarity-medoid", similarities };
}

function processScreenshotFrames({ frames, targets, cacheDir, comparisonCandidates = [] }) {
  if (frames.length !== targets.length) throw new Error("screenshot frames and runtime targets must have equal length");
  const crops = frames.map((frame, index) => cropScreenshot(Buffer.from(frame), targets[index]));
  const stable = chooseStableFrame(crops.map((crop) => crop.png));
  const chosen = crops[stable.index];
  const cached = writeContentAddressedIcon(chosen.png, cacheDir);
  const decoded = decodeImage(chosen.png, "image/png");
  const comparisons = comparisonCandidates.filter((candidate) => candidate.filePath && fs.existsSync(candidate.filePath)).map((candidate) => ({
    candidateId: candidate.id, assetHash: candidate.assetHash, ...compareIcons(chosen.png, fs.readFileSync(candidate.filePath), "image/png", candidate.mimeType),
  })).sort((left, right) => right.composite - left.composite || Number(left.candidateId) - Number(right.candidateId));
  return {
    asset: { ...cached, mimeType: "image/png", width: decoded.width, height: decoded.height },
    crop: { ...targets[stable.index], pixelCrop: chosen.pixelCrop, scale: chosen.scale, backgroundRemoval: chosen.backgroundRemoval },
    similarity: {
      frameSelection: { ...stable, frameHashes: crops.map((crop) => crypto.createHash("sha256").update(crop.png).digest("hex")) },
      comparisons,
    },
  };
}

module.exports = { cropScreenshot, removeUniformBackground, compareIcons, chooseStableFrame, processScreenshotFrames };
