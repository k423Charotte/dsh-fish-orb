# 小肥鱼球 · 实施方案

> 写于 2026-10-17，作者：标准模式下的 deepseek-flash（当时 `plugin_manager` 不可用，写不出代码也装不了插件）。
> **执行者**：创造模式下的你。这份文档是自包含的，你不需要翻之前的会话。
> 读完第 0 节就能开工。

---

## 0. 怎么用这份文档

1. 先读 **第 2 节（硬约束）**——那里每一条都是踩过的坑，不读会浪费一整天。
2. 按 **第 7 节的 P0 → P5** 逐段实现，**不要跳 P0**。每段做完先验收，再进下一段。
3. 需要抄代码时，看 **第 8 节（复用清单）**，那里给了精确到行号的现成实现。
4. 卡住时看 **第 9 节（踩坑清单）**，大概率已经写过答案。
5. 安装方式只有一种：`plugin_manager` → `action: install_bundle`, `target: <包目录绝对路径>`。

**开工第一句话**（可以直接丢给创造模式的自己）：

> 读 `E:\AI\deepseek\插件\小肥鱼球\PLAN.md`，先调 `plugin_manager action:list_bundles` 确认基线，然后从 P0 开始做，每段完成向我报告验收结果。

---

## 1. 背景与目标

### 1.1 为什么做这个

B 站有个视频（[BV1Lqho6AEj1](https://www.bilibili.com/video/BV1Lqho6AEj1)），UP 主把 DeepSeek Harness 魔改成了**屏幕边缘的悬浮球**（DeepSeek Orb），核心体验是：

- 常驻屏幕边缘的小球，点开就能说话
- **双轨**：短任务当场做、可见；长任务派给后台会话，做完结果回到球上
- 球里的 agent 自己决定派不派，**运行时没有任务分类器**
- 后台会话就是普通会话，出现在主窗口侧边栏，可续可停

开源仓库：<https://github.com/mini-yifan/deepseek-harness-orb>（MIT，**非官方社区项目**）。

**重要判断：不要试图搬它的代码。** 它是 **fork 整个 dsh** 的产物（50+ 包的完整 workspace，基于 dsh 0.2.1-alpha.2），而用户本机是打包好的 `app.asar`（0.2.0-rc.2）。它的 `dsh-computer-use` / `dsh-browser-use` / `dsh-lsp` 这些包在本机**根本不存在**，摘出来也跑不起来。**搬设计，不搬代码。**

### 1.2 我们要做的，和它差在哪

| 它有的 | 我们能不能做 | 说明 |
|---|---|---|
| 跨应用置顶的悬浮球 | ❌ | 那是 Electron BrowserWindow / 原生窗口，插件跑在 Web 页面里，做不到 |
| 任意应用划词弹工具栏 | ❌ | 需要系统级全局钩子，在主进程 |
| **页面内**悬浮球 + 拖动 + 吸附 | ✅ | 鲸鱼挂件已验证过这个形态 |
| 页面内划词工具栏 | ✅ | 纯 DOM |
| 双轨派发 + 结果回流 | ✅ | bili-duty 已有「唤醒会话跑一轮」的完整实现 |
| 桌面 GUI 控制（点别的软件） | ❌ | 需要 computer-use 服务 + Cua Driver provider，本机无 |
| 桌面级截图步进 | ❌ | 同上 |

**一句话目标**：做一个**只在 DSH 页面内**的悬浮球，能接一句话、能派长任务、能把结果收回来。**不碰桌面控制。**

### 1.3 名字

- 目录：`E:\AI\deepseek\插件\小肥鱼球\`
- npm 包名：`dsh-fish-orb`
- 插件行 id：`dsh-fish-orb`
- 状态文件：`$DSH_HOME/.fish-orb-state.json`

---

## 2. 硬约束（先读，全部有出处）

### 2.1 Client 半的规矩（来自 `bili-duty/lib/client.js` 头注释，原文）

> 形态：静态客户端模块，按官方 templates/decoration 的 `window.__ModuleLoader__.load` 约定注册一个惰性 factory，把设置页挂进 `settings.section` 槽位。
> 与 Host 的通信：**只走插件自己注册的 HTTP 路由**（`/bili-duty/*.json`），**不使用任何 Harness Client 包，也不 import `@deepseek-ai/*`（那是明文禁止的）**。
> 样式：只用主题 token（`--dsw-alias-*`），浅色/深色自动跟随。

**所以：**

1. `client.js` 里**只能** `require('react')` 这类允许的模块，**绝对不能** `import '@deepseek-ai/*'`。
2. 想拿 Host 的数据 → 只能打自己注册的 HTTP 路由。
3. 样式只用 `--dsw-alias-*` / `--ds-font-family-code` 这类 token，类名统一加前缀（建议 `fo-`）。

### 2.2 factory 抛异常 = 应用起不来（血的教训）

`bili-duty/lib/client.js:14-18` 的注释：

> ⚠️ 兜底：factory 体里任何 throw 都会让这个 entry `failed`，而 web boot 把 entry failed 当**致命** —— 用户看到的就是"应用无法启动"。
> 所以整个 factory 包一层：炸了就返回一个什么都不做的空插件，DSH 照常启动。

**必须照抄这个 try/catch 包裹**，没有例外。

### 2.3 webServer 可能没就绪

`bili-duty/lib/index.js:1267-1317`：

> ⚠️ 为什么不能直接 `ctx.get('webServer')` 了事（0.1.0 实测踩过）……
> 所以：先试一次；拿不到就交给 `ctx.inject(['webServer'], cb)` 等服务就绪

**照抄这个二次探测模式。**

### 2.4 路由重复注册会被拒

`lib/index.js:1401` 注释：

> webServer 会以 "duplicate exact route" 拒绝下一次激活（实测踩过）。

路由注册要幂等，别在每次激活时重复塞同名路径。

### 2.5 `source.kind` 不能是 `"plugin"`

`lib/index.js:920-924`：

> ⚠️ `source.kind` **不能是 `"plugin"`** —— DSH 的 session format v4 校验明确拒绝它
> 这里踩过一次真坑：定时唤醒与新用户会话**从未成功投递过**，界面上只显示「本轮运行失败」

投递消息时 `source.kind` 用 `"plugin"` 以外的值（照抄 bili-duty 实际用的那个）。

### 2.6 权限与安装

- 安装必须走 `plugin_manager`（`install_bundle`），**不要手改 profile 的 `package.json` / `cordis.patch.yml`**，那是客户端接管的目录。
- `plugin_manager` 只在 **创造模式（cordis 预设）** 可用；standard / minimal / ptc 预设里那一行是 `disabled: true`。
- 目标 profile 是 **desktop**（不是 web）。CLI 会拒绝 `--profile desktop`，这是设计如此。
- 装完可能要**重开客户端**（热生效不一定够）。

### 2.7 版本基线

`bili-duty/package.json` 写的 `engines.dsh: ">=0.2.0-rc.2"`，本机正好 0.2.0-rc.2。保持同样的 `engines` 声明。

---

## 3. 形态设计

### 3.1 球

- 位置：`position: fixed`，默认 **右侧、垂直约 55%**，尺寸 44×44。
- **默认要避开鲸鱼挂件**：`dsh-whale-widget` v0.3.18 占着**右下角**，球如果也去右下角会重叠。默认 `right: 18px; bottom: 132px` 起步更安全。
- 交互：
  - 悬停轻微放大 + 显示 tip
  - 单击 → 展开/收起面板
  - 拖动 → 移动；松手后位置写入 `$DSH_HOME/.fish-orb-state.json`
  - 拖到贴近左右边缘（约 1/5 越界）→ 吸附成一条细片（可选，P1 先不做）
- 状态色：
  - 空闲 = 品牌色
  - 运行中 = 呼吸动画
  - 有未读结果 = 小红点

### 3.2 面板

点球展开，约 360×460，`position: fixed`，跟随球的位置自动决定向左/向上展开（靠近右边缘就向左开）。

- 顶部：标题 + 状态 pill（空闲/派发中/运行中/完成）+ 关闭按钮
- 中部：最近 5 条任务卡片，每条显示：一句话摘要、状态、时间、可点开看结果
- 底部：输入框（Enter 发送 / Shift+Enter 换行）+ 发送按钮
- 任务运行中时，面板里能看到"已派发给后台"的提示

### 3.3 划词工具栏（P6，可选）

页面内选中文字 → 在选区上方浮出小条：**搜索 / 翻译 / 发到球里**。
只处理 **DSH 页面内**的选区（不是系统级）。

---

## 4. 架构与文件清单

```
E:\AI\deepseek\插件\小肥鱼球\
├── PLAN.md                        ← 本文件
├── README.md                      ← 后期写（含截图、安装说明）
└── packages\dsh-fish-orb\
    ├── package.json
    ├── cordis.patch.yml
    ├── icon.svg
    ├── README.md
    ├── CHANGELOG.md
    ├── lib\
    │   ├── index.js               ← Host 半：路由 + 派发 + 状态
    │   └── client.js              ← Client 半：球 + 面板
    ├── locale\
    │   └── zh-CN.json
    ├── docs\
    │   └── DEVELOPMENT.md         ← 调试/热更/重启流程
    └── tools\
        ├── smoke-test.mjs         ← Host 侧自检
        └── restart-dsh.ps1        ← 照抄 bili-duty 的
```

### 4.1 `package.json` 要点

```json
{
  "name": "dsh-fish-orb",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "icon": "./icon.svg",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings"]
    }
  },
  "engines": { "node": ">=22", "dsh": ">=0.2.0-rc.2" }
}
```

> 注意：`dsh.client.inject` 里写 `@deepseek-ai/...` 是**清单声明**（允许），
> 而 `client.js` 代码里 `import '@deepseek-ai/...'` 是**明文禁止**。两者别搞混。

### 4.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-fish-orb
      name: dsh-fish-orb
```

---

## 5. Host 半设计（`lib/index.js`）

### 5.1 路由表

| 方法 | 路径 | 用途 | 返回 |
|---|---|---|---|
| GET | `/fish-orb/state.json` | 读球位置、开关、目标会话、最近任务 | `{ ok, ball:{x,y}, config, tasks[] }` |
| PUT | `/fish-orb/state.json` | 保存球位置、配置 | `{ ok }` |
| POST | `/fish-orb/dispatch.json` | 投递一句话，派一轮任务 | `{ ok, taskId, mode }` |
| GET | `/fish-orb/tasks.json` | 任务列表 + 状态（前端轮询） | `{ ok, tasks[] }` |
| GET | `/fish-orb/health.json` | 自检：webServer / agents 是否可用 | `{ ok, services }` |

**全部带 CORS 头**（照抄 bili-duty 的 route 包装）。

### 5.2 派发实现

**P3 先用 mock**（不碰真服务），返回 `{ ok:true, taskId, mode:'mock' }`，3 秒后状态置 `done`。这样能把「前端 → 路由 → 状态 → 前端」整条链路先验通。

**P4 再接真的**，两条路按优先级：

1. **投给指定会话（首选，有实证）**
   ```js
   const agents = ctx.get('agents')
   const agent = agents.get(config.target_session_id)
   // 照抄 bili-duty/lib/index.js:892-946 的 fire()：
   //   agent.followup({ ...message, source: { kind: <非 'plugin'> } })
   ```
   - 目标会话必须**活着**（`agents.get()` 拿不到就是没在运行），失败时明确告诉用户"打开那个会话后重试"
   - 设置页给一个会话下拉框（照抄 `/bili-duty/sessions.json` 的列表逻辑，`lib/index.js:1008-1141`，首选 `sessionQuery`，次选 `sessionController`）

2. **延迟投递 / 超时兜底**：`ctx.timeout(fn, ms)`（`lib/index.js:1966`）

### 5.3 状态文件

`$DSH_HOME/.fish-orb-state.json`：

```json
{
  "ball": { "x": null, "y": null },
  "enabled": true,
  "target_session_id": "",
  "tasks": [
    { "id": "t1", "text": "…", "status": "done", "createdAt": "…", "result": "…" }
  ]
}
```

- 写入用原子写（照抄 bili-duty / 鲸鱼的做法，避免半截文件）
- `tasks` 只保留最近 20 条，结果摘要截断（**别把长文本塞进状态文件**）

### 5.4 可选：注册给 agent 的工具

P5 之后再加，比如 `fish_orb_dispatch` 让 agent 自己往球上推任务。**不是必须，别提前做。**

---

## 6. Client 半设计（`lib/client.js`）

### 6.1 骨架（严格照这个结构写）

```js
window.__ModuleLoader__.load({
  id: 'dsh-fish-orb',
  factory(require) {
    try {
      const React = require('react')
      const h = React.createElement
      // …球 + 面板…
      return { /* 空实现也不要裸 throw */ }
    } catch (err) {
      // 吞掉，返回空插件，DSH 照常启动
      try { console.error('[fish-orb] client failed:', err) } catch {}
      return {}
    }
  },
})
```

### 6.2 挂载方式：直接 append 到 body，不要塞 slot

理由：`ui-slots` 的位置是给设置页/侧栏用的；浮球需要**覆盖在整个页面之上**，塞 slot 会受布局约束。
**直接 `document.body.appendChild(容器)`**，容器固定：

```css
#fish-orb-root {
  position: fixed; inset: 0; z-index: 2147483000;
  pointer-events: none;           /* 关键：容器不挡点击 */
}
#fish-orb-ball { pointer-events: auto; }   /* 只有球自己收事件 */
```

> `pointer-events` 这一对是**必须**的，否则整个 DSH 页面点不动。

### 6.3 z-index 安全

- 球用很高但**不是**最高（`2147483000` 附近），确保能压住侧栏/对话区，但**压不压弹窗**要看实测。
- 有现成的审计脚本可参考：`E:\AI\deepseek\插件\大肥鱼记账\tools\z-layer-audit.mjs`
- 展开面板时如果 DSH 有 modal，考虑临时降低或让面板可关闭。

### 6.4 拖拽

- `pointerdown` 记录起点 → `pointermove` 更新 `left/top` → `pointerup` 落盘
- 拖动中 `e.preventDefault()`，容器加 `user-select: none`
- 拖动位移 < 4px 视为**点击**（否则拖完会误触展开）
- 落盘用 `PUT /fish-orb/state.json`，**防抖** 500ms，别每像素都发请求

### 6.5 数据流

```
面板打开 → GET /fish-orb/state.json → 渲染位置/任务
输入回车 → POST /fish-orb/dispatch.json → 拿到 taskId → 本地插入"派发中"
每 2s → GET /fish-orb/tasks.json → 更新状态；有 done 且未读 → 球上小红点
```

- **轮询就够**，别一上来做 SSE/WebSocket。P3 先用 mock 跑通轮询，P5 再考虑优化。
- 轮询在**面板关闭时降频**（比如 10s）或暂停，别一直烧。

### 6.6 样式

- 只用 `--dsw-alias-*` token（`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-brand-primary`、`--dsw-alias-border-l1`、`--dsw-alias-state-success-primary` …）
- 类名统一 `fo-` 前缀，样式通过 `<style>` 注入一次（别每次渲染都插）
- 深浅色自动跟随，不要写死颜色

---

## 7. 分阶段实施（每段都要验收）

### P0 · 空壳落地（最重要）

**做什么**：只做"右下角（避让鲸鱼）出现一个 44px 圆点"，不带任何交互和网络请求。

**验收**：
- 刷新 GUI 后能看到圆点
- 浏览器控制台**无 error**
- DSH 其余功能（发消息、开设置、切会话）全部正常
- 关掉插件开关后圆点消失

> ★ P0 通过 = 地基通了。**P0 不过，后面全部免谈**。这一步不要夹带任何别的功能。

### P1 · 可拖动 + 位置持久化

- 拖动、松手保存、F5 后位置不变
- 拖动 < 4px 不误触
- 状态文件真的写进去了（去 `$DSH_HOME/.fish-orb-state.json` 看）

> ⭐ **用户追加需求（2026-10-17）**：原话「位置/大小 我觉得你完全可以在后期给它做成一个可以自主调节的功能」。
> ⇒ **位置和大小都不写死，做成用户可自主调节**：
> - 位置：本节的拖动 + 吸附 + 持久化；
> - 大小：面板里给一个「球大小」设置（建议 32–64px），落进同一个状态文件，默认 44px；
> - **P0 不实现**（P0 只验证"挂得上去"）；位置在 P1、大小随 P2 面板一起做。

### P2 · 面板壳

- 点球展开/收起，Esc 关闭
- 输入框能打字，Enter 发送（此时只打 console）
- 面板靠近右边缘时向左展开，不超出视口

### P3 · 打通 Host 链路（mock）

- `POST /dispatch.json` 返回 mock taskId
- 面板显示"已派发 #t1"，3s 后变"完成"
- 轮询生效，状态能刷新

> 到这一步，「前端 ↔ Host」的整条管子就是通的了。后面只是把 mock 换成真的。

### P4 · 真派发

- 设置里选一个**活着的**目标会话
- 发一句话 → 那个会话里真的出现插件投进来的消息
- 目标会话不在运行时，球上给出明确错误（"目标会话未运行，请先打开"）

### P5 · 结果回流 + 通知

- 任务完成后，球上小红点 + 面板里能看到结果摘要
- 未读 / 已读状态
- （可选）完成后播个音效，复用鲸鱼的音频文件

### P6 · 划词工具栏（可选，看心情）

- 页面内选中文字 → 选区上方浮出小条
- 搜索（开默认浏览器）/ 发到球里（填进输入框）

### P7 · 收尾

- `README.md` + `CHANGELOG.md` + `docs/DEVELOPMENT.md`
- `tools/smoke-test.mjs`（Host 侧自检：路由可达、状态文件可读写）
- 版本号、`engines` 对照

---

## 8. 复用清单（精确到文件 + 行号）

**全部是本工作区里已有的、跑通过的代码。别重写。**

| 要做的事 | 抄哪里 |
|---|---|
| Client 面加载骨架 + try 兜底 | `bili-duty\packages\bili-duty\lib\client.js:12-18` |
| 主题 token 样式表（一整套组件样式） | 同上，`client.js:24-70`（switch / chip / table / banner / input 全有） |
| 设置页组件（开关、下拉、表格、横幅） | 同上，`client.js` 全文 796 行 |
| 路由注册 + CORS + 异常兜底 | `bili-duty\packages\bili-duty\lib\index.js:1372-1401` |
| webServer 就绪二次探测 | 同上 `:1267-1317` |
| 唤醒会话投递消息 | 同上 `:892-946`（**注意 `source.kind`**） |
| 会话列表（选目标会话） | 同上 `:1008-1141`（`sessionQuery` 优先，`sessionController` 兜底） |
| 延迟投递 / 定时 | 同上 `:1966`（`ctx.timeout`） |
| 客户端模块资源路由 | 同上 `:1630`（`clientModules`） |
| 工具注册 | 同上 `:1716`（`ctx.get('tools')`） |
| 挂件吸附 / 翻转逻辑 | `大肥鱼记账\assets\whale-widget.js`（861KB bundle，搜「吸附」「snap」） |
| z 层级审计 | `大肥鱼记账\tools\z-layer-audit.mjs` |
| 重启 DSH 脚本 | `bili-duty\packages\bili-duty\tools\restart-dsh.ps1` |
| 自检脚手架 | `bili-duty\packages\bili-duty\tools\smoke-test.mjs`（53KB）+ `client-smoke-test.mjs`（13KB） |
| 界面文案 i18n | `bili-duty\packages\bili-duty\locale\` |
| 发布流程 | `bili-duty\packages\bili-duty\RELEASING.md` |

**两个样板项目的定位（别搞混）**：

- `E:\AI\deepseek\插件\大肥鱼刷B站\packages\bili-duty\` —— **Host 面 + Client 面双面插件**的完整工程（工具注册、设置页、路由、调度、测试、发布流程）。**这次的骨架就照它。**
- `E:\AI\deepseek\插件\大肥鱼记账\` —— **页面内常驻挂件**（右下角、吸附、音效、861KB 前端 bundle）。**形态参考它。**

---

## 9. 踩坑清单

1. **factory 里裸 throw → 整个应用起不来。** try/catch 必须包住整个 factory 体。
2. **容器 `pointer-events: none` + 球 `auto`。** 漏一个就整页点不动。
3. **`ctx.get('webServer')` 可能返回 undefined。** 用 `ctx.inject(['webServer'], cb)` 等。
4. **同名路由重复注册**会被 `duplicate exact route` 拒绝。
5. **`source.kind` 不能写 `"plugin"`**，session format v4 会拒。
6. **`client.js` 不能 `import '@deepseek-ai/*'`。** 只用 `require('react')` 和 fetch。
7. **别和鲸鱼挂件抢右下角。** 它常驻右下，球默认往上挪或记住用户拖的位置。
8. **拖动完会误触发点击。** 用位移阈值（4px）区分。
9. **改 `client.js` 要刷新页面；改 `lib/index.js`（Host 半）要重启 DSH。** 用 `tools/restart-dsh.ps1`。
10. **装完可能要重开客户端**（热生效不一定够，Orb 的 issue #162 也是这类问题）。
11. **状态文件别塞长文本**，结果摘要截断，否则每轮轮询都在传大 JSON。
12. **不要在标准模式试图装插件**——`plugin_manager` 那一行是 `disabled: true`，必须创造模式。

---

## 10. 安装与调试流程

```text
1. 确认模式：创造模式（cordis 预设）
2. plugin_manager  action: list_bundles          ← 看基线
3. plugin_manager  action: install_bundle
                   target: E:\AI\deepseek\插件\小肥鱼球\packages\dsh-fish-orb
4. 刷新 GUI（F5）；Host 半改动后重启 DSH
5. 出问题看：
   - 浏览器控制台（Client 侧）
   - DSH 应用日志 / 插件页的"导出日志"
   - GET /fish-orb/health.json 自检
```

**更新**：改完代码重新 `install_bundle` 同一个 target（会重装覆盖），或按 bili-duty 的 `DEVELOPMENT.md` 里的热更流程走。

---

## 11. 风险与明确不做的事

### 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 球压住 DSH 某些弹窗/菜单 | 操作被挡 | 面板可关、z-index 实测调整、必要时 modal 打开时临时隐藏球 |
| 目标会话不在运行就派不出去 | 派发失败 | UI 明确提示 + 会话列表里标"活跃"状态 |
| 轮询太频繁 | 无谓开销 | 面板关闭时降频/暂停 |
| Client 面拿不到会话流 | 面板看不到"正在跑什么" | 这是**已知的最大架构限制**：只能自己造 HTTP 通道，别指望复用现成的 |
| 和鲸鱼挂件重叠 | 视觉冲突 | 默认位置避让 + 可拖动 |

### 明确不做

- ❌ 桌面级鼠标键盘控制（Computer Use）
- ❌ 跨应用划词
- ❌ 屏幕区域截图 / 语音输入（Orb 自己也没有）
- ❌ 复制 Orb 的源码
- ❌ 一上来做 SSE/WebSocket（先用轮询证明链路）

---

## 12. 交接备忘（给下一条鱼）

1. **用户叫它「小肥鱼球」**，他管你叫「小肥鱼」。
2. 他的偏好：**事实要精准可溯源，不确定就明说，绝不编造**。他容忍幻觉的程度极低。
3. 他讨厌夸大——不能跑的别说成能跑，`未验证` 就标 `未验证`。
4. **每完成一段就汇报验收结果**，别一口气做到底再交。
5. 卡住时的正确姿势：先看第 9 节，再去看 bili-duty 对应实现，**不要自己发明 API**。
6. 如果他问「能不能浮在整个桌面上」——答案是**不能**，插件做不到，直说。
7. 参考仓库（只读，不要拷贝代码）：<https://github.com/mini-yifan/deepseek-harness-orb>
   - 值得学的是设计：双轨派发、球上答题、观察边框、相对坐标
   - 不值得学的是实现：它是 fork 的客户端，我们没有可比条件

---

## 附：一句话总结

**用 bili-duty 的骨架 + 鲸鱼挂件的形态，做一个只能活在 DSH 页面里的悬浮球；先 P0 把地基砸实，再一段一段往上垒。**
