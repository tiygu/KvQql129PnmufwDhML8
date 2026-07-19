"use strict";

const PRODUCTION_MODE_SWITCH_METHODS = Object.freeze(["setMultipleMode", "changeMultipleMode", "switchMultipleMode", "onMultipleModeChange"]);

function productionModeRuntimeHelpersPrelude() {
  return `const multipleModeManager=(runtime?.mManagers||[]).find(manager=>manager?._multipleModeMap instanceof Map),productionModeIdOf=value=>String(value?.modeId??value?.multiple??value?.value??value??"single"),productionModeSwitchMethod=${JSON.stringify(PRODUCTION_MODE_SWITCH_METHODS)}.find(name=>typeof multipleModeManager?.[name]==="function")||null,productionModeCurrentFor=grid=>productionModeIdOf(multipleModeManager?._multipleModeMap?.get?.(String(grid?.itemId))??multipleModeManager?._multipleModeMap?.get?.(Number(grid?.itemId))??multipleModeManager?._multipleModeMap?.get?.(grid?.index)),productionModesFor=grid=>{const modeIds=["single","double",...(multipleModeManager?._isOpenedFourfoldMode?["quad"]:[])],current=productionModeCurrentFor(grid);if(!modeIds.includes(current))modeIds.push(current);return modeIds.map(modeId=>({modeId,unlocked:modeId!=="quad"||!!multipleModeManager?._isOpenedFourfoldMode}))};`;
}

module.exports = { PRODUCTION_MODE_SWITCH_METHODS, productionModeRuntimeHelpersPrelude };
