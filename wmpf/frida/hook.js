const hexBytes = (value) => String(value || "").trim().split(/\s+/).filter(Boolean).map((v) => parseInt(v, 16));
const offsetOf = (value) => typeof value === "number" ? value : parseInt(String(value || "0"), 16);

const getMainModule = (version) => Process.findModuleByName(version >= 13331 ? "flue.dll" : "WeChatAppEx.exe");
const sendDiag = (message) => send(`[patch-debug] ${message}`);
const runtimePatches = [];
const validateTarget = (address, expectedBytes, label) => {
    if (!address || !expectedBytes || expectedBytes.length === 0) return true;
    try {
        const actual = new Uint8Array(address.readByteArray(expectedBytes.length));
        const ok = expectedBytes.every((byte, i) => actual[i] === byte);
        if (!ok) sendDiag(`${label} fingerprint mismatch at ${address}`);
        return ok;
    } catch (error) { sendDiag(`${label} fingerprint read failed=${error.message}`); return false; }
};

const patchConditionalBranch = (address, expectedBytes, label) => {
    if (!address || !expectedBytes || expectedBytes.length === 0) return false;
    let actualBytes;
    try {
        actualBytes = Array.from(new Uint8Array(address.readByteArray(expectedBytes.length)));
    }
    catch (error) {
        sendDiag(`${label} fingerprint read failed=${error.message}`);
        return false;
    }
    const matchesExpected = expectedBytes.every((byte, i) => actualBytes[i] === byte);
    const alreadyPatched = actualBytes.every((byte) => byte === 0x90);
    if (!matchesExpected && !alreadyPatched) {
        sendDiag(`${label} fingerprint mismatch at ${address}`);
        return false;
    }
    const originalBytes = matchesExpected ? actualBytes : Array.from(expectedBytes);
    if (matchesExpected) {
        Memory.patchCode(address, originalBytes.length, (code) => {
            code.writeByteArray(new Array(originalBytes.length).fill(0x90));
        });
    }
    runtimePatches.push({ address, originalBytes, label });
    sendDiag(`${label} branch ${alreadyPatched ? "adopted" : "patched"} bytes=${originalBytes.length}`);
    return true;
};

const restoreRuntimePatches = () => {
    while (runtimePatches.length > 0) {
        const patch = runtimePatches.pop();
        Memory.patchCode(patch.address, patch.originalBytes.length, (code) => code.writeByteArray(patch.originalBytes));
        sendDiag(`${patch.label} branch restored`);
    }
    return true;
};

const patchCDPFilter = (base, config) => {
    const hooks = Array.isArray(config.CDPFilterHooks) ? config.CDPFilterHooks : [{
        Role: "legacy", EntryOffset: config.CDPFilterHookOffset,
    }];
    let installed = 0;
    hooks.forEach((hook) => {
        const branchOffset = hook.BranchOffset || hook.EntryOffset;
        const address = base.add(offsetOf(branchOffset));
        const expected = hexBytes(hook.ExpectedBytes);
        if (hook.BranchOffset && !patchConditionalBranch(address, expected, `CDP/${hook.Role}`)) return;
        let hits = 0;
        Interceptor.attach(base.add(offsetOf(hook.EntryOffset || branchOffset)), { onEnter(args) {
            hits += 1;
            if (hits <= 5 || hits % 100 === 0) sendDiag(`CDP filter entered role=${hook.Role || "legacy"} hits=${hits}`);
            if (!hook.BranchOffset) this.inputValue = args[0];
        }, onLeave() {
            if (hook.BranchOffset || !this.inputValue) return;
            try {
                const inputValue = this.inputValue.readPointer();
                if (!inputValue.isNull() && inputValue.add(8).readU32() === 6) inputValue.add(8).writeU32(0);
            } catch (_) { }
        }});
        installed += 1;
        sendDiag(`CDP filter installed role=${hook.Role || "legacy"} entry=${hook.EntryOffset || branchOffset} branch=${branchOffset}`);
    });
    sendDiag(`CDP filter hooks installed=${installed}/${hooks.length}`);
};

const hookOnLoadScene = (a1, sceneOffsets, scenePathOffsets, sceneDirectPathOffsets) => {
    try {
        if (sceneDirectPathOffsets && sceneDirectPathOffsets.length === 2) {
            const scenePtr = a1.add(sceneDirectPathOffsets[0]).readPointer().add(sceneDirectPathOffsets[1]);
            const sceneNumber = scenePtr.readInt(); send(`[hook] scene: ${sceneNumber}`);
            if ([1005,1007,1008,1027,1035,1053,1074,1145,1178,1256,1260,1302,1308].includes(sceneNumber)) {
                send("[hook] hook scene condition -> 1101"); scenePtr.writeInt(1101);
            } return;
        }
        const [configOffset, sceneRootOffset, sceneValueOffset] = scenePathOffsets || [56, 8, 16];
        const configPtr = a1.add(configOffset).readPointer();
        const sceneOwnerPtr = configPtr.add(sceneOffsets[0]).readPointer();
        const sceneRootPtr = sceneOwnerPtr.add(sceneRootOffset).readPointer();
        const sceneTablePtr = sceneRootPtr.add(sceneOffsets[1]).readPointer();
        const sceneValueBasePtr = sceneTablePtr.add(sceneValueOffset).readPointer();
        const scenePtr = sceneValueBasePtr.add(sceneOffsets[2]); const sceneNumber = scenePtr.readInt();
        send(`[hook] scene: ${sceneNumber}`);
        if ([1005,1007,1008,1027,1035,1053,1074,1145,1178,1256,1260,1302,1308].includes(sceneNumber)) {
            send("[hook] hook scene condition -> 1101"); scenePtr.writeInt(1101);
        }
    } catch (error) { send(`[hook-debug] scene failed=${error.message}`); }
};

const patchOnLoadStart = (base, config) => {
    const hook = config.LoadStartHook || { Offset: config.LoadStartHookOffset };
    const address = base.add(offsetOf(hook.Offset));
    if (!validateTarget(address, hexBytes(hook.ExpectedBytes), "LoadStart")) return;
    Interceptor.attach(address, { onEnter() {
        send(`[interceptor] OnLoadStart onEnter this=${this.context.rcx}`);
        if ((this.context.rdx & 0xff) !== 1) this.context.rdx = (this.context.rdx & ~0xff) | 1;
        hookOnLoadScene(this.context.rcx, config.SceneOffsets, config.ScenePathOffsets, config.SceneDirectPathOffsets);
    }});
    sendDiag(`LoadStart installed offset=${hook.Offset}`);
};

const parseConfig = () => { const raw = `@@CONFIG@@`; return raw.includes("@@") ? {
    Version: 18955, LoadStartHookOffset: "0x25B52C0", CDPFilterHookOffset: "0x30248B0",
    SceneOffsets: [1408, 1344, 488], ScenePathOffsets: [56, 8, 16],
} : JSON.parse(raw); };
const main = () => { const config = parseConfig(); const module = getMainModule(config.Version);
    if (!module) { sendDiag(`module missing version=${config.Version}`); return; }
    sendDiag(`module=${module.name} base=${module.base} size=${module.size}`);
    patchOnLoadStart(module.base, config); patchCDPFilter(module.base, config);
};
if (typeof rpc !== "undefined") rpc.exports = { restore: restoreRuntimePatches };
main();
