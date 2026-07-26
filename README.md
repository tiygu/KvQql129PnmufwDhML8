# Mini Game Adapter Lab

独立的微信小游戏 CDP 运行时探测与适配实验室。项目已经从父项目复制了完整的微信/WMPF 路线，能够自行启动 Frida 调试桥和 CDP 代理，不再要求父项目先运行。

## 路线结构

```text
WeChatAppEx.exe
  -> Frida hook（wmpf/frida/hook.js）
  -> 微信远程调试协议（ws://127.0.0.1:9421）
  -> CDP WebSocket 代理（ws://127.0.0.1:62000）
  -> Adapter Lab（inspect / snapshot / eval / watch）
```

复制自父项目的微信/CDP 代码位于：

- `wmpf/src/`：Frida 进程管理、微信远程调试协议、CDP 代理与 execution context 自动发现。
- `wmpf/frida/hook.js`：WMPF 运行时 hook。
- `wmpf/frida/config/`：各 WMPF 版本的地址与指纹配置。
- `scripts/inspect-app-runtime.cjs`：配置和本地模块的离线校验工具。

## 安装

要求 Node.js 22 或更高版本。Frida 包含原生模块，首次安装可能需要稍长时间。

```powershell
cd D:\Desktop\小玩具\mini-game-adapter-lab
npm install
Copy-Item .env.example .env
```

## 启动微信/CDP 路线

1. 先启动微信，并让 `WeChatAppEx.exe` 进程存在。
2. 在第一个终端启动调试桥和 CDP 代理：

```powershell
npm run wx:cdp
```

默认端口为：

- 微信远程调试服务：`ws://127.0.0.1:9421`
- CDP 代理：`ws://127.0.0.1:62000`

如需详细日志或自定义端口：

```powershell
npm run wx:cdp:debug
npm run wx:cdp -- --debug-port 9421 --cdp-port 62000
```

3. 调试桥启动后，重新进入目标微信小游戏，使小游戏连接调试服务。
4. 在第二个终端执行探测：

```powershell
npm run inspect
node src/cli.js snapshot
node src/cli.js inspect --json true
```

直接写入UTF-8 JSON文件（Windows PowerShell下推荐使用，避免使用`>`重定向）：

```powershell
node src/cli.js snapshot --out target-game-snapshot.json
```

将专用适配器的原始快照整理为简洁状态报告：

```powershell
npm run state:report
```

输出文件为`target-game-state.json`。

指定另一 CDP 地址：

```powershell
node src/cli.js inspect --url ws://127.0.0.1:62000
```

在已知 execution context 中执行表达式：

```powershell
node src/cli.js eval --context 3 --expression "Object.getOwnPropertyNames(globalThis).slice(0, 50)"
```

## WMPF 配置校验

运行配置结构校验：

```powershell
node scripts/inspect-app-runtime.cjs
```

对本机 `flue.dll` 做哈希和指纹校验：

```powershell
npm run wx:verify
# 或显式指定模块与配置
node scripts/inspect-app-runtime.cjs --verify `
  --module D:\path\to\flue.dll `
  --config wmpf\frida\config\addresses.20089.json
```

## 为新游戏创建适配器

```powershell
node src/cli.js scaffold --name my-new-game --engine cocos
```

文件会创建到 `src/adapters/custom/my-new-game.js`。适配器实现：

```js
match(probeResult)              // 返回匹配分，越高越优先
snapshot(client, context)      // 对目标游戏进行只读结构检查
```

内置 `GenericAdapter` 与 `CocosInspectorAdapter`；通用探针可识别 Cocos Creator、LayaAir、Egret、PixiJS、Three.js 和 Unity/WebAssembly 痕迹。

## 前端控制台

项目使用 Node 托管的浏览器控制台，不再提供 Electron 应用或 Windows 安装包。

```powershell
# 自动启动 WMPF/CDP 路线、控制服务并打开浏览器
npm start

# 复用另一个终端通过 npm run wx:cdp 启动的 CDP 路线
npm run console

# 前端开发与构建
npm run web:dev
npm run web:build
```

默认地址为 `http://127.0.0.1:8787/`。连接顺序仍是先让 CDP 路线就绪，再打开目标小游戏；控制台页面关闭后，Node 自动化运行时继续工作。
