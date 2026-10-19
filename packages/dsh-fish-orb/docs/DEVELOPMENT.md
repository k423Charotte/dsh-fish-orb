# 开发笔记 · dsh-fish-orb

> 每一条都是**实际踩过、有证据**的，不是猜测。写下来是为了不再踩第二次。
> 按「现象 → 根因 → 怎么修」记。

---

## 一、Client 半（页面侧）

### 1. `--dsw-alias-label-primary-foreground` 这个 token **不存在**

**现象**：球的文字/白点取不到颜色（声明被整条丢弃）。
**根因**：我凭印象写了一个 token 名，它不在当前主题表里。
**取证方式**：`cordis_inspect_query` → `platform: client` / `provider: Theme` / `method: listTokens`，里面只有 14 个 token：
`bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 / brand-primary /
label-primary / label-secondary / state-{error,idle,success,warn}-primary / specific-sidebar-fill`。
**修法**：只用表里真实存在的 token，并且**每个 `var()` 都带 fallback**。

### 2. `--dsw-alias-brand-primary` 在浅色主题下**接近黑**

**现象**：拿它当球底色 → 一颗黑球。
**根因**：它是"品牌强调色"，不是"浅色底"。浅色主题下它偏偏是深色。
**修法**：球底色改用 `--dsw-alias-bg-layer-1`（浅）；品牌色只用在需要被注意的地方（滑块 accent 等）。

### 3. `--dsw-alias-bg-overlay` 是**深色浮层色**

**现象**：换成它当球底 → 球变成深色的圆。
**根因**：`bg-overlay` 是"弹层/遮罩"背景，深色主题下更深。
**修法**：球底用 `bg-layer-1`；对话框/面板底才用 `bg-overlay`（且仅当它确实是浅色的语境）。

### 4. `border-radius` 走 `<style>` 时表现怪异

**现象**：`border-radius: 50%` 渲染成了**圆角矩形**，原因未查明。
**修法**：**关键样式一律写成元素级 inline style**（`el.style.cssText`），不再依赖 `<style>` 表。
这条顺带解决了另一个隐患：不受 DSH 全局 CSS 影响。

### 5. SVG `<text>` + `dominant-baseline` 对 emoji 垂直居中**不可靠**

**现象**：`<text dominant-baseline="central">🐟</text>` 渲染出来**字符偏下**。
**根因**：SVG 文字的基线对齐依赖字体度量，emoji 尤其不听话。
**修法**：**别用 SVG 排文字**。要么用 HTML 元素 + `display:flex; align-items:center; justify-content:center`，
要么把字符放在 HTML 层（本插件最终就是"HTML 元素 + flex 居中"）。

### 6. 坐标必须 `Math.round`

**现象**：状态文件里写进了 `bottom: 440.0000305175781`。
**根因**：`clientX` / `clientY` 是浮点数，直接存进 JSON 就是长小数。
**修法**：拖动与渲染两处都 `Math.round`。

### 7. 拖动必须 `setPointerCapture`

**现象**（预防性，实现时就加上了）：指针移出球之后 `pointermove` / `pointerup` 丢失，拖动"粘住"。
**修法**：`pointerdown` 里 `ball.setPointerCapture(e.pointerId)`，`pointerup` 里 `releasePointerCapture`。

### 8. 拖动完会误触点击

**现象**：拖完球，面板自己开了。
**修法**：**位移阈值 4px** —— `Math.abs(dx) + Math.abs(dy) < 4` 才算点击，否则算拖动。

### 9. 容器 `pointer-events: none` 与球 `pointer-events: auto` 必须成对

**现象**（bili-duty 的教训，本插件沿用）：漏一个就整页点不动 —— 覆盖全屏的容器把鼠标事件全吃了。
**修法**：`#fish-orb-root { pointer-events:none }` + `.fo-ball { pointer-events:auto }`，面板同样 `auto`。

---

## 二、Host 半（进程侧）

### 10. `ctx.get('webServer')` 可能返回 `undefined`

**现象**：fiber 明明 active，但 `/fish-orb/*` 全部 404。
**根因**：冷启动时 `apply` 可能跑在 webServer 就绪**之前**。热重载时服务早就绪，所以开发中完全看不出来。
**修法**：**二次探测** —— 先试一次 `ctx.get('webServer')`；拿不到就 `ctx.inject(['webServer'], cb)` 等服务就绪。
（照抄 bili-duty `lib/index.js:1267-1317`。）

### 11. 路由的 disposer 必须交给 `ctx.effect`

**现象**（bili-duty 实测）：禁用/重载插件后旧路由没释放，下次激活被以 `duplicate exact route` 拒绝。
**修法**：`ctx.effect(() => { const dispose = webServer.register(route); return () => dispose() })`。

### 12. 写盘失败**绝不抛**

**根因**：有插件因为 `appendFileSync` 抛 `EBUSY` 没被捕获，**把整个 DSH 宿主带走了**（dsh-bili-scroll issue #1）。
**修法**：原子写（随机临时名 + `wx` 独占 + `fsync` + 失败清理），**只返回 `{ok, error}`，不 throw**。

### 13. `agents.list()` 只给"活着的 agent"，不是全量会话

**现象**：会话下拉**空的**，或者只有一个。
**根因**：`agents.list()` 返回的是"当前进程里活着的 agent"，而侧边栏列的是"全部持久化会话"。
**修法**：三层来源 ——
1. `sessionQuery.listSessions()`（**全量**，首选）
2. `sessionController.list()`（兜底）
3. `agents.list()`（**只用来标"谁活着"**，因为只有活着的能收派发）

### 14. `listSessions()` 只给 id，**标题要另外批量取**

**现象**：下拉里全是「(未命名)」。
**修法**：`sessionQuery.readTitleSnapshots(ids, signal)` 批量补标题，再用**宽容解析**挖（结构没有公开契约，
实测见过 `{ sessionId, observation: { title: { val: "…" } } }` 这种套娃）。
挖不到时退到**工作目录名**，至少能区分是哪个会话。

### 15. 磁盘上的会话 ≠ 侧边栏显示的会话（**孤儿会话**）

**现象**：下拉里出现一批"不存在的会话"（如标题为「你是一名代码安全审计员。请…」），侧边栏里根本看不到。
**取证**：`~/.dsh/sessions/--E-AI-deepseek-…--/<uuid>/` 目录真实存在，但
`~/.dsh/storages/workspace.json` 的 `tables.workspaces[*].sessionIds` 里**没有这些 id**。
**根因**：`sessionQuery.listSessions()` 返回**磁盘上所有会话**，其中一批**没登记进任何工作区**；
侧边栏按工作区索引显示，所以用户看不到它们。
**修法**：读 `workspace.json`，只保留"在工作区 `sessionIds` 里、且不在 `global.archivedSessionIds` 里"的会话。
另外 id 前缀不一致（`session-<uuid>` vs 裸 uuid），比较前统一去前缀。

### 16. `const` 声明后又重新赋值 → `Assignment to constant variable`

**现象**：整个会话列表接口 500（我在写 debug 回吐时自己造成的）。
**注意**：`node --check` **查不出**这种错 —— 它是运行时错误。所以语法通过 ≠ 能跑。
**修法**：需要重新赋值的变量一律 `let`。

---

## 三、投递（本轮最关键的一条）

### 17. `createUserMessage` 必须补齐 `role` 与 `id`

**根因**（bili-duty 的**最贵教训**，本项目沿用）：手拼裸对象投递，会往会话里存一条**没有 `role`** 的消息，
此后该会话**每一次**请求都被网关拒绝：`messages[N]: missing field 'role'`。会话**永久损坏**。
**修法**：
```js
import { randomUUID } from 'node:crypto'
let createUserMessage = (input) => ({ ...input, role: 'user', id: randomUUID() })  // 等价兜底
void import('@deepseek-ai/dsh-llm').then((mod) => {
  if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage
}).catch(() => { /* 保持兜底 */ })
```
用**动态 import + 同步兜底**而不是顶层静态 import：静态 import 一旦失败会让**整个插件模块**加载不了，
而这条路只影响"派发"一件事。

### 18. `source.kind` **不能**是 `"plugin"`

**根因**：DSH 的 session format v4 校验明确拒绝（`format v4 message requires a producer-owned source kind`），
而且**只吃 `kind` 一个字段**，多塞没用。
**修法**：用自己的名字 —— `source: { kind: 'fish-orb' }`。
（对照：官方 dsh-schedule 用 `{ kind: "schedule" }`。）

### 19. 目标会话必须**活着**，否则派不出去

**现象**：选了会话却投递失败。
**修法**：`agents.get(id)` 拿不到就是没在运行 —— 返回明确错误「目标会话未运行，请先在 DSH 里打开它再试」，
并在下拉里标注「（运行中）」/「（未打开）」，让用户**选之前就知道**。

---

## 四、工程与流程

### 20. `install_bundle` 的 `application` 字段才是生效判据

**修法**：装完看返回的 `application`（`applied` 才算生效），**不要**拿"终端没报错"当成功。

### 21. 改 `client.js` 只需刷新页面；改 `lib/index.js`（Host）必须重启 DSH

**根因**：Host 半是进程里的模块，替换已装包后要重启才能加载新一代 JS。
**修法**：`tools/restart-dsh.ps1`（自动探测 DSH 位置）；打包更新用 `install_bundle` 重装同一个 target。

### 22. 包目录是 `link:` 装的，改文件即时可见 —— 但**模块不会自动重载**

- `client.js`：F5 重新拉取 → 生效
- `lib/index.js`：需要重启进程 → 生效

### 23. Chrome DevTools 会拦粘贴

**现象**：在 Console 里粘贴代码，出现 `Warning: Don't paste code into the DevTools Console…`，命令不执行。
**修法**：先**手打** `allow pasting` 回车，再粘贴。

### 24. 本项目的形态限制（写给未来的自己）

- ❌ **不能**跨应用置顶（那是 Electron BrowserWindow / 原生窗口）
- ❌ **不能**跨应用划词（需要系统级全局钩子，在主进程）
- ✅ **能**做的：页面内悬浮球、拖动吸附、面板、派发、结果回流
- 参考的 deepseek-harness-orb 是 **fork 整个 dsh** 的产物，本机是打包好的 `app.asar`，**代码搬不过来** —— 搬设计，不搬代码。
