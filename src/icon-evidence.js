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

function runIconWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "icon-image-worker.js"), { workerData: input });
    let settled = false;
    worker.once("message", (message) => { settled = true; message?.error ? reject(Object.assign(new Error(message.error.message), { stack: message.error.stack })) : resolve(message); });
    worker.once("error", (error) => { settled = true; reject(error); });
    worker.once("exit", (code) => { if (code !== 0 && !settled) reject(new Error(`icon image worker exited with code ${code}`)); });
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
  return runIconWorker(input).then((message) => message.asset);
}

function processScreenshotInWorker(input) {
  return runIconWorker({ ...input, operation: "screenshot-frames" });
}

function buildScreenshotDiscoveryExpression(itemIdentity, token) {
  const identity = typeof itemIdentity === "object" && itemIdentity ? itemIdentity : { itemId: itemIdentity };
  const encoded = JSON.stringify({ itemId: String(identity.itemId) });
  return `(() => {const wanted=${encoded}.itemId,cc=globalThis.cc||globalThis.GameGlobal?.cc,root=cc?.director?.getScene?.();if(!root)return null;const idOf=entry=>entry?.itemId??entry?._itemId??entry?.data?.itemId??entry?._data?.itemId;const entry=root.getChildByName?.("Entry")||root.children?.find?.(node=>node?.name==="Entry");const runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers));const controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController");const boardView=controller?.view?._boardView?._gameBoardView;const gridView=(boardView?._itemLayer?.childViews||[]).find(view=>String(view?._boardGrid?.itemId??"")===wanted&&view?.mNode?.activeInHierarchy!==false);const views=[];let frontier=[controller?.view].filter(Boolean);for(let depth=0;depth<8&&frontier.length;depth+=1){views.push(...frontier);frontier=frontier.flatMap(view=>Array.isArray(view?.childViews)?view.childViews:[])}const controllerItemView=gridView?null:views.find(view=>String(idOf(view)??"")===wanted&&view?.mNode?.activeInHierarchy!==false);const itemSprites=controllerItemView?.mNode?.getComponentsInChildren?.(cc.Sprite)||[];const itemSprite=itemSprites.find(candidate=>candidate?.spriteFrame&&/^(icon|item_icon)$/i.test(String(candidate?.node?.name||"")))||itemSprites.find(candidate=>candidate?.spriteFrame||candidate?._spriteFrame);const sprite=gridView||controllerItemView?null:(root.getComponentsInChildren?.(cc.Sprite)||[]).find(candidate=>[candidate.node,candidate.node?.parent,candidate.node?.parent?.parent].some(node=>[node,...(node?._components||[])].some(entry=>String(idOf(entry)??"")===wanted)));const node=gridView?.mNode||itemSprite?.node||controllerItemView?.mNode||sprite?.node||null;const grid=gridView?._boardGrid;const captureEligibility=gridView&&(!grid?.isNormal||grid?.isLocking||grid?.isFrozen)?"transformed-board-item":"eligible";const slots=globalThis.__miniGameCatalogScreenshotNodes??=(Object.create(null));slots[${JSON.stringify(String(token))}]=node;return node?{observedItemId:wanted,runtimeSource:gridView?"board-item-view":controllerItemView?"controller-item-view":"cocos-sprite-discovery",captureEligibility}:null;})()`;
}

function buildScreenshotTargetExpression(token) {
  return `(() => {const slots=globalThis.__miniGameCatalogScreenshotNodes,node=slots?.[${JSON.stringify(String(token))}];if(slots)delete slots[${JSON.stringify(String(token))}];const cc=globalThis.cc,box=node?.getBoundingBoxToWorld?.()||node?._uiProps?.uiTransformComp?.getBoundingBoxToWorld?.(),visible=cc?.view?.getVisibleSize?.();if(!box||!visible?.width||!visible?.height)return null;return{bounds:{x:Number(box.x)/visible.width*innerWidth,y:(visible.height-Number(box.y)-Number(box.height))/visible.height*innerHeight,width:Number(box.width)/visible.width*innerWidth,height:Number(box.height)/visible.height*innerHeight},viewport:{width:innerWidth,height:innerHeight},devicePixelRatio:Number(globalThis.devicePixelRatio||1)};})()`;
}

async function resolveScreenshotTarget({ client, contextId, itemId, itemIdentity = null, signal = null }) {
  const hook = await client.evaluate(`globalThis.__miniGameCatalogResolveScreenshotTarget?.(${JSON.stringify(String(itemId))})??null`, contextId, { signal });
  if (hook?.bounds && String(hook.observedItemId) === String(itemId)) return hook;
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

class IconEvidenceService {
  constructor({ database, cacheDir, concurrency = 2, queueLimit = 100, resolveSpriteFrame = resolveCocosSpriteFrame, readResource = readCdpResource, processImage = processIconInWorker, resolveScreenshotBounds = resolveScreenshotTarget, captureScreenshot = captureCdpScreenshot, processScreenshot = processScreenshotInWorker, screenshotFrameCount = 3, screenshotFrameDelayMs = 60, onEvent = null, isSafeBoundary = null }) {
    if (!database) throw new TypeError("database is required");
    this.database = database;
    this.cacheDir = path.resolve(String(cacheDir));
    this.concurrency = Math.max(1, Math.min(4, Number(concurrency) || 2));
    this.queueLimit = Math.max(this.concurrency, Math.min(1000, Number(queueLimit) || 100));
    this.resolveSpriteFrame = resolveSpriteFrame;
    this.readResource = readResource;
    this.processImage = processImage;
    this.resolveScreenshotBounds = resolveScreenshotBounds;
    this.captureScreenshot = captureScreenshot;
    this.processScreenshot = processScreenshot;
    this.screenshotFrameCount = Math.max(3, Math.min(7, Number(screenshotFrameCount) || 3));
    this.screenshotFrameDelayMs = Math.max(0, Math.min(500, Number(screenshotFrameDelayMs) || 0));
    this.onEvent = onEvent;
    this.isSafeBoundary = typeof isSafeBoundary === "function" ? isSafeBoundary : () => true;
    this.pending = [];
    this.active = 0;
    this.nextTaskId = 1;
    this.tasks = new Map();
    this.inFlight = new Map();
    this.idleWaiters = [];
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  request(itemId, runtime = {}) {
    const key = String(itemId);
    const existing = this.inFlight.get(key);
    if (existing) return { status: "queued", taskId: existing, itemId: key };
    if (this.pending.length + this.active >= this.queueLimit) throw Object.assign(new Error("icon acquisition queue is full"), { code: "ICON_ACQUISITION_QUEUE_FULL", statusCode: 429 });
    const controller = new AbortController();
    const signal = runtime.signal ? AbortSignal.any([runtime.signal, controller.signal]) : controller.signal;
    const task = { id: this.nextTaskId++, itemId: key, runtime: { ...runtime, signal }, controller, status: "queued", requestedAt: new Date().toISOString() };
    this.tasks.set(task.id, task);
    this.inFlight.set(key, task.id);
    this.pending.push(task);
    queueMicrotask(() => this._drain());
    return { status: "queued", taskId: task.id, itemId: key };
  }

  getTask(taskId) {
    const task = this.tasks.get(Number(taskId));
    return task ? { ...task, runtime: undefined, controller: undefined } : null;
  }

  interruptForAutomation() {
    let interrupted = 0;
    for (const task of this.tasks.values()) {
      if (!["queued", "running"].includes(task.status) || task.controller.signal.aborted) continue;
      task.controller.abort();
      interrupted += 1;
    }
    return interrupted;
  }

  waitForIdle() {
    if (!this.active && !this.pending.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  _drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const task = this.pending.shift();
      this.active += 1;
      task.status = "running";
      this._run(task).then((result) => { task.status = "complete"; task.result = result; }, (error) => { const deferred = error.code === "ICON_ACQUISITION_DEFERRED" || (error.name === "AbortError" && !this.isSafeBoundary()); task.status = deferred ? "deferred" : "error"; task.error = error.message; if (!deferred) this.onEvent?.({ type: "icon-acquisition-error", itemId: task.itemId, taskId: task.id, error: error.message }); })
        .finally(() => { this.active -= 1; this.inFlight.delete(task.itemId); while (this.tasks.size > 256) { const oldest = this.tasks.entries().next().value; if (!oldest || ["queued", "running"].includes(oldest[1].status)) break; this.tasks.delete(oldest[0]); } this._drain(); if (!this.active && !this.pending.length) this.idleWaiters.splice(0).forEach((resolve) => resolve()); });
    }
  }

  async _run(task) {
    this._assertSafeBoundary();
    try {
      return await this._runExact(task);
    } catch (exactError) {
      if (exactError.code !== "ICON_EXACT_PROVIDER_UNAVAILABLE") throw exactError;
      return this._runScreenshotFallback(task, exactError);
    }
  }

  async _runExact(task) {
    let metadata;
    try {
      metadata = await this.resolveSpriteFrame({ ...task.runtime, itemId: task.itemId });
      this._assertSafeBoundary();
      if (!metadata?.resourceUrl) throw new Error(`SpriteFrame resource not found for item ${task.itemId}`);
    } catch (error) {
      if (/SpriteFrame resource not found|SpriteFrame mapping/i.test(error.message)) error.code = "ICON_EXACT_PROVIDER_UNAVAILABLE";
      throw error;
    }
    const crop = { rect: metadata.rect, rotated: !!metadata.rotated, rotation: metadata.rotation ?? null, originalSize: metadata.originalSize, offset: metadata.offset, yOrigin: metadata.yOrigin || "top-left" };
    const cacheKey = crypto.createHash("sha256").update(canonicalJson({ reconstructionVersion: ICON_RECONSTRUCTION_VERSION, resourceUrl: metadata.resourceUrl, textureUuid: metadata.textureUuid || null, crop })).digest("hex");
    const cached = this.database.findIconAcquisition(cacheKey);
    if (cached && fs.existsSync(cached.filePath)) {
      const { candidate, decisionChange } = this.database.saveIconCandidateWithDecision({
        itemId: task.itemId, cacheKey, sourceType: cached.sourceType, resourceUrl: cached.resourceUrl,
        runtimeIdentifier: metadata.runtimeIdentifier || cached.runtimeIdentifier, textureUuid: metadata.textureUuid || cached.textureUuid, crop,
        rankScore: cached.rankScore ?? 1,
        asset: { hash: cached.assetHash, mimeType: cached.mimeType, width: cached.width, height: cached.height, byteSize: cached.byteSize, filePath: cached.filePath },
      });
      this.onEvent?.({
        type: "icon-acquisition-complete",
        itemId: task.itemId,
        taskId: task.id,
        candidate,
        cached: true,
        displayIconRevision: decisionChange?.revision ?? null,
      });
      return { candidate, cached: true };
    }
    let resource;
    try {
      this._assertSafeBoundary();
      resource = await this.readResource({ ...task.runtime, resourceUrl: metadata.resourceUrl, mimeType: metadata.mimeType });
      this._assertSafeBoundary();
    } catch (error) {
      if (/resource (?:not loaded|not found)|not found for item/i.test(error.message)) error.code = "ICON_EXACT_PROVIDER_UNAVAILABLE";
      throw error;
    }
    const asset = await this.processImage({ resourceBody: resource.body, metadata: { ...metadata, mimeType: resource.mimeType || metadata.mimeType }, cacheDir: this.cacheDir });
    const { candidate, decisionChange } = this.database.saveIconCandidateWithDecision({
      itemId: task.itemId, cacheKey, sourceType: "cocos-runtime-resource", resourceUrl: resource.resolvedUrl || metadata.resourceUrl,
      runtimeIdentifier: metadata.runtimeIdentifier || null, textureUuid: metadata.textureUuid || null, crop,
      rankScore: 1, asset,
    });
    this.onEvent?.({
      type: "icon-acquisition-complete",
      itemId: task.itemId,
      taskId: task.id,
      candidate,
      cached: false,
      displayIconRevision: decisionChange?.revision ?? null,
    });
    return { candidate, cached: false };
  }

  async _runScreenshotFallback(task, exactError) {
    const frames = [], targets = [];
    for (let attempt = 0; attempt < this.screenshotFrameCount * 2 && frames.length < this.screenshotFrameCount; attempt += 1) {
      this._assertSafeBoundary();
      const before = await this.resolveScreenshotBounds({ ...task.runtime, itemId: task.itemId });
      this._assertSafeBoundary();
      const body = await this.captureScreenshot({ ...task.runtime, target: before });
      this._assertSafeBoundary();
      const after = await this.resolveScreenshotBounds({ ...task.runtime, itemId: task.itemId });
      if (String(before.observedItemId) !== task.itemId || String(after.observedItemId) !== task.itemId) continue;
      const drift = Math.max(...["x", "y", "width", "height"].map((key) => Math.abs(Number(before.bounds[key]) - Number(after.bounds[key]))));
      if (drift > 2) continue;
      frames.push(body);
      targets.push({ ...before, insetRatio: 0.06, mimeType: "image/png" });
      if (this.screenshotFrameDelayMs && frames.length < this.screenshotFrameCount) await new Promise((resolve) => setTimeout(resolve, this.screenshotFrameDelayMs));
    }
    if (frames.length < 3) throw new Error(`stable screenshot frames unavailable after exact provider failed: ${exactError.message}`);
    const allCandidates = this.database.listIconCandidates(task.itemId);
    const prioritizedCandidates = [...allCandidates.filter((candidate) => candidate.selected), ...allCandidates.slice(-12)];
    const comparisonCandidates = [...new Map(prioritizedCandidates.map((candidate) => [candidate.id, candidate])).values()].slice(0, 12);
    const processed = await this.processScreenshot({ frames, targets, cacheDir: this.cacheDir, comparisonCandidates });
    this._assertSafeBoundary();
    const crop = { provider: "runtime-screenshot", ...processed.crop, exactProviderError: exactError.message };
    const cacheKey = crypto.createHash("sha256").update(canonicalJson({ itemId: task.itemId, assetHash: processed.asset.hash, bounds: crop.bounds, viewport: crop.viewport })).digest("hex");
    const stability = processed.similarity.frameSelection.acceptedFrameIndexes.length / frames.length;
    const qualityReasons = [];
    if (processed.similarity.frameSelection.acceptedFrameIndexes.length < Math.max(2, Math.ceil(frames.length * 2 / 3))) qualityReasons.push("unstable-frames");
    if (processed.crop.backgroundRemoval?.applied !== true) qualityReasons.push("background-not-isolated");
    if (processed.crop.backgroundRemoval?.applied === true
      && processed.crop.backgroundRemoval?.foreground?.touchesEdge !== false) qualityReasons.push("foreground-clipped");
    if (processed.crop.backgroundRemoval?.applied === true
      && Number(processed.crop.backgroundRemoval?.foreground?.largestComponentFraction || 0) < 0.5) qualityReasons.push("foreground-fragmented");
    if (targets.some((target) => target.captureEligibility === "transformed-board-item")) qualityReasons.push("transformed-board-item");
    const qualityGate = { status: qualityReasons.length ? "rejected" : "eligible", reasons: qualityReasons, stability };
    const { candidate, decisionChange } = this.database.saveIconCandidateWithDecision({
      itemId: task.itemId, cacheKey, sourceType: "screenshot-runtime", runtimeIdentifier: processed.crop.runtimeSource || "runtime-bounds", crop,
      similarity: { ...processed.similarity, qualityGate }, rankScore: 0.5 + stability * 0.3, autoSelect: qualityGate.status === "eligible", asset: processed.asset,
    });
    this.onEvent?.({
      type: "icon-acquisition-complete",
      itemId: task.itemId,
      taskId: task.id,
      candidate,
      cached: false,
      provider: "screenshot-runtime",
      exactProviderError: exactError.message,
      displayIconRevision: decisionChange?.revision ?? null,
    });
    return { candidate, cached: false, provider: "screenshot-runtime", exactProviderError: exactError.message };
  }

  _assertSafeBoundary() {
    if (this.isSafeBoundary()) return;
    throw Object.assign(new Error("icon acquisition deferred until automation reaches an idle boundary"), { code: "ICON_ACQUISITION_DEFERRED" });
  }
}

module.exports = { IconEvidenceService, reconstructIcon, processIconResource, processIconInWorker, processScreenshotInWorker, buildSpriteFrameExpression, resolveCocosSpriteFrame, buildScreenshotDiscoveryExpression, buildScreenshotTargetExpression, resolveScreenshotTarget, captureCdpScreenshot, readCdpResource, flattenResourceTree };
