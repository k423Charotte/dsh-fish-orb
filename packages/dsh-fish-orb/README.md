# dsh-fish-orb · 小肥鱼球

> DSH 页面内的悬浮球：接一句话、派给后台会话跑、把结果收回来。
> **只在 DSH 页面里，不碰桌面控制** —— 跨应用置顶/划词需要原生窗口与系统级钩子，Web 插件做不到。

## 现在能做什么

| 能力 | 状态 |
| --- | --- |
| 页面内常驻小球，**可拖动**、**松手贴边吸附**，边缘不跑出视口 | ✅ |
| 位置 + 大小**可自主调节**（44–120px），落盘后刷新/重启不变 | ✅ |
| 球的样貌可换成**自定义图片**（jpg / png / webp，≤2MB） | ✅ |
| 点球展开面板，`Esc` 关闭，靠边自动反向展开 | ✅ |
| 面板里选**目标会话**（标注「运行中」/「未打开」） | ✅ |
| 发一句话 → **真投递**进目标会话 | ✅ |
| **定时任务**（每隔 N 分钟 / 每天 HH:MM），到点自动派发 | ✅ |
| **选中文字** → 浮出工具条：搜索 / 发到悬浮框里 | ✅ |
| **右键会话行** → 设为派发目标 / 复制标题 / 复制 id | ✅ |
| 目标会话没打开 / 没选 → **明确报错** | ✅ |
| 面板关着时收到新任务 → 球上**未读小红点** | ✅ |
| 会话 AI 的**真实回答**回流 | ❌ 未做（需读会话消息流） |

## 安装

装一个 DSH 插件，需要两步：**先把包弄到本地**，**再让 DSH 装上它**。下面三种方式选一种。

### 方式 A：从 npm 装（不需要 git，推荐）

**第 1 步：把包下载到本地**（不要装进 profile，装到任意临时目录即可）

```powershell
cd $env:TEMP
npm i dsh-fish-orb --registry=https://registry.npmjs.org/
```

**第 2 步：确认包目录在哪**

```powershell
$pkg = Join-Path $env:TEMP 'node_modules\dsh-fish-orb'
Test-Path $pkg        # 应该返回 True
$pkg                  # 把这里打印出来的路径复制下来
```

**第 3 步：让 DSH 装上它**

在 DSH 里（**创造模式 / cordis 预设**的会话，`plugin_manager` 只在那种模式下可用），让它调用：

```text
plugin_manager  action: install_bundle  target: <第 2 步打印的绝对路径>
```

看返回的 **`application`** 字段：`applied` 才算生效，别拿"终端没报错"当成功。

**第 4 步：重启 DSH**

Host 半的改动必须重启才加载（Client 半只需刷新页面）。

### 方式 B：从 GitHub 装

```powershell
git clone https://github.com/k423Charotte/dsh-fish-orb.git $env:TEMP\dsh-fish-orb
```

然后 `install_bundle` 的 target 指向 `$env:TEMP\dsh-fish-orb\packages\dsh-fish-orb`。

### 方式 C：`dsh plugin add`（⚠️ 未验证）

如果你装了 `dsh` 命令行工具：

```powershell
dsh plugin add dsh-fish-orb
```

**这条路我没验证过**（我本机没有 CLI）。成功或失败都欢迎反馈——它就是 README 里那条"未验证"的空白的来源。

## 卸载

```text
plugin_manager  action: remove_bundle  target: dsh-fish-orb
```

改 `lib/client.js` → **刷新页面**（F5）生效；改 `lib/index.js`（Host 半）→ **必须重启 DSH**；重装/升级 → 对同一个 target 再 `install_bundle` 一次。

## 用法

1. **拖动**：按住球移动，松手保存。位移 < 4px 算点击（不会误触展开）；靠近屏幕边缘松手会**吸附贴边**
2. **打开面板**：轻点球（再点一次或按 `Esc` 关闭）
3. **选会话**：面板里「派给哪个会话」——只有标了「运行中」的会话**能收到派发**（DSH 里没打开的会话派不出去）
4. **发送**：`Enter` 发送，`Shift+Enter` 换行
5. **调大小**：面板里的「球大小」滑块（**44–120px**，默认 64）
6. **换图片**：面板 →「选择图片」（jpg/png/webp，≤2MB）→「恢复默认」回到 🐟
7. **定时任务**：面板底部「定时任务」折叠区 → 写一句话 + 选「每隔 N 分钟」或「每天 HH:MM」→ 添加
8. **划词**：选中页面任意文字 → 选区上方浮出「搜索」「发到悬浮框里」
9. **右键会话行**：侧栏某个会话上右键 → 设为派发目标 / 复制标题 / 复制 id
10. **清空任务记录**：任务区右上角「清空」（DSH 重启时也会自动清一次）

## 状态文件

`$DSH_HOME/.fish-orb-state.json`（Windows 是 `%USERPROFILE%\.dsh\.fish-orb-state.json`）

```json
{
  "version": 1,
  "ball": { "right": 18, "bottom": 132 },
  "size": 64,
  "enabled": true,
  "target_session_id": "",
  "avatar": null,
  "tasks": [
    { "id": "t1", "text": "…", "status": "done", "createdAt": 1792253757743,
      "finishedAt": 1792253760743, "result": "已投递给会话 …", "sessionId": "…", "readAt": null }
  ],
  "schedules": [
    { "id": "s1", "text": "…", "sessionId": "…",
      "rule": { "kind": "interval", "everyMinutes": 30 },
      "enabled": true, "nextRunAt": 1792255200000, "lastRunAt": null, "lastResult": null }
  ]
}
```

- `size`：44–120（默认 64）；`avatar`：`null` = 默认 🐟，否则是 `png`/`jpeg`/`webp`
- `schedules[].rule.kind`：`once`（`at` ISO 时间）/ `interval`（`everyMinutes`）/ `daily`（`time: "HH:MM"`，本机时区）
- **任务与定时记录都是临时的**：DSH 重启时清空 `tasks`（定时任务 `schedules` 保留），面板里也有「清空」按钮

- 写入是**原子写**（随机临时名 + `wx` 独占 + `fsync` + 失败清理），写盘失败**不抛**
- 文件坏了会**自愈**（字段缺失/越界都补默认值）
- `tasks` 只保留最近 20 条，`result` 截断到 400 字

## 接口（Host 半）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/fish-orb/state.json` | 读球位置 / 大小 / 目标会话 / 任务 |
| PUT | `/fish-orb/state.json` | 合并写（只改传进来的字段） |
| GET | `/fish-orb/sessions.json` | 可选目标会话（工作区里真实存在的那些） |
| POST | `/fish-orb/dispatch.json` | 派一句话（`{ text }`） |
| GET | `/fish-orb/tasks.json` | 任务列表 + `unreadCount`（面板轮询它） |
| POST | `/fish-orb/tasks/read.json` | 标记已读（不传 `ids` = 全标） |
| GET | `/fish-orb/health.json` | 自检：webServer / agents 是否可用 |

全部走**来源校验**（Host 必须是回环；带 Origin/Referer 的必须是本机或 `dsh-app:`/`file:`/`chrome-extension:`）。
从命令行直接 `curl` 会被宿主的信任栅栏挡成 401 —— **这是正常的**，页面内 `fetch` 才带得上认证。

## 自检

```bash
node tools/smoke-test.mjs
```

离线可跑（不碰真实状态文件）。运行时行为仍需在 DSH 里验。

## 已知限制

- 只有**正在运行**的会话能收到派发
- 只在 **Windows + DSH 0.2.1-rc.2** 上验证过
- 会话标题取不到时会退到显示**工作目录名**
- 孤儿会话（磁盘有、工作区索引里没有）**不会**出现在下拉里 —— 这是故意的，否则会看到一堆"不存在的会话"

## 开发

踩坑清单（共 24 条，每条都有根因和取证）见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。
里面最值得先看的是：

- 第 17 条：`createUserMessage` 缺 `role` 会**永久污染会话**
- 第 18 条：`source.kind` **不能**是 `"plugin"`
- 第 10 条：`ctx.get('webServer')` 可能还没就绪 → 要二次探测
- 第 15 条：磁盘会话 ≠ 侧边栏会话（孤儿会话）

## 设计参考（只读，不拷代码）

- **骨架**：`bili-duty` —— Host + Client 双面插件的完整工程（路由、设置页、调度、测试、发布）
- **形态**：`dsh-whale-widget` —— 页面内常驻挂件、吸附、音效
- **产品设计**：[deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb) ——
  它是 fork 整个 dsh 的产物（50+ 包 workspace），本机是打包好的 `app.asar`，**代码搬不过来**；
  值得学的是设计：双轨派发、球上答题、相对坐标

## 许可

MIT
