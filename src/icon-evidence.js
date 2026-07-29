"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { PNG } = require("pngjs");
const { canonicalJson } = require("./canonical-json");
const { decodeImage } = require("./image-codec");
const { writeContentAddressedIcon } = require("./icon-cache");

const ICON_RECONSTRUCTION_VERSION = 2;

function cleanupUncommittedAsset(database, asset) {
  if (!asset?.filePath || database.getIconAsset(asset.hash)) return;
  try {
    fs.unlinkSync(asset.filePath);
  } catch (_) {
    // The database transaction remains authoritative if cleanup races with a cache reader.
  }
}

function runIconWorker(
  input,
  signal = null,
  createWorker = (...args) => new Worker(...args),
) {
  return new Promise((resolve, reject) => {
    const { signal: _signal, ...workerData } = input;
    const worker = createWorker(
      path.join(__dirname, "icon-image-worker.js"),
      { workerData },
    );
    let settled = false;
    let terminating = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      if (settled || terminating) return;
      terminating = true;
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("icon image worker aborted"), {
          name: "AbortError",
        });
      Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => undefined)
        .then(() => finish(reject, reason));
    };
    worker.once("message", (message) => {
      if (terminating) return;
      if (message?.error) {
        finish(
          reject,
          Object.assign(new Error(message.error.message), {
            stack: message.error.stack,
          }),
        );
        return;
      }
      finish(resolve, message);
    });
    worker.once("error", (error) => {
      if (!terminating) finish(reject, error);
    });
    worker.once("exit", (code) => {
      if (!terminating && code !== 0) {
        finish(reject, new Error(`icon image worker exited with code ${code}`));
      }
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pixelCopy(source, sourceWidth, sourceX, sourceY, target, targetWidth, targetX, targetY) {
  const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
  const targetOffset = (targetY * targetWidth + targetX) * 4;
  source.copy(target, targetOffset, sourceOffset, sourceOffset + 4);
}

function reconstructIcon(resourceBody, metadata) {
  const image = decodeImage(resourceBody, metadata.mimeType);
  const rect = metadata.rect || { x: 0, y: 0, width: image.width, height: image.height };
  const x = Math.round(Number(rect.x));
  const width = Math.round(Number(rect.width));
  const height = Math.round(Number(rect.height));
  const clockwise = metadata.rotation === 90 || metadata.rotation === "clockwise";
  const counterRotated = !clockwise && (metadata.rotated === true || metadata.rotation === -90 || metadata.rotation === "counter-clockwise");
  const packedWidth = clockwise || counterRotated ? height : width;
  const packedHeight = clockwise || counterRotated ? width : height;
  const yValue = Math.round(Number(rect.y));
  const y = metadata.yOrigin === "bottom-left" ? image.height - yValue - packedHeight : yValue;
  if (![x, y, packedWidth, packedHeight].every(Number.isInteger) || packedWidth < 1 || packedHeight < 1 || x < 0 || y < 0 || x + packedWidth > image.width || y + packedHeight > image.height) throw new Error("SpriteFrame atlas rectangle is outside the texture");
  const cropped = Buffer.alloc(packedWidth * packedHeight * 4);
  for (let cropY = 0; cropY < packedHeight; cropY += 1) for (let cropX = 0; cropX < packedWidth; cropX += 1) pixelCopy(image.data, image.width, x + cropX, y + cropY, cropped, packedWidth, cropX, cropY);

  let trimmed = cropped, trimmedWidth = packedWidth, trimmedHeight = packedHeight;
  if (clockwise || counterRotated) {
    trimmedWidth = packedHeight;
    trimmedHeight = packedWidth;
    trimmed = Buffer.alloc(trimmedWidth * trimmedHeight * 4);
    for (let sourceY = 0; sourceY < packedHeight; sourceY += 1) for (let sourceX = 0; sourceX < packedWidth; sourceX += 1) {
      const targetX = counterRotated ? sourceY : packedHeight - 1 - sourceY;
      const targetY = counterRotated ? packedWidth - 1 - sourceX : sourceX;
      pixelCopy(cropped, packedWidth, sourceX, sourceY, trimmed, trimmedWidth, targetX, targetY);
    }
  }

  const originalWidth = Math.round(Number(metadata.originalSize?.width ?? trimmedWidth));
  const originalHeight = Math.round(Number(metadata.originalSize?.height ?? trimmedHeight));
  if (!Number.isInteger(originalWidth) || !Number.isInteger(originalHeight) || originalWidth < 1 || originalHeight < 1 || originalWidth > 4096 || originalHeight > 4096) throw new Error("SpriteFrame original size is invalid");
  const offsetX = Number(metadata.offset?.x || 0);
  const offsetY = Number(metadata.offset?.y || 0);
  const left = Math.round((originalWidth - trimmedWidth) / 2 + offsetX);
  const top = Math.round((originalHeight - trimmedHeight) / 2 - offsetY);
  const output = new PNG({ width: originalWidth, height: originalHeight });
  output.data.fill(0);
  for (let sourceY = 0; sourceY < trimmedHeight; sourceY += 1) for (let sourceX = 0; sourceX < trimmedWidth; sourceX += 1) {
    const targetX = left + sourceX, targetY = top + sourceY;
    if (targetX >= 0 && targetY >= 0 && targetX < originalWidth && targetY < originalHeight) pixelCopy(trimmed, trimmedWidth, sourceX, sourceY, output.data, originalWidth, targetX, targetY);
  }
  return PNG.sync.write(output, { colorType: 6 });
}

function buildSpriteFrameExpression(itemIdentity) {
  const identity = typeof itemIdentity === "object" && itemIdentity ? itemIdentity : { itemId: itemIdentity };
  const encoded = JSON.stringify({ itemId: String(identity.itemId), iconResource: identity.iconResourceIdentifier ?? identity.iconResource ?? null });
  return `(() => {
    const identity=${encoded}; const wanted=identity.itemId; const iconResource=identity.iconResource;
    const value=(object,...keys)=>{for(const key of keys){if(object&&object[key]!=null)return object[key];}return null;};
    const size=(object)=>object?{width:Number(value(object,"width","_width")||0),height:Number(value(object,"height","_height")||0)}:null;
    const point=(object)=>object?{x:Number(value(object,"x","_x")||0),y:Number(value(object,"y","_y")||0)}:null;
    if(typeof globalThis.__miniGameCatalogResolveSpriteFrame==="function") return globalThis.__miniGameCatalogResolveSpriteFrame(wanted,iconResource);
    const cc=globalThis.cc||globalThis.GameGlobal?.cc; const root=cc?.director?.getScene?.(); if(!root)return null;
    const sprites=root.getComponentsInChildren?.(cc.Sprite)||[];
    const entry=root.getChildByName?.("Entry")||root.children?.find?.(node=>node?.name==="Entry"); const runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)); const controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController");
    const views=[]; let frontier=[controller?.view].filter(Boolean); for(let depth=0;depth<8&&frontier.length;depth+=1){views.push(...frontier);frontier=frontier.flatMap(view=>Array.isArray(view?.childViews)?view.childViews:[])}
    const itemView=views.find(view=>String(value(view,"itemId","_itemId")??value(value(view,"data","_data"),"itemId","_itemId")??"")===wanted); const itemSprites=itemView?.mNode?.getComponentsInChildren?.(cc.Sprite)||[]; const viewSprite=itemSprites.find(candidate=>(candidate?.spriteFrame||candidate?._spriteFrame)&&/^(icon|item_icon)$/i.test(String(candidate?.node?.name||"")))||itemSprites.find(candidate=>candidate?.spriteFrame||candidate?._spriteFrame);
    const sceneSprite=sprites.find(candidate=>{const node=candidate.node; const lineage=[node,node?.parent,node?.parent?.parent]; const entries=lineage.flatMap(entry=>[entry,...(entry?._components||entry?.components||[])]); const marker=entries.some(entry=>{const data=value(entry,"data","_data","itemData","_itemData","model","_model","config","_config"); return String(value(entry,"itemId","_itemId","itemID","id")??value(data,"itemId","_itemId","itemID","id")??"")===wanted;}); const frame=candidate.spriteFrame||candidate._spriteFrame; const texture=frame?.texture||frame?._texture||frame?._textureSource; const image=value(texture,"image","_image","nativeAsset","_nativeAsset"); const resources=[value(frame,"name","_name"),value(frame,"uuid","_uuid"),value(texture,"uuid","_uuid"),value(texture,"nativeUrl","_nativeUrl"),value(texture,"url","_url"),value(image,"nativeUrl","_nativeUrl"),value(image,"url","_url","src")].filter(Boolean).map(String); return marker||(iconResource!=null&&resources.some(resource=>resource.includes(String(iconResource))||String(iconResource).includes(resource)));});
    const assetStore=cc?.assetManager?.assets; const runtimeAssets=[]; if(assetStore?._map)runtimeAssets.push(...Object.values(assetStore._map)); if(typeof assetStore?.forEach==="function")assetStore.forEach(asset=>runtimeAssets.push(asset));
    const iconName=String(iconResource||"").split(/[\\/]/).filter(Boolean).at(-1)||null; const assetFrame=iconName?runtimeAssets.find(asset=>{const rect=asset?.rect||asset?._rect,texture=asset?.texture||asset?._texture||asset?._textureSource;if(!rect||!texture)return false;const assetName=String(value(asset,"_name","name")||""),wantedResource=String(iconResource).replace(/\\\\/g,"/");if(assetName===iconName)return true;const resources=[value(asset,"_uuid","uuid"),value(texture,"_nativeUrl","nativeUrl"),value(texture,"_url","url")].filter(Boolean).map(resource=>String(resource).replace(/\\\\/g,"/"));return resources.some(resource=>resource===wantedResource||resource.endsWith("/"+wantedResource)||wantedResource.endsWith("/"+resource));}):null;
    const frame=assetFrame||(viewSprite?.spriteFrame||viewSprite?._spriteFrame)||(sceneSprite?.spriteFrame||sceneSprite?._spriteFrame);
    if(frame){
      const texture=frame.texture||frame._texture||frame._textureSource; const image=value(texture,"image","_image","nativeAsset","_nativeAsset","textureSource","_textureSource"); const nativeImage=value(image,"nativeData","_nativeData")||value(texture,"nativeData","_nativeData"); const rect=frame.rect||frame._rect;
      let embeddedUrl=null; try{const width=Number(value(nativeImage,"width","naturalWidth")||value(image,"width","_width")),height=Number(value(nativeImage,"height","naturalHeight")||value(image,"height","_height")),canvas=globalThis.document?.createElement?.("canvas");if(canvas&&nativeImage&&width>0&&height>0){canvas.width=width;canvas.height=height;canvas.getContext?.("2d")?.drawImage?.(nativeImage,0,0);embeddedUrl=canvas.toDataURL?.("image/png")||null}}catch(_){embeddedUrl=null}
      return {runtimeIdentifier:String(value(frame,"_name","name","_uuid","uuid")||wanted),textureUuid:value(texture,"_uuid","uuid"),resourceUrl:embeddedUrl||value(texture,"_nativeUrl","nativeUrl","_url","url")||value(image,"_nativeUrl","nativeUrl","_url","url","src"),mimeType:embeddedUrl?"image/png":value(texture,"_mimeType","mimeType")||value(image,"mimeType","type")||null,rect:rect?{x:Number(rect.x),y:Number(rect.y),width:Number(rect.width),height:Number(rect.height)}:null,rotated:!!value(frame,"_rotated","rotated"),originalSize:size(value(frame,"_originalSize","originalSize")),offset:point(value(frame,"_offset","offset")),yOrigin:value(frame,"_yOrigin","yOrigin")||null};
    } return null;
  })()`;
}

async function resolveCocosSpriteFrame({ client, contextId, itemId, itemIdentity = null, signal = null }) {
  const metadata = await client.evaluate(buildSpriteFrameExpression(itemIdentity || { itemId }), contextId, { signal });
  if (!metadata?.resourceUrl || !metadata?.rect) throw new Error(`SpriteFrame resource not found for item ${itemId}`);
  return metadata;
}

function processIconResource({ resourceBody, metadata, cacheDir }) {
  const output = reconstructIcon(Buffer.from(resourceBody), metadata);
  const decoded = PNG.sync.read(output);
  return { ...writeContentAddressedIcon(output, cacheDir), mimeType: "image/png", width: decoded.width, height: decoded.height };
}

function processIconInWorker(input) {
  return runIconWorker(input, input.signal).then((message) => message.asset);
}

function processScreenshotInWorker(input) {
  return runIconWorker(
    { ...input, operation: "screenshot-frames" },
    input.signal,
  );
}

function buildScreenshotDiscoveryExpression(itemIdentity, token) {
  const identity = typeof itemIdentity === "object" && itemIdentity ? itemIdentity : { itemId: itemIdentity };
  const encoded = JSON.stringify({ itemId: String(identity.itemId) });
  return `(() => {const wanted=${encoded}.itemId,cc=globalThis.cc||globalThis.GameGlobal?.cc,root=cc?.director?.getScene?.();if(!root)return null;const idOf=entry=>entry?.itemId??entry?._itemId??entry?.data?.itemId??entry?._data?.itemId;const entry=root.getChildByName?.("Entry")||root.children?.find?.(node=>node?.name==="Entry");const runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers));const controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController");const boardView=controller?.view?._boardView?._gameBoardView;const gridView=(boardView?._itemLayer?.childViews||[]).find(view=>String(view?._boardGrid?.itemId??"")===wanted&&view?.mNode?.activeInHierarchy!==false);const views=[];let frontier=[controller?.view].filter(Boolean);for(let depth=0;depth<8&&frontier.length;depth+=1){views.push(...frontier);frontier=frontier.flatMap(view=>Array.isArray(view?.childViews)?view.childViews:[])}const controllerItemView=gridView?null:views.find(view=>String(idOf(view)??"")===wanted&&view?.mNode?.activeInHierarchy!==false);const itemSprites=controllerItemView?.mNode?.getComponentsInChildren?.(cc.Sprite)||[];const itemSprite=itemSprites.find(candidate=>candidate?.spriteFrame&&/^(icon|item_icon)$/i.test(String(candidate?.node?.name||"")))||itemSprites.find(candidate=>candidate?.spriteFrame||candidate?._spriteFrame);const sprite=gridView||controllerItemView?null:(root.getComponentsInChildren?.(cc.Sprite)||[]).find(candidate=>[candidate.node,candidate.node?.parent,candidate.node?.parent?.parent].some(node=>[node,...(node?._components||[])].some(entry=>String(idOf(entry)??"")===wanted)));const node=gridView?.mNode||itemSprite?.node||controllerItemView?.mNode||sprite?.node||null;const grid=gridView?._boardGrid;const captureEligibility=gridView&&(!grid?.isNormal||grid?.isLocking||grid?.isFrozen)?"transformed-board-item":"eligible";const slots=globalThis.__miniGameCatalogScreenshotNodes??=(Object.create(null));slots[${JSON.stringify(String(token))}]=node;return node?{observedItemId:wanted,runtimeSource:gridView?"board-item-view":controllerItemView?"controller-item-view":"cocos-sprite-discovery",captureEligibility}:null;})()`;
}

function buildScreenshotTargetExpression(token) {
  return `(() => {const slots=globalThis.__miniGameCatalogScreenshotNodes,node=slots?.[${JSON.stringify(String(token))}];if(slots)delete slots[${JSON.stringify(String(token))}];const cc=globalThis.cc,box=node?.getBoundingBoxToWorld?.()||node?._uiProps?.uiTransformComp?.getBoundingBoxToWorld?.(),visibleSize=cc?.view?.getVisibleSize?.();if(!box||!visibleSize?.width||!visibleSize?.height)return null;const bounds={x:Number(box.x)/visibleSize.width*innerWidth,y:(visibleSize.height-Number(box.y)-Number(box.height))/visibleSize.height*innerHeight,width:Number(box.width)/visibleSize.width*innerWidth,height:Number(box.height)/visibleSize.height*innerHeight},viewport={width:innerWidth,height:innerHeight},opacity=Number(node?.opacity??node?._uiProps?.opacity??255),visible=node?.activeInHierarchy!==false&&node?.active!==false&&opacity>0&&bounds.width>0&&bounds.height>0&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height;return{bounds,viewport,visible,devicePixelRatio:Number(globalThis.devicePixelRatio||1)};})()`;
}

async function resolveScreenshotTarget({ client, contextId, itemId, itemIdentity = null, signal = null }) {
  const hook = await client.evaluate(
    `globalThis.__miniGameCatalogResolveScreenshotTarget?.(${JSON.stringify(String(itemId))})??null`,
    contextId,
    { signal },
  );
  if (hook?.bounds && String(hook.observedItemId) === String(itemId)) {
    const viewport = hook.viewport || await client.evaluate(
      "({width:innerWidth,height:innerHeight})",
      contextId,
      { signal },
    );
    return { ...hook, viewport, visible: hook.visible === true };
  }
  const token = crypto.randomUUID();
  const discovery = await client.evaluate(buildScreenshotDiscoveryExpression(itemIdentity || { itemId }, token), contextId, { signal });
  const bounds = await client.evaluate(buildScreenshotTargetExpression(token), contextId, { signal });
  const target = discovery && bounds ? { ...discovery, ...bounds } : null;
  if (!target?.bounds || String(target.observedItemId) !== String(itemId)) throw new Error(`runtime screenshot bounds not found for item ${itemId}`);
  return target;
}

async function captureCdpScreenshot({ client, signal = null }) {
  await client.send("Page.enable", {}, client.timeoutMs, signal);
  const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, client.timeoutMs, signal);
  if (!result?.data) throw new Error("CDP screenshot body is empty");
  return Buffer.from(result.data, "base64");
}

function flattenResourceTree(frameTree, output = []) {
  if (!frameTree) return output;
  const frameId = frameTree.frame?.id;
  for (const resource of frameTree.resources || []) output.push({ ...resource, frameId });
  for (const child of frameTree.childFrames || []) flattenResourceTree(child, output);
  return output;
}

async function readCdpResource({ client, resourceUrl, mimeType, signal = null }) {
  if (/^data:/i.test(resourceUrl)) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(resourceUrl);
    if (!match) throw new Error("invalid data URL icon resource");
    return { body: match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])), mimeType: match[1] || mimeType, resolvedUrl: resourceUrl };
  }
  await client.send("Page.enable", {}, client.timeoutMs, signal);
  const tree = await client.send("Page.getResourceTree", {}, client.timeoutMs, signal);
  const resources = flattenResourceTree(tree.frameTree);
  const decodedUrl = decodeURIComponent(resourceUrl);
  const resource = resources.find((entry) => entry.url === resourceUrl)
    || resources.find((entry) => decodeURIComponent(entry.url || "") === decodedUrl)
    || resources.find((entry) => decodeURIComponent(entry.url || "").endsWith(decodedUrl.replace(/^\.?\//, "/")));
  if (!resource) throw new Error(`CDP resource not loaded: ${resourceUrl}`);
  const content = await client.send("Page.getResourceContent", { frameId: resource.frameId, url: resource.url }, client.timeoutMs, signal);
  return { body: Buffer.from(content.content || "", content.base64Encoded ? "base64" : "utf8"), mimeType: resource.mimeType || mimeType || "application/octet-stream", resolvedUrl: resource.url };
}

const DEFAULT_STAGE_DEADLINES = Object.freeze({
  resolve: 5_000,
  download: 15_000,
  screenshotTarget: 3_000,
  screenshotCapture: 10_000,
  process: 30_000,
  commit: 5_000,
});

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(numeric) ? Math.floor(numeric) : fallback),
  );
}

function screenshotTargetVisibility(target, itemId) {
  const bounds = target?.bounds;
  const viewport = target?.viewport;
  const values = [
    bounds?.x,
    bounds?.y,
    bounds?.width,
    bounds?.height,
    viewport?.width,
    viewport?.height,
  ].map(Number);
  if (
    String(target?.observedItemId) !== String(itemId)
    || target?.visible !== true
    || !values.every(Number.isFinite)
  ) {
    return false;
  }
  const [x, y, width, height, viewportWidth, viewportHeight] = values;
  return width > 0
    && height > 0
    && viewportWidth > 0
    && viewportHeight > 0
    && x >= 0
    && y >= 0
    && x + width <= viewportWidth
    && y + height <= viewportHeight;
}

function screenshotTargetError(itemId) {
  const error = new Error(`runtime screenshot target is not reliably visible for item ${itemId}`);
  error.code = "ICON_SCREENSHOT_TARGET_NOT_VISIBLE";
  error.reason = "screenshot-target-not-visible";
  return error;
}

class IconEvidenceService {
  constructor({
    database,
    cacheDir,
    concurrency = 2,
    offlineConcurrency = concurrency,
    queueLimit = 100,
    hardQueueLimit = 1000,
    stageDeadlines = {},
    resolveSpriteFrame = resolveCocosSpriteFrame,
    readResource = readCdpResource,
    processImage = processIconInWorker,
    resolveScreenshotBounds = resolveScreenshotTarget,
    captureScreenshot = captureCdpScreenshot,
    processScreenshot = processScreenshotInWorker,
    screenshotFrameCount = 3,
    screenshotFrameDelayMs = 60,
    onEvent = null,
    isSafeBoundary = null,
    withRuntimeBoundary = null,
  }) {
    if (!database) throw new TypeError("database is required");
    this.database = database;
    this.cacheDir = path.resolve(String(cacheDir));
    this.runtimeConcurrency = 1;
    this.offlineConcurrency = boundedInteger(offlineConcurrency, 2, 1, 4);
    this.concurrency = this.offlineConcurrency;
    this.softQueueLimit = boundedInteger(queueLimit, 100, 1, 1000);
    this.hardQueueLimit = boundedInteger(
      hardQueueLimit,
      1000,
      this.softQueueLimit,
      1000,
    );
    this.queueLimit = this.softQueueLimit;
    this.stageDeadlines = {
      ...DEFAULT_STAGE_DEADLINES,
      ...Object.fromEntries(
        Object.entries(stageDeadlines || {}).map(([stage, deadline]) => [
          stage,
          boundedInteger(deadline, DEFAULT_STAGE_DEADLINES[stage] || 30_000, 1, 300_000),
        ]),
      ),
    };
    this.resolveSpriteFrame = resolveSpriteFrame;
    this.readResource = readResource;
    this.processImage = processImage;
    this.resolveScreenshotBounds = resolveScreenshotBounds;
    this.captureScreenshot = captureScreenshot;
    this.processScreenshot = processScreenshot;
    this.screenshotFrameCount = boundedInteger(screenshotFrameCount, 3, 3, 7);
    this.screenshotFrameDelayMs = boundedInteger(screenshotFrameDelayMs, 0, 0, 500);
    this.onEvent = onEvent;
    this.isSafeBoundary = typeof isSafeBoundary === "function" ? isSafeBoundary : () => true;
    this.withRuntimeBoundary = typeof withRuntimeBoundary === "function"
      ? withRuntimeBoundary
      : null;
    this.runtimeBoundaryOwner = null;
    this.runtimeQueues = new Map();
    this.runtimeParentOrder = [];
    this.runtimeParentIndex = 0;
    this.lastRuntimeParentId = null;
    this.activeRuntimeTask = null;
    this.offlinePending = [];
    this.activeOffline = 0;
    this.nextTaskId = 1;
    this.tasks = new Map();
    this.inFlight = new Map();
    this.idleWaiters = [];
    this.runtimeIdleWaiters = [];
    this.boundaryRetryTimer = null;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  request(itemId, runtime = {}) {
    const key = String(itemId);
    const parentTaskId = String(runtime.parentTaskId || `request-${this.nextTaskId}`);
    const existingTaskId = this.inFlight.get(key);
    if (existingTaskId) {
      const existingTask = this.tasks.get(existingTaskId);
      if (runtime.exactResourceOnly === true
        && existingTask?.runtime.exactResourceOnly !== true) {
        if (existingTask?.status === "queued"
          && existingTask.phase === "runtime-queued") {
          existingTask.runtime.exactResourceOnly = true;
        } else {
          const error = new Error(
            `in-flight icon acquisition uses an incompatible provider policy: ${key}`,
          );
          error.code = "ICON_ACQUISITION_POLICY_CONFLICT";
          error.reason = "incompatible-in-flight-provider-policy";
          error.statusCode = 409;
          error.itemId = key;
          error.existingTaskId = existingTaskId;
          throw error;
        }
      }
      existingTask?.subscribers.add(parentTaskId);
      return {
        status: "queued",
        taskId: existingTaskId,
        itemId: key,
        shared: true,
      };
    }
    const occupancy = this.inFlight.size;
    if (occupancy >= this.hardQueueLimit) {
      throw this._queueCapacityError(
        "ICON_ACQUISITION_QUEUE_HARD_LIMIT",
        "queue-hard-capacity",
        this.hardQueueLimit,
      );
    }
    if (occupancy >= this.softQueueLimit && runtime.allowSoftOverflow !== true) {
      throw this._queueCapacityError(
        "ICON_ACQUISITION_QUEUE_SOFT_LIMIT",
        "queue-soft-capacity",
        this.softQueueLimit,
      );
    }

    const id = this.nextTaskId++;
    const task = {
      id,
      itemId: key,
      parentTaskId,
      subscribers: new Set([parentTaskId]),
      runtime: { ...runtime },
      runtimeController: new AbortController(),
      cancelController: new AbortController(),
      status: "queued",
      phase: "runtime-queued",
      stage: "queued",
      reason: null,
      code: null,
      error: null,
      technicalDetails: null,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      timings: [],
      result: null,
    };
    this.tasks.set(task.id, task);
    this.inFlight.set(key, task.id);
    this._enqueueRuntime(task);
    queueMicrotask(() => this._drain());
    return {
      status: "queued",
      taskId: task.id,
      itemId: key,
      shared: false,
    };
  }

  getBatchCapacity(itemIds) {
    const uniqueItemIds = [...new Set(
      (itemIds || []).map((itemId) => String(itemId || "").trim()).filter(Boolean),
    )];
    const shared = uniqueItemIds.filter((itemId) => this.inFlight.has(itemId)).length;
    const required = uniqueItemIds.length - shared;
    const available = Math.max(0, this.softQueueLimit - this.inFlight.size);
    return {
      required,
      available,
      shared,
      limit: this.softQueueLimit,
      admissible: required <= available,
    };
  }

  requestBatch(entries, runtime = {}) {
    const uniqueEntries = [];
    const seen = new Set();
    for (const entry of entries || []) {
      const itemId = String(entry?.itemId || "").trim();
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      uniqueEntries.push({ ...entry, itemId });
    }
    if (runtime.exactResourceOnly === true) {
      for (const entry of uniqueEntries) {
        const existingTaskId = this.inFlight.get(entry.itemId);
        const existingTask = existingTaskId
          ? this.tasks.get(existingTaskId)
          : null;
        if (existingTask
          && existingTask.runtime.exactResourceOnly !== true
          && (existingTask.status !== "queued"
            || existingTask.phase !== "runtime-queued")) {
          const error = new Error(
            `in-flight icon acquisition uses an incompatible provider policy: ${entry.itemId}`,
          );
          error.code = "ICON_ACQUISITION_POLICY_CONFLICT";
          error.reason = "incompatible-in-flight-provider-policy";
          error.statusCode = 409;
          error.itemId = entry.itemId;
          error.existingTaskId = existingTaskId;
          throw error;
        }
      }
    }
    const capacity = this.getBatchCapacity(
      uniqueEntries.map((entry) => entry.itemId),
    );
    if (!capacity.admissible) {
      const error = new Error("icon acquisition queue lacks atomic batch capacity");
      error.code = "ICON_ACQUISITION_QUEUE_FULL";
      error.reason = "queue-capacity";
      error.statusCode = 429;
      error.required = capacity.required;
      error.available = capacity.available;
      error.limit = capacity.limit;
      throw error;
    }

    const requests = [];
    try {
      for (const entry of uniqueEntries) {
        requests.push(this.request(entry.itemId, {
          ...runtime,
          ...(entry.runtime || {}),
          allowSoftOverflow: false,
        }));
      }
      return requests;
    } catch (error) {
      this.rollbackBatch(requests);
      throw error;
    }
  }

  rollbackBatch(requests) {
    let removed = 0;
    for (const request of requests || []) {
      if (request?.shared) continue;
      const task = this.tasks.get(Number(request?.taskId));
      if (!task || task.status !== "queued" || task.phase !== "runtime-queued") {
        continue;
      }
      const queue = this.runtimeQueues.get(task.parentTaskId);
      if (queue) {
        const retained = queue.filter((candidate) => candidate.id !== task.id);
        if (retained.length) {
          this.runtimeQueues.set(task.parentTaskId, retained);
        } else {
          this.runtimeQueues.delete(task.parentTaskId);
          this.runtimeParentOrder = this.runtimeParentOrder.filter(
            (parentTaskId) => parentTaskId !== task.parentTaskId,
          );
        }
      }
      if (this.inFlight.get(task.itemId) === task.id) {
        this.inFlight.delete(task.itemId);
      }
      this.tasks.delete(task.id);
      removed += 1;
    }
    return removed;
  }

  getTask(taskId) {
    const task = this.tasks.get(Number(taskId));
    if (!task) return null;
    return {
      id: task.id,
      taskId: task.id,
      itemId: task.itemId,
      parentTaskId: task.parentTaskId,
      status: task.status,
      phase: task.phase,
      stage: task.stage,
      reason: task.reason,
      code: task.code,
      error: task.error,
      technicalDetails: task.technicalDetails
        ? { ...task.technicalDetails }
        : null,
      requestedAt: task.requestedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      timings: task.timings.map((timing) => ({ ...timing })),
      result: task.result,
      subscriberCount: task.subscribers.size,
    };
  }

  cancelSubscription(taskId, parentTaskId) {
    const task = this.tasks.get(Number(taskId));
    if (!task) return null;
    task.subscribers.delete(String(parentTaskId));
    const result = {
      cancelled: false,
      remainingSubscribers: task.subscribers.size,
      taskId: task.id,
    };
    if (task.subscribers.size || !["queued", "running"].includes(task.status)) {
      return result;
    }

    result.cancelled = true;
    const reason = Object.assign(new Error("icon acquisition subscription cancelled"), {
      name: "AbortError",
      code: "ICON_ACQUISITION_CANCELLED",
    });
    if (task === this.activeRuntimeTask) {
      task.runtimeController.abort(reason);
      task.cancelController.abort(reason);
      return result;
    }
    const runtimeQueue = this.runtimeQueues.get(task.parentTaskId);
    const runtimeIndex = runtimeQueue?.indexOf(task) ?? -1;
    if (runtimeIndex >= 0) {
      runtimeQueue.splice(runtimeIndex, 1);
      if (!runtimeQueue.length) {
        this.runtimeQueues.delete(task.parentTaskId);
        const parentIndex = this.runtimeParentOrder.indexOf(task.parentTaskId);
        if (parentIndex >= 0) this.runtimeParentOrder.splice(parentIndex, 1);
      }
      this._settleError(task, reason);
      this._drain();
      return result;
    }
    const offlineIndex = this.offlinePending.indexOf(task);
    if (offlineIndex >= 0) {
      this.offlinePending.splice(offlineIndex, 1);
      this._settleError(task, reason);
      this._drain();
      return result;
    }
    task.cancelController.abort(reason);
    return result;
  }

  interruptForAutomation() {
    const task = this.activeRuntimeTask;
    if (!task || task.runtimeController.signal.aborted) return 0;
    task.runtimeController.abort(
      Object.assign(new Error("runtime acquisition preempted by automation"), {
        name: "AbortError",
        code: "ICON_ACQUISITION_DEFERRED",
      }),
    );
    return 1;
  }

  notifySafeBoundary() {
    if (this.boundaryRetryTimer) {
      clearTimeout(this.boundaryRetryTimer);
      this.boundaryRetryTimer = null;
    }
    this._drain();
  }

  waitForIdle() {
    if (this._isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  waitForRuntimeIdle() {
    if (!this.activeRuntimeTask) return Promise.resolve();
    return new Promise((resolve) => this.runtimeIdleWaiters.push(resolve));
  }

  _queueCapacityError(code, reason, limit) {
    const error = new Error(`icon acquisition queue reached ${reason}`);
    error.code = code;
    error.reason = reason;
    error.limit = limit;
    error.statusCode = 429;
    return error;
  }

  _enqueueRuntime(task) {
    if (!this.runtimeQueues.has(task.parentTaskId)) {
      this.runtimeQueues.set(task.parentTaskId, []);
      this.runtimeParentOrder.push(task.parentTaskId);
    }
    this.runtimeQueues.get(task.parentTaskId).push(task);
  }

  _takeNextRuntimeTask() {
    while (this.runtimeParentOrder.length) {
      const lastParentIndex = this.runtimeParentOrder.indexOf(
        this.lastRuntimeParentId,
      );
      const index = lastParentIndex >= 0
        ? (lastParentIndex + 1) % this.runtimeParentOrder.length
        : Math.min(this.runtimeParentIndex, this.runtimeParentOrder.length - 1);
      const parentTaskId = this.runtimeParentOrder[index];
      const queue = this.runtimeQueues.get(parentTaskId);
      if (!queue?.length) {
        this.runtimeQueues.delete(parentTaskId);
        this.runtimeParentOrder.splice(index, 1);
        this.runtimeParentIndex = Math.min(
          index,
          Math.max(0, this.runtimeParentOrder.length - 1),
        );
        continue;
      }
      const task = queue.shift();
      this.lastRuntimeParentId = parentTaskId;
      if (!queue.length) {
        this.runtimeQueues.delete(parentTaskId);
        this.runtimeParentOrder.splice(index, 1);
        if (this.runtimeParentIndex >= this.runtimeParentOrder.length) {
          this.runtimeParentIndex = 0;
        }
      } else {
        this.runtimeParentIndex = (index + 1)
          % this.runtimeParentOrder.length;
      }
      return task;
    }
    return null;
  }

  _drain() {
    this._drainRuntime();
    this._drainOffline();
    this._resolveIdleWaiters();
  }

  _drainRuntime() {
    if (this.activeRuntimeTask || !this.runtimeParentOrder.length) return;
    if (!this.isSafeBoundary()) {
      this._markRuntimeBusy();
      this._scheduleBoundaryRetry();
      return;
    }
    const task = this._takeNextRuntimeTask();
    if (!task) return;
    this.activeRuntimeTask = task;
    task.status = "running";
    task.phase = "runtime";
    task.stage = "resolving";
    task.reason = null;
    task.startedAt ||= new Date().toISOString();
    this.onEvent?.({
      type: "icon-acquisition-started",
      itemId: task.itemId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      stage: task.stage,
      phase: task.phase,
    });
    this._prepareRuntime(task)
      .then((prepared) => {
        task.prepared = prepared;
        task.status = "queued";
        task.phase = "offline-queued";
        task.stage = "waiting-for-offline-worker";
        this.offlinePending.push(task);
      })
      .catch((error) => this._settleError(task, error))
      .finally(() => {
        this.activeRuntimeTask = null;
        this.runtimeIdleWaiters.splice(0).forEach((resolve) => resolve());
        this._drain();
      });
  }

  _drainOffline() {
    while (
      this.activeOffline < this.offlineConcurrency
      && this.offlinePending.length
    ) {
      const task = this.offlinePending.shift();
      this.activeOffline += 1;
      task.status = "running";
      task.phase = "offline";
      task.stage = "processing";
      this._processPrepared(task, task.prepared)
        .then((result) => {
          task.status = "complete";
          task.phase = "complete";
          task.stage = "committed";
          task.reason = null;
          task.result = result;
        })
        .catch((error) => this._settleError(task, error))
        .finally(() => {
          delete task.prepared;
          this.activeOffline -= 1;
          this._finishTask(task);
          this._drain();
        });
    }
  }

  _markRuntimeBusy() {
    for (const queue of this.runtimeQueues.values()) {
      for (const task of queue) {
        const changed = task.reason !== "automation-runtime-busy";
        task.status = "queued";
        task.phase = "runtime-queued";
        task.stage = "waiting-for-runtime-slot";
        task.reason = "automation-runtime-busy";
        if (changed) {
          this.onEvent?.({
            type: "icon-acquisition-queued",
            itemId: task.itemId,
            taskId: task.id,
            parentTaskId: task.parentTaskId,
            stage: task.stage,
            reason: task.reason,
          });
        }
      }
    }
  }

  _scheduleBoundaryRetry() {
    if (this.boundaryRetryTimer) return;
    this.boundaryRetryTimer = setTimeout(() => {
      this.boundaryRetryTimer = null;
      this._drain();
    }, 50);
    this.boundaryRetryTimer.unref?.();
  }

  _resolveIdleWaiters() {
    if (!this._isIdle()) return;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  _isIdle() {
    return !this.inFlight.size
      && !this.activeRuntimeTask
      && !this.activeOffline
      && !this.runtimeParentOrder.length
      && !this.offlinePending.length;
  }

  _finishTask(task) {
    task.completedAt ||= new Date().toISOString();
    if (this.inFlight.get(task.itemId) === task.id) {
      this.inFlight.delete(task.itemId);
    }
    while (this.tasks.size > 256) {
      const oldest = this.tasks.entries().next().value;
      if (!oldest || ["queued", "running"].includes(oldest[1].status)) break;
      this.tasks.delete(oldest[0]);
    }
  }

  _settleError(task, error) {
    const cancelled = error?.code === "ICON_ACQUISITION_CANCELLED";
    const deferred = error?.code === "ICON_ACQUISITION_DEFERRED"
      || (error?.name === "AbortError" && task.phase === "runtime");
    task.status = cancelled ? "cancelled" : deferred ? "deferred" : "error";
    task.phase = cancelled ? "cancelled" : deferred ? "deferred" : "failed";
    task.stage = cancelled ? "cancelled" : deferred ? "waiting-for-safe-boundary" : "failed";
    task.error = error?.message || String(error);
    task.code = error?.code || null;
    task.reason = cancelled
      ? "subscriber-cancelled"
      : deferred
      ? error?.reason || "automation-safe-boundary"
      : error?.reason
        || (error?.code === "ICON_ACQUISITION_STAGE_TIMEOUT"
          ? "stage-deadline-exceeded"
          : error?.code || "icon-acquisition-failed");
    task.technicalDetails = {
      message: task.error,
      code: task.code,
      ...(error?.technicalDetails || {}),
    };
    this.onEvent?.({
      type: cancelled
        ? "icon-acquisition-cancelled"
        : deferred
          ? "icon-acquisition-deferred"
          : "icon-acquisition-error",
      itemId: task.itemId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      error: task.error,
      code: task.code,
      reason: task.reason,
      stage: task.stage,
      retryable: deferred,
      technicalDetails: task.technicalDetails,
    });
    if (task !== this.activeRuntimeTask) this._finishTask(task);
    else {
      task.completedAt = new Date().toISOString();
      if (this.inFlight.get(task.itemId) === task.id) {
        this.inFlight.delete(task.itemId);
      }
    }
  }

  async _runStage(task, stage, deadlineKey, runtimeStage, operation) {
    const deadlineMs = this.stageDeadlines[deadlineKey]
      || DEFAULT_STAGE_DEADLINES[deadlineKey]
      || 30_000;
    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const stageController = new AbortController();
    const signals = [
      task.runtime.signal,
      runtimeStage ? task.runtimeController.signal : null,
      task.cancelController.signal,
      stageController.signal,
    ].filter(Boolean);
    const signal = signals.length > 1
      ? AbortSignal.any(signals)
      : signals[0] || stageController.signal;
    task.stage = stage;
    this.onEvent?.({
      type: "icon-acquisition-stage-started",
      itemId: task.itemId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      phase: task.phase,
      stage,
      deadlineMs,
      startedAt,
    });
    let timer;
    let operationPromise = null;
    let status = "succeeded";
    let failure = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`icon acquisition stage ${stage} exceeded ${deadlineMs}ms`);
        error.code = "ICON_ACQUISITION_STAGE_TIMEOUT";
        error.reason = "stage-deadline-exceeded";
        error.technicalDetails = { stage, deadlineMs };
        stageController.abort(error);
        reject(error);
      }, deadlineMs);
    });
    try {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("icon acquisition aborted"), { name: "AbortError" });
      }
      const runOperation = () => operation(signal);
      if (runtimeStage && this.withRuntimeBoundary) {
        const owner = stage === "download-runtime-resource"
          ? "icon-exact-read"
          : stage === "resolve-runtime-resource"
            ? "icon-exact-resolve"
            : `icon-${stage}`;
        operationPromise = Promise.resolve().then(() => this.withRuntimeBoundary(owner, async () => {
          this.runtimeBoundaryOwner = owner;
          try {
            return await runOperation();
          } finally {
            this.runtimeBoundaryOwner = null;
          }
        }));
      } else {
        operationPromise = Promise.resolve().then(runOperation);
      }
      return await Promise.race([operationPromise, timeout]);
    } catch (error) {
      failure = error;
      status = error?.code === "ICON_ACQUISITION_STAGE_TIMEOUT"
        ? "timed-out"
        : "failed";
      if (status === "timed-out" && operationPromise) {
        await operationPromise.then(
          () => undefined,
          () => undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
      const timing = {
        stage,
        deadlineMs,
        startedAt,
        completedAt,
        durationMs: Math.round(durationMs * 1000) / 1000,
        status,
      };
      task.timings.push(timing);
      this.onEvent?.({
        type: "icon-acquisition-stage-complete",
        itemId: task.itemId,
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        phase: task.phase,
        ...timing,
        code: failure?.code || null,
      });
    }
  }

  async _prepareRuntime(task) {
    this._assertSafeBoundary();
    try {
      return await this._prepareExactRuntime(task);
    } catch (exactError) {
      if (exactError.code !== "ICON_EXACT_PROVIDER_UNAVAILABLE") throw exactError;
      if (task.runtime.exactResourceOnly === true) {
        const deferred = new Error(
          `runtime resource is not loaded for item ${task.itemId}`,
        );
        deferred.code = "ICON_ACQUISITION_DEFERRED";
        deferred.reason = "resource-not-loaded";
        deferred.technicalDetails = {
          exactProvider: exactError.message,
          providerPolicy: "loaded-runtime-resource-only",
        };
        throw deferred;
      }
      return this._prepareScreenshotRuntime(task, exactError);
    }
  }

  async _prepareExactRuntime(task) {
    let metadata;
    try {
      metadata = await this._runStage(
        task,
        "resolve-runtime-resource",
        "resolve",
        true,
        async (signal) => {
          const result = await this.resolveSpriteFrame({
            ...task.runtime,
            signal,
            itemId: task.itemId,
          });
          this._assertSafeBoundary();
          if (!result?.resourceUrl) {
            throw new Error(`SpriteFrame resource not found for item ${task.itemId}`);
          }
          return result;
        },
      );
    } catch (error) {
      if (/SpriteFrame resource not found|SpriteFrame mapping/i.test(error.message)) {
        error.code = "ICON_EXACT_PROVIDER_UNAVAILABLE";
      }
      throw error;
    }
    const crop = {
      rect: metadata.rect,
      rotated: !!metadata.rotated,
      rotation: metadata.rotation ?? null,
      originalSize: metadata.originalSize,
      offset: metadata.offset,
      yOrigin: metadata.yOrigin || "top-left",
    };
    const cacheKey = crypto
      .createHash("sha256")
      .update(canonicalJson({
        reconstructionVersion: ICON_RECONSTRUCTION_VERSION,
        resourceUrl: metadata.resourceUrl,
        textureUuid: metadata.textureUuid || null,
        crop,
      }))
      .digest("hex");
    const cached = this.database.findIconAcquisition(cacheKey);
    if (cached && fs.existsSync(cached.filePath)) {
      return { kind: "exact", metadata, crop, cacheKey, cached };
    }
    let resource;
    try {
      resource = await this._runStage(
        task,
        "download-runtime-resource",
        "download",
        true,
        async (signal) => {
          this._assertSafeBoundary();
          const result = await this.readResource({
            ...task.runtime,
            signal,
            resourceUrl: metadata.resourceUrl,
            mimeType: metadata.mimeType,
          });
          this._assertSafeBoundary();
          return result;
        },
      );
    } catch (error) {
      if (/resource (?:not loaded|not found)|not found for item/i.test(error.message)) {
        error.code = "ICON_EXACT_PROVIDER_UNAVAILABLE";
      }
      throw error;
    }
    return { kind: "exact", metadata, crop, cacheKey, resource, cached: null };
  }

  async _prepareScreenshotRuntime(task, exactError) {
    const frames = [];
    const targets = [];
    for (
      let attempt = 0;
      attempt < this.screenshotFrameCount * 2 && frames.length < this.screenshotFrameCount;
      attempt += 1
    ) {
      this._assertSafeBoundary();
      const before = await this._runStage(
        task,
        "locate-screenshot-target",
        "screenshotTarget",
        true,
        (signal) => this.resolveScreenshotBounds({
          ...task.runtime,
          signal,
          itemId: task.itemId,
        }),
      );
      if (!screenshotTargetVisibility(before, task.itemId)) {
        throw screenshotTargetError(task.itemId);
      }
      const body = await this._runStage(
        task,
        "capture-screenshot-frame",
        "screenshotCapture",
        true,
        (signal) => {
          this._assertSafeBoundary();
          return this.captureScreenshot({
            ...task.runtime,
            signal,
            target: before,
          });
        },
      );
      this._assertSafeBoundary();
      const after = await this._runStage(
        task,
        "verify-screenshot-target",
        "screenshotTarget",
        true,
        (signal) => this.resolveScreenshotBounds({
          ...task.runtime,
          signal,
          itemId: task.itemId,
        }),
      );
      if (!screenshotTargetVisibility(after, task.itemId)) {
        throw screenshotTargetError(task.itemId);
      }
      const drift = Math.max(
        ...["x", "y", "width", "height"].map((key) => Math.abs(
          Number(before.bounds[key]) - Number(after.bounds[key]),
        )),
      );
      if (drift > 2) continue;
      frames.push(body);
      targets.push({ ...before, insetRatio: 0.06, mimeType: "image/png" });
      if (this.screenshotFrameDelayMs && frames.length < this.screenshotFrameCount) {
        await new Promise((resolve) => setTimeout(resolve, this.screenshotFrameDelayMs));
      }
    }
    if (frames.length < 3) {
      const error = new Error(
        `stable screenshot frames unavailable after exact provider failed: ${exactError.message}`,
      );
      error.code = "ICON_SCREENSHOT_FRAMES_UNSTABLE";
      error.reason = "screenshot-frames-unstable";
      throw error;
    }
    return { kind: "screenshot", frames, targets, exactError };
  }

  async _processPrepared(task, prepared) {
    if (prepared.kind === "exact") {
      return this._processExactPrepared(task, prepared);
    }
    return this._processScreenshotPrepared(task, prepared);
  }

  async _processExactPrepared(task, prepared) {
    const { metadata, crop, cacheKey, cached, resource } = prepared;
    if (cached) {
      const { candidate, decisionChange } = await this._runStage(
        task,
        "commit-icon-evidence",
        "commit",
        false,
        async () => this.database.saveIconCandidateWithDecision({
          itemId: task.itemId,
          cacheKey,
          sourceType: cached.sourceType,
          resourceUrl: cached.resourceUrl,
          runtimeIdentifier: metadata.runtimeIdentifier || cached.runtimeIdentifier,
          textureUuid: metadata.textureUuid || cached.textureUuid,
          crop,
          rankScore: cached.rankScore ?? 1,
          asset: {
            hash: cached.assetHash,
            mimeType: cached.mimeType,
            width: cached.width,
            height: cached.height,
            byteSize: cached.byteSize,
            filePath: cached.filePath,
          },
        }),
      );
      this._emitComplete(task, candidate, {
        cached: true,
        displayIconRevision: decisionChange?.revision ?? null,
      });
      return { candidate, cached: true };
    }
    const asset = await this._runStage(
      task,
      "process-image-bytes",
      "process",
      false,
      (signal) => this.processImage({
        signal,
        resourceBody: resource.body,
        metadata: {
          ...metadata,
          mimeType: resource.mimeType || metadata.mimeType,
        },
        cacheDir: this.cacheDir,
      }),
    );
    let candidate;
    let decisionChange;
    try {
      ({ candidate, decisionChange } = await this._runStage(
        task,
        "commit-icon-evidence",
        "commit",
        false,
        async () => this.database.saveIconCandidateWithDecision({
          itemId: task.itemId,
          cacheKey,
          sourceType: "cocos-runtime-resource",
          resourceUrl: resource.resolvedUrl || metadata.resourceUrl,
          runtimeIdentifier: metadata.runtimeIdentifier || null,
          textureUuid: metadata.textureUuid || null,
          crop,
          rankScore: 1,
          asset,
        }),
      ));
    } catch (error) {
      cleanupUncommittedAsset(this.database, asset);
      throw error;
    }
    this._emitComplete(task, candidate, {
      cached: false,
      displayIconRevision: decisionChange?.revision ?? null,
    });
    return { candidate, cached: false };
  }

  async _processScreenshotPrepared(task, prepared) {
    const { frames, targets, exactError } = prepared;
    const allCandidates = this.database.listIconCandidates(task.itemId);
    const prioritizedCandidates = [
      ...allCandidates.filter((candidate) => candidate.selected),
      ...allCandidates.slice(-12),
    ];
    const comparisonCandidates = [
      ...new Map(
        prioritizedCandidates.map((candidate) => [candidate.id, candidate]),
      ).values(),
    ].slice(0, 12);
    const processed = await this._runStage(
      task,
      "process-screenshot-bytes",
      "process",
      false,
      (signal) => this.processScreenshot({
        signal,
        frames,
        targets,
        cacheDir: this.cacheDir,
        comparisonCandidates,
      }),
    );
    const crop = {
      provider: "runtime-screenshot",
      ...processed.crop,
      exactProviderError: exactError.message,
    };
    const cacheKey = crypto
      .createHash("sha256")
      .update(canonicalJson({
        itemId: task.itemId,
        assetHash: processed.asset.hash,
        bounds: crop.bounds,
        viewport: crop.viewport,
      }))
      .digest("hex");
    const stability = processed.similarity.frameSelection.acceptedFrameIndexes.length
      / frames.length;
    const qualityReasons = [];
    if (
      processed.similarity.frameSelection.acceptedFrameIndexes.length
      < Math.max(2, Math.ceil(frames.length * 2 / 3))
    ) {
      qualityReasons.push("unstable-frames");
    }
    if (processed.crop.backgroundRemoval?.applied !== true) {
      qualityReasons.push("background-not-isolated");
    }
    if (
      processed.crop.backgroundRemoval?.applied === true
      && processed.crop.backgroundRemoval?.foreground?.touchesEdge !== false
    ) {
      qualityReasons.push("foreground-clipped");
    }
    if (
      processed.crop.backgroundRemoval?.applied === true
      && Number(
        processed.crop.backgroundRemoval?.foreground?.largestComponentFraction || 0,
      ) < 0.5
    ) {
      qualityReasons.push("foreground-fragmented");
    }
    if (
      targets.some(
        (target) => target.captureEligibility === "transformed-board-item",
      )
    ) {
      qualityReasons.push("transformed-board-item");
    }
    const qualityGate = {
      status: qualityReasons.length ? "rejected" : "eligible",
      reasons: qualityReasons,
      stability,
    };
    let candidate;
    let decisionChange;
    try {
      ({ candidate, decisionChange } = await this._runStage(
        task,
        "commit-icon-evidence",
        "commit",
        false,
        async () => this.database.saveIconCandidateWithDecision({
          itemId: task.itemId,
          cacheKey,
          sourceType: "screenshot-runtime",
          runtimeIdentifier: processed.crop.runtimeSource || "runtime-bounds",
          crop,
          similarity: { ...processed.similarity, qualityGate },
          rankScore: 0.5 + stability * 0.3,
          autoSelect: qualityGate.status === "eligible",
          asset: processed.asset,
        }),
      ));
    } catch (error) {
      cleanupUncommittedAsset(this.database, processed.asset);
      throw error;
    }
    this._emitComplete(task, candidate, {
      cached: false,
      provider: "screenshot-runtime",
      exactProviderError: exactError.message,
      displayIconRevision: decisionChange?.revision ?? null,
    });
    return {
      candidate,
      cached: false,
      provider: "screenshot-runtime",
      exactProviderError: exactError.message,
    };
  }

  _emitComplete(task, candidate, details) {
    this.onEvent?.({
      type: "icon-acquisition-complete",
      itemId: task.itemId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      candidate,
      ...details,
    });
  }

  _assertSafeBoundary() {
    if (this.runtimeBoundaryOwner || this.isSafeBoundary()) return;
    const error = new Error(
      "icon acquisition deferred until automation reaches an idle boundary",
    );
    error.code = "ICON_ACQUISITION_DEFERRED";
    error.reason = "automation-safe-boundary";
    throw error;
  }
}

module.exports = { IconEvidenceService, runIconWorker, reconstructIcon, processIconResource, processIconInWorker, processScreenshotInWorker, buildSpriteFrameExpression, resolveCocosSpriteFrame, buildScreenshotDiscoveryExpression, buildScreenshotTargetExpression, resolveScreenshotTarget, captureCdpScreenshot, readCdpResource, flattenResourceTree };
