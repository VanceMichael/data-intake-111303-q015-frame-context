# 嵌套门户框架的上下文绑定资料采集

这是 frame-context 的 Node.js 项目。现有能力是本地资料源启动、来源检查和接口演练；资料接收工作流由单独的业务模块承载，当前版本不含该模块。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。浏览器使用 Playwright 1.56.1 与 Chromium，镜像中包含匹配的浏览器。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t frame-context:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
npm start -- --host 127.0.0.1 --port 3000
```

`npm test` 检查已有资料源与真实浏览器页面。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

`npm start` 启动带业务接口的门户服务，首页与 `/portal` 均可操作。可用 `HOST`、`PORT` 配置监听地址，也可通过 `--host`、`--port` 覆盖；默认使用回环地址和自动分配端口。页面与 `/portal/state`、`/portal/action` 必须由同一进程提供，不能只用静态文件服务器托管 web 目录。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

从 /portal 选观察点，子框架通过不同回环主机名嵌入。主框架和内框各有 point/revision，postMessage 消息包含自己的 generation；只接收当前两层均匹配的下载。输出 point/revision/ids 及框架链，冲突输出 state=context-conflict、ids=[]。

## 跨框架上下文绑定

业务模块 `src/workflow.mjs` 通过 Playwright 驱动真实 Chromium 完成采集，核心规则：

- **逐层确认而非按 URL 采信**：iframe 的 `/frame?point=...` 只是定位线索；机构取内页标题，观察点/修订/代次以主框架 `#outer` 与内页 `main` 两层渲染 DOM 一致为准，并要求收到同 generation 的 postMessage 佐证。
- **不缓存 frame 句柄**：每次按当前 frame 树重新解析 iframe；监听 `framedetached` 递增 frameEpoch，框架脱离后重建的内页重新走绑定，旧句柄永不复用。
- **迟到消息过滤**：postMessage 按 generation 过滤，旧 generation 与页面消息区里的旧身份只留痕（`staleMessages`、`messagePanel`），不参与当前上下文判断。
- **三态区分**：`claimed`（两层一致且领取成功）、`empty`（上下文一致但内页无下载控件，真实无资料）、`not-loaded`/`unreachable`（超时未取得可佐证上下文）、`context-conflict`（两层身份稳定不一致，暂缓接收且不下载）、`claim-failed`（回执与触发上下文不符或被服务端拒绝）。
- **领取证据绑定**：下载物与触发瞬间的两层上下文快照、实际 HTTP 200 回执、blob 解析内容三者一致才入账，并保存下载后上下文（`contextAfterTrigger.drifted`）；不用后来的页面标题补旧文件。
- **并行与失联隔离**：`input.points` 多观察点使用独立 BrowserContext 有界并发（默认 2），单内页失联只记录本观察点失败，不阻塞整轮；服务端 generation 漂移导致的 409 自动整轮重试（最多 3 次）。
- **可恢复**：每个观察点即时写 `journal-<point>-<revision>.json`，成功结果写 `checkpoint.json` 与 `downloads/`；重跑复用收据与文件均可追溯的已领取结果，不依赖调用方内存。

机器人不直接调用 `/portal/state`、`/portal/action`（它们只服务页面本身），所有动作均由页面控件在浏览器内发起。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

业务模块接入后运行上述命令。当前版本运行会明确报告业务模块不存在，不把来源测试通过当作接收工作流已完成。acceptance 检查结果、落盘内容和实际来源访问；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none frame-context:local npm test`。工作流开发完成后执行 `docker run --rm --network none frame-context:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
