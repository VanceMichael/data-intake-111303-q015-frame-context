# 来源与接收约定

从 /portal 选观察点，子框架通过不同回环主机名嵌入。主框架和内框各有 point/revision，postMessage 消息包含自己的 generation；只接收当前两层均匹配的下载。输出 point/revision/ids 及框架链，冲突输出 state=context-conflict、ids=[]。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 上下文一致领取

业务输入：
```json
{
  "point": "p2",
  "revision": 2
}
```
结果必须包含：
```json
{
  "ids": [
    "sample-p2"
  ],
  "point": "p2",
  "revision": 2
}
```

### 旧内框消息不能冠新身份

业务输入：
```json
{
  "point": "p2",
  "revision": 2
}
```
结果必须包含：
```json
{
  "ids": [
    "sample-p2"
  ],
  "point": "p2"
}
```

### 内外上下文冲突暂缓

业务输入：
```json
{
  "point": "p2",
  "revision": 2
}
```
结果必须包含：
```json
{
  "state": "context-conflict",
  "ids": []
}
```

## 状态与证据字段

工作流只通过真实浏览器页面访问来源，不直连页面内部动作接口。每个观察点结果含下列业务状态之一：

| state | 含义 |
| --- | --- |
| `claimed` | 主框架与内页 point/revision/generation 两层一致、同代次消息已佐证，且下载回执与触发上下文一致 |
| `empty` | 上下文两层一致且消息已佐证，但内页不存在下载控件（真实无资料，区别于未加载） |
| `context-conflict` | 内页已加载但两层身份稳定不一致；暂缓接收、ids=[]、不触发下载 |
| `not-loaded` / `unreachable` | 超时内未取得可佐证的两层上下文（框架未附加、消息缺失、内页来源中断等） |
| `claim-failed` | 已绑定但回执非 200、缺正式收据，或收据 point/revision 与触发上下文不符 |

`claimed` 结果必须输出：机构（`organization`，取内页标题）、观察点（`point`）、修订（`revision`）、框架链（`frameChain`，含每层 url/origin 及 `crossOriginToParent`）、领取证据（`evidence`）：

- `contextAtTrigger`：点击下载瞬间主框架与内页各自的 point/revision/generation；
- `contextAfterTrigger`：下载完成后再次读取的两层身份及 `drifted` 标记；
- `actionReply`：页面自身动作请求的真实 HTTP 状态与响应体；
- `receipt`：回执 id/point/revision/receipt、下载建议文件名、内容 sha256 前缀与字节数；
- `postMessage`：同代次当前消息 `current` 与仅留痕的 `staleMessages`；
- `messagePanel`：主页面消息区原文（late 模式下可能是旧身份，不采信）；
- `downloadFile`：stateDir 内保存的原始下载物；`detachedFrames`、`pageErrors` 为框架脱离与页面错误留痕。

多观察点输入 `{ "points": [{"point":"p1","revision":2},{"point":"p2","revision":2}] }` 返回 `{ "state": "claimed|partial|...", "points": [...] }`；单个观察点输入直接返回该观察点结果。所有结果同时持久化到 stateDir/result.json，过程证据写入 journal 与 checkpoint。
