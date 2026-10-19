/**
 * dsh-fish-orb —— Host 半
 * ============================================================================
 * P1 范围：只做「状态文件的读写」+ 三条路由，给页面里的球存/取位置与大小。
 *   · GET  /fish-orb/state.json    读状态
 *   · PUT  /fish-orb/state.json    合并写状态（JSON body）
 *   · GET  /fish-orb/health.json   自检
 *
 * P3 起才有 dispatch / tasks 路由；P4 才碰 agents。**现在不碰任何派发。**
 *
 * 硬约束（PLAN.md §2，照 bili-duty 里跑通的实现抄的）：
 *   · webServer 是**可选服务**，不能直接 ctx.get('webServer') 了事 —— 冷启动时它可能还没就绪，
 *     表现是 fiber active 但路由全 404。用 whenWebServer() 二次探测。
 *   · 路由的 disposer 必须交给 ctx.effect，否则重载时会 "duplicate exact route"。
 *   · 写盘失败**绝不抛**（曾有插件因 appendFileSync 抛 EBUSY 把整个宿主带走）。
 *   · 状态文件读坏了要能自愈（补默认值），不能把插件带崩。
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

/**
 * ⚠️ 构造注入消息**必须**补齐 `role` 与 `id`：手拼裸对象会往会话里存一条没有 `role` 的消息，
 * 此后该会话**每一次**请求都被网关拒绝（`messages[N]: missing field 'role'`）。
 * 这是 bili-duty 里最贵的一条教训（详见它的 docs/DEVELOPMENT.md 第 9 条），照抄它的写法：
 * **动态 import + 同步兜底** —— 静态 import 一旦失败会让整个插件模块加载不了，
 * 而这条路只影响"派发"一件事。
 */
let createUserMessage = (input) => ({ ...input, role: 'user', id: randomUUID() })
let createUserMessageSource = 'fallback(pending-official-load)'
void import('@deepseek-ai/dsh-llm').then((mod) => {
  if (typeof mod?.createUserMessage === 'function') {
    createUserMessage = mod.createUserMessage
    createUserMessageSource = 'official'
  } else {
    createUserMessageSource = 'fallback(no-createUserMessage-export)'
  }
}).catch((err) => {
  createUserMessageSource = `fallback(${String(err?.code || err?.message || err).slice(0, 60)})`
})

export const name = 'dsh-fish-orb'

/**
 * webServer 刻意**不**写进 inject：它是可选服务，用 whenWebServer 二次探测更稳。
 * P4 开始会需要 agents，同样按可选服务处理。
 */
export const inject = []

const VERSION = '0.1.0'

/** DSH 家目录：状态文件放这里（不进 node_modules，升级不丢）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.fish-orb-state.json')

/** 球的默认位置：右下偏上，**刻意避开小鲸鱼挂件**（它常驻右下角）。 */
const DEFAULT_BALL = { right: 18, bottom: 132 }
/** 球尺寸：默认 64，可调 44–120（用户 2026-10-18 指定；三处必须一致）。 */
const DEFAULT_SIZE = 64
const MIN_SIZE = 44
const MAX_SIZE = 120
/** 任务只留最近这么多条（避免每轮轮询都在传大 JSON）。 */
const MAX_TASKS = 20
/** P3 的 mock 状态机：pending 超过这么久，读接口的时候自动变 done。 */
const MOCK_DONE_AFTER_MS = 3000

/** 头像（球的自定义图片）：jpg / png / webp，上限 2 MB。 */
const FISH_ORB_HOME = path.join(DSH_HOME, 'fish-orb')
const AVATAR_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/**
 * 魔数校验：光看 dataURL 的 MIME 不够（可以随便写），要验真实文件头。
 * png: 89 50 4E 47；jpeg: FF D8 FF；webp: "RIFF"…"WEBP"。
 */
function looksLikeImage(buf, ext) {
  if (!buf || buf.length < 12) return false
  if (ext === 'png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (ext === 'jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (ext === 'webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  return false
}

/** 读当前头像（按状态文件里的 ext），没有 / 读失败都返回 null（调用方退回默认 🐟）。 */
function readAvatarFile() {
  try {
    const ext = String(readState().avatar || '')
    if (!ext || !AVATAR_MIME[ext]) return null
    const buf = fs.readFileSync(path.join(FISH_ORB_HOME, `avatar.${ext}`))
    return buf.length > 0 ? { ext, mime: AVATAR_MIME[ext], buf } : null
  } catch (err) {
    return null
  }
}

// ── 小工具（照抄 bili-duty 里跑通的实现）──────────────────────────────────

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (err) {
    /* 已存在或不可写，交给具体读写去处理 */
  }
}

function readJsonSafe(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (err) {
    return fallback
  }
}

/**
 * 原子写 JSON。⚠️ 不抛：写盘失败只如实返回（成败由调用方转成 HTTP 响应）。
 * 临时文件名随机 + 独占创建 + fsync + 失败清理（照 bili-duty 安全加固后的版本）。
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    ensureDir(path.dirname(file))
    const handle = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(tmp, file)
    return { ok: true, error: null }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch (cleanupErr) {
      /* 清理失败也不能再抛 */
    }
    return { ok: false, error: String(err?.message || err) }
  }
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

// ── 定时任务（形态参考 dsh-tauri-scheduler，只保留三种规则）────────────────

/** tick 间隔：30 秒一跳。够用，也不至于把 Host 吵醒太勤。 */
const SCHEDULE_TICK_MS = 30 * 1000
/** 单个任务最多保留多少条（防状态文件膨胀）。 */
const MAX_SCHEDULES = 50

/**
 * 校验并归一化规则。只支持三种：
 *   once     { kind:'once', at:'2026-10-18T12:00:00+08:00' }
 *   interval { kind:'interval', everyMinutes: 30 }
 *   daily    { kind:'daily', time:'08:00' }（本机时区）
 */
function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  if (r.kind === 'once') {
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN
    return Number.isFinite(at) ? { kind: 'once', at: new Date(at).toISOString() } : null
  }
  if (r.kind === 'interval') {
    return { kind: 'interval', everyMinutes: Math.round(clampNum(r.everyMinutes, 1, 60 * 24 * 7, 30)) }
  }
  if (r.kind === 'daily') {
    const t = String(r.time || '')
    return /^([01]\d|2[0-3]):([0-5]\d)$/u.test(t) ? { kind: 'daily', time: t } : null
  }
  return null
}

function normalizeSchedule(raw, index) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const rule = normalizeRule(s.rule)
  if (!rule) return null
  return {
    id: typeof s.id === 'string' && s.id ? s.id : `s${index + 1}`,
    text: String(s.text ?? '').slice(0, 200),
    sessionId: typeof s.sessionId === 'string' ? s.sessionId : '',
    rule,
    enabled: s.enabled !== false,
    nextRunAt: Number(s.nextRunAt) || null,
    lastRunAt: Number(s.lastRunAt) || null,
    lastResult: s.lastResult === null || s.lastResult === undefined ? null : String(s.lastResult).slice(0, 200),
  }
}

/**
 * 下一个触发时刻（严格 > from）。
 * ⚠️ 这是 dsh-tauri-scheduler 里 `latestDueOccurrence` 的简化对应物：
 * 它算"最近一个已到期时刻"，我们这里只算"下一个未来时刻"——
 * 目的相同：**到点只跑一次，绝不补跑堆积**。
 */
function nextOccurrence(rule, from) {
  try {
    if (rule.kind === 'once') {
      const at = Date.parse(rule.at)
      return Number.isFinite(at) && at > from ? at : null
    }
    if (rule.kind === 'interval') {
      return from + rule.everyMinutes * 60 * 1000
    }
    if (rule.kind === 'daily') {
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(rule.time || '')
      if (!m) return null
      const d = new Date(from)
      d.setHours(Number(m[1]), Number(m[2]), 0, 0)
      let t = d.getTime()
      if (t <= from) t += 24 * 60 * 60 * 1000
      return t
    }
  } catch (err) {
    /* 无效规则 */
  }
  return null
}

/**
 * 任务规范化：字段缺失 / 类型不对 / 过长都裁掉。
 * ⚠️ 别把长文本塞进状态文件（PLAN.md §9 坑 11）—— 面板轮询每轮都在传它。
 */
function normalizeTask(raw, index) {
  const t = raw && typeof raw === 'object' ? raw : {}
  const allowed = ['pending', 'running', 'done', 'failed']
  return {
    id: typeof t.id === 'string' && t.id ? t.id : `t${index + 1}`,
    text: String(t.text ?? '').slice(0, 200),
    status: allowed.includes(t.status) ? t.status : 'pending',
    createdAt: Number(t.createdAt) || Date.now(),
    finishedAt: Number(t.finishedAt) || null,
    result: t.result === null || t.result === undefined ? null : String(t.result).slice(0, 400),
    sessionId: typeof t.sessionId === 'string' ? t.sessionId : '',
    // P5：未读标记。null = 还没读过（球上要亮小红点）；数字 = 读过的时刻
    readAt: Number(t.readAt) || null,
  }
}

/**
 * P3 的 mock 状态机（**惰性推进**）：pending 超过 3 秒的任务，在读的那一刻自动变 done。
 * 为什么不用 ctx.timeout：每个任务都要排一个定时器、要清、还要跨进程持久化；
 * 读时计算没有这些负担，也不会泄漏。
 */
function advanceTasks(tasks) {
  const now = Date.now()
  return tasks.map((t) => {
    if (t.status === 'pending' && now - t.createdAt >= MOCK_DONE_AFTER_MS) {
      return {
        ...t,
        status: 'done',
        finishedAt: t.createdAt + MOCK_DONE_AFTER_MS,
        result: '（P3 mock：还没接真派发）',
      }
    }
    return t
  })
}

// ── 状态读写 ────────────────────────────────────────────────────────────

/**
 * 归一化：任何字段缺失 / 类型不对 / 越界，都补成安全默认值。
 * 状态文件是**用户可手改**的，一个坏字段不该让整颗球消失。
 */
function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const ballRaw = src.ball && typeof src.ball === 'object' ? src.ball : {}
  const ball = {
    right: clampNum(ballRaw.right, 0, 10000, DEFAULT_BALL.right),
    bottom: clampNum(ballRaw.bottom, 0, 10000, DEFAULT_BALL.bottom),
  }
  const tasks = Array.isArray(src.tasks) ? src.tasks.filter((t) => t && typeof t === 'object') : []
  return {
    version: 1,
    ball,
    size: clampNum(src.size, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE),
    enabled: src.enabled !== false,
    target_session_id: typeof src.target_session_id === 'string' ? src.target_session_id : '',
    // 头像扩展名（png / jpeg / webp），null = 用默认字符 🐟
    avatar: typeof src.avatar === 'string' && AVATAR_MIME[src.avatar] ? src.avatar : null,
    // 定时任务（规则无效的条目直接丢掉）
    schedules: (Array.isArray(src.schedules) ? src.schedules : [])
      .map(normalizeSchedule)
      .filter(Boolean)
      .slice(-MAX_SCHEDULES),
    tasks: tasks.map(normalizeTask).slice(-MAX_TASKS),
  }
}

function readState() {
  return normalizeState(readJsonSafe(STATE_FILE, {}))
}

/** 合并写：只改传进来的字段，其余保持（球的位置和大小不会互相顶掉）。 */
function saveState(patch) {
  const current = readState()
  const p = patch && typeof patch === 'object' ? patch : {}
  const merged = {
    ...current,
    ...p,
    ball: { ...current.ball, ...(p.ball && typeof p.ball === 'object' ? p.ball : {}) },
  }
  const clean = normalizeState(merged)
  const result = writeJsonAtomic(STATE_FILE, clean)
  return { ...result, state: clean }
}

/**
 * 宽容挖标题：不猜具体路径，按语义找第一个非空字符串。
 * 为什么这么写：`sessionQuery.readTitleSnapshots` 之类的返回结构没有公开契约，
 * 实测见过 `{ sessionId, observation: { title: { val: "..." } } }` 这种套娃，
 * 所以除了 title/name 还要能钻进去（bili-duty 的 deepFindTitle 是同一套思路）。
 */
function pickTitle(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return ''
  for (const key of ['title', 'name']) {
    const v = node[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    // 形如 { title: { val: "..." } }
    if (v && typeof v === 'object') {
      const inner = pickTitle(v, depth + 1)
      if (inner) return inner
    }
  }
  for (const key of ['session', 'identity', 'observation', 'value', 'val', 'snapshot']) {
    const found = pickTitle(node[key], depth + 1)
    if (found) return found
  }
  return ''
}

/**
 * 收集会话列表。**三层来源**（照 bili-duty 的 listSessions，它踩过只用 agents.list 的坑）：
 *   1. `sessionQuery.listSessions()` —— 全量持久化会话（首选）
 *   2. `sessionController.list()`    —— 兜底
 *   3. `agents.list()`              —— 只用来标「谁此刻活着」（只有活着的能收派发）
 */
async function collectSessions(ctx, log) {
  const live = new Map()
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const a of agents.list() || []) {
        const id = String(a?.id ?? a?.session?.id ?? '')
        if (id) live.set(id, { status: String(a?.status ?? ''), agent: a })
      }
    }
  } catch (err) {
    /* 活标记拿不到只是少了标注，不影响列会话 */
  }

  const out = []
  const seen = new Set()
  let source = 'none'
  const index = readWorkspaceIndex()   // 侧边栏真正显示的会话集合（用来滤掉孤儿 / 归档）
  const debugSampleKeys = []      // 前几条记录的**键名**（不含值），排障用
  // ⚠️ 必须 let：下面在拿到 records 后会整体重新赋值（const 会抛 Assignment to constant variable）
  let debugKeySamples = debugSampleKeys
  let hiddenCount = 0             // 被过滤掉的（归档 / 孤儿 / 隐藏）会话数

  // 首选：sessionQuery（全量）
  try {
    const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      const records = await sessionQuery.listSessions(new AbortController().signal)
      if (Array.isArray(records)) {
        source = 'sessionQuery'
        // 回吐样本键名（不含值），便于确认"归档"到底用哪个字段标记
        debugKeySamples = records.slice(0, 3).map((r) => (r && typeof r === 'object' ? Object.keys(r) : []))
        for (const r of records) {
          const id = String(r?.id ?? r?.sessionId ?? r?.session?.id ?? '')
          if (!id || seen.has(id)) continue
          const bare = bareId(id)
          // ① 归档区里的 ② 不在任何工作区索引里的（孤儿会话）③ record 上带隐藏标记的
          if (index.archived.has(bare) || (index.readable && !index.valid.has(bare)) || isHiddenSession(r)) {
            hiddenCount += 1
            continue
          }
          seen.add(id)
          out.push({
            id,
            title: pickTitle(r),
            cwd: String(r?.cwd ?? r?.identity?.cwd ?? r?.session?.cwd ?? ''),
            live: live.has(id),
            status: live.get(id)?.status ?? '',
          })
        }
      }
    }
  } catch (err) {
    log('sessionQuery 列会话失败：', String(err?.message || err))
  }

  // 次选：sessionController
  if (out.length === 0) {
    try {
      const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      if (sc && typeof sc.list === 'function') {
        const value = await sc.list({}, new AbortController().signal)
        const items = Array.isArray(value) ? value : (value?.sessions ?? value?.items ?? value?.entries ?? [])
        if (Array.isArray(items)) {
          source = 'sessionController'
          for (const it of items) {
            const id = String(it?.id ?? it?.sessionId ?? it?.session?.id ?? '')
            if (!id || seen.has(id)) continue
            const bare = bareId(id)
            if (index.archived.has(bare) || (index.readable && !index.valid.has(bare)) || isHiddenSession(it)) {
              hiddenCount += 1
              continue
            }
            seen.add(id)
            out.push({
              id,
              title: pickTitle(it),
              cwd: String(it?.cwd ?? it?.workspacePath ?? it?.session?.cwd ?? ''),
              live: live.has(id),
              status: live.get(id)?.status ?? '',
            })
          }
        }
      }
    } catch (err) {
      log('sessionController 列会话失败：', String(err?.message || err))
    }
  }

  // 补标题：listSessions() 只给 id，标题要单独批量取（bili-duty 的 listSessions 也做了这一步）
  if (out.length > 0) {
    try {
      const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
      if (sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function') {
        const results = await sessionQuery.readTitleSnapshots(out.map((s) => s.id), new AbortController().signal)
        if (Array.isArray(results)) {
          for (const r of results) {
            const id = String(r?.sessionId ?? r?.id ?? r?.session?.id ?? '')
            const title = pickTitle(r)
            if (!id || !title) continue
            const hit = out.find((s) => s.id === id)
            if (hit && !hit.title) hit.title = title
          }
        }
      }
    } catch (err) {
      log('readTitleSnapshots 补标题失败：', String(err?.message || err))
    }
  }

  // 补：活着但不在全量列表里的（比如刚建还没落盘）
  for (const [id, info] of live) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      title: pickTitle(info.agent?.session) || pickTitle(info.agent),
      live: true,
      status: info.status,
    })
  }

  // 活着的排前面（能立刻收派发）
  out.sort((a, b) => (a.live === b.live ? 0 : a.live ? -1 : 1))
  return { sessions: out, source, liveCount: live.size, hiddenCount, debugSampleKeys: debugKeySamples }
}

/**
 * 会话 id 归一化：工作区索引里存的是 `session-<uuid>`，而别处可能只给裸 uuid。
 * 比较前统一去掉 `session-` 前缀，否则两边永远匹配不上。
 */
function bareId(id) {
  return String(id || '').replace(/^session-/u, '')
}

/**
 * 读 DSH 的工作区索引，得到"**侧边栏真正显示**的会话集合"。
 *
 * 为什么必须这么做：`sessionQuery.listSessions()` 返回的是**磁盘上所有会话**，
 * 其中有一批**孤儿会话**（曾经创建过，但没登记进任何工作区）——
 * 侧边栏按 `tables.workspaces[*].sessionIds` 显示，所以你在界面上根本看不到它们，
 * 而它们会出现在派发下拉里，表现为"不存在的会话"（用户实测反馈）。
 *
 * 另外 `global.archivedSessionIds` 是真正的归档列表（侧边栏归档区）。
 */
function readWorkspaceIndex() {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json')
  const data = readJsonSafe(file, null)
  const valid = new Set()
  const archived = new Set()
  try {
    const archivedIds = data?.global?.archivedSessionIds
    if (Array.isArray(archivedIds)) for (const id of archivedIds) archived.add(bareId(id))
    const workspaces = data?.tables?.workspaces
    if (workspaces && typeof workspaces === 'object') {
      for (const ws of Object.values(workspaces)) {
        const ids = ws?.sessionIds
        if (Array.isArray(ids)) for (const id of ids) valid.add(bareId(id))
      }
    }
  } catch (err) {
    /* 索引读不出来就退化成"不过滤"，总比一条都不显示好 */
  }
  return { valid, archived, readable: valid.size > 0 }
}

/**
 * 判断一条会话记录是否"不该出现在派发下拉里"（归档 / 删除 / 隐藏）。
 *
 * ⚠️ 这段按字段猜是**不够**的（实测 DSH 用的是工作区索引，不是 record 上的标记），
 * 真正管用的是 collectSessions 里的 readWorkspaceIndex 过滤；这里只作为额外防线。
 */
function isHiddenSession(record) {
  if (!record || typeof record !== 'object') return false
  const flags = ['archived', 'isArchived', 'deleted', 'isDeleted', 'hidden', 'isHidden']
  for (const key of flags) {
    if (record[key] === true) return true
  }
  const stamps = ['archivedAt', 'deletedAt', 'hiddenAt', 'trashedAt']
  for (const key of stamps) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return true
  }
  return false
}

/**
 * 把一句话投递给指定会话。dispatch 路由与定时任务**共用这一份**，
 * 避免两处逻辑各自演变成不同行为（这正是最容易埋 bug 的地方）。
 * 返回 `{ ok, code, error }`，不 throw。
 */
function deliverToSession(ctx, sessionId, text) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (!agents || typeof agents.get !== 'function') {
    return { ok: false, code: 'NO_AGENTS', error: 'agents 服务不可用，无法派发' }
  }
  const agent = agents.get(sessionId)
  if (!agent || typeof agent.followup !== 'function') {
    return { ok: false, code: 'NO_SESSION', error: '目标会话未运行，请先在 DSH 里打开它再试' }
  }
  try {
    // ⚠️ source.kind 不能是 "plugin"；createUserMessage 必须补齐 role/id
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'fish-orb' },
    }))
  } catch (err) {
    return { ok: false, code: 'FOLLOWUP_FAILED', error: `投递失败：${String(err?.message || err)}` }
  }
  return { ok: true }
}

// ── Host 插件本体 ──────────────────────────────────────────────────────

export function apply(ctx) {
  const log = (...args) => {
    try { console.log('[dsh-fish-orb]', ...args) } catch (ignored) {}
  }

  // ── webServer 就绪二次探测（照抄 bili-duty）────────────────────────
  const webServerWaiters = []
  let webServerRef = null

  function whenWebServer(callback) {
    if (webServerRef) {
      callback(webServerRef)
      return
    }
    webServerWaiters.push(callback)
    if (webServerWaiters.length > 1) return

    const flush = (server) => {
      webServerRef = server
      for (const waiter of webServerWaiters.splice(0)) {
        try {
          waiter(server)
        } catch (err) {
          log('webServer 就绪回调出错：', String(err?.message || err))
        }
      }
    }

    const immediate = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (immediate && typeof immediate.register === 'function') {
      flush(immediate)
      return
    }

    if (typeof ctx.inject !== 'function') {
      webServerWaiters.length = 0
      log('webServer 不可用且无 ctx.inject：路由没注册（球的位置将无法持久化）')
      return
    }
    ctx.inject(['webServer'], (scoped) => {
      const late = scoped && typeof scoped.get === 'function' ? scoped.get('webServer') : scoped?.webServer
      if (late && typeof late.register === 'function') flush(late)
      else log('webServer 注入后仍不可用：路由没注册')
    })
  }

  // ── HTTP 工具 ──────────────────────────────────────────────────────
  function json(res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  }

  function readBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /**
   * 来源校验（防 CSRF / DNS rebinding），规则与 bili-duty 一致：
   *   1. Host 头必须是回环；
   *   2. 带 Origin/Referer 的必须是本机或应用自身协议（dsh-app: / file: / chrome-extension:）；
   *   3. 宿主信任栅栏可用时交给它终审（fail-closed）。
   */
  function requestRejection(req) {
    const headers = (req && req.headers) || {}

    const host = String(headers.host || '')
    if (host && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(host)) return 403

    const source = String(headers.origin || headers.referer || '')
    if (source) {
      try {
        const url = new URL(source)
        const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
        const ownScheme = url.protocol === 'dsh-app:' || url.protocol === 'file:' || url.protocol === 'chrome-extension:'
        if (!loopback && !ownScheme) return 403
      } catch (err) {
        return 403
      }
    }

    try {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (connection && typeof connection.requestRejection === 'function') {
        const code = connection.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) {
          return typeof code === 'number' ? code : 403
        }
      }
    } catch (err) {
      return 403
    }
    return null
  }

  /** 注册路由：统一套来源校验 + 异常兜底，disposer 交给 ctx.effect。 */
  function registerRoute(route) {
    const inner = typeof route.handler === 'function' ? route.handler : null
    if (!inner) return

    const guarded = {
      ...route,
      handler: async (req, res) => {
        const denied = requestRejection(req)
        if (denied !== null) {
          try { json(res, denied, { ok: false, error: `已拒绝该请求（来源或 Host 不受信，code=${denied}）` }) } catch (ignored) {}
          return
        }
        try {
          await inner(req, res)
        } catch (err) {
          log(`路由 ${route.path} 处理失败：`, String(err?.message || err))
          try { json(res, 500, { ok: false, error: String(err?.message || err) }) } catch (ignored) {}
        }
      },
    }

    whenWebServer((webServer) => {
      ctx.effect(() => {
        const dispose = webServer.register(guarded)
        return () => {
          try { if (typeof dispose === 'function') dispose() } catch (err) { /* 释放失败不阻塞卸载 */ }
        }
      })
    })
  }

  // ── 路由 ──────────────────────────────────────────────────────────

  registerRoute({
    kind: 'exact',
    path: '/fish-orb/state.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()

      if (method === 'GET' || method === 'HEAD') {
        json(res, 200, { ok: true, state: readState(), file: STATE_FILE })
        return
      }
      if (method !== 'PUT' && method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 GET / PUT' })
        return
      }

      const text = await readBody(req)
      let patch = null
      try {
        patch = JSON.parse(text || '{}')
      } catch (err) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        return
      }

      const saved = saveState(patch)
      if (!saved.ok) {
        json(res, 500, { ok: false, error: `状态没写进盘：${saved.error}` })
        return
      }
      json(res, 200, { ok: true, state: saved.state })
    },
  })

  /**
   * P4：会话列表（给面板的「派给哪个会话」下拉用）。
   * 三层来源照 bili-duty 的 listSessions：sessionQuery（全量）→ sessionController（兜底）→ agents.list（只标活）。
   *
   * ⚠️ **只列 `agents.list()` 是错的**：它给的是"当前进程里活着的 agent"，
   * 而用户有一整列会话 —— 于是下拉里只有一个甚至空（bili-duty 踩过，我们 P4 第一版也踩了）。
   * 现在全量列出并标 live；没打开的会话派不出去，UI 里标「未打开」。
   */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/sessions.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      const collected = await collectSessions(ctx, log)
      json(res, 200, {
        ok: true,
        sessions: collected.sessions,
        current: readState().target_session_id,
        available: collected.sessions.length > 0 || collected.source !== 'none',
        source: collected.source,
        liveCount: collected.liveCount,
        hiddenCount: collected.hiddenCount,
        // 排障用：前几条记录的键名（不含值）。
        // 若"不存在的会话"仍出现，看这里有没有 archivedAt / deletedAt 之类的字段名不同。
        debugKeySamples: collected.debugSampleKeys,
      })
    },
  })

  /**
   * P3：建任务（**mock，不派发**）。
   * 返回 taskId 与任务对象；3 秒后再读 tasks.json 会看到它变 done —— 这就是"管子通了"的证明。
   */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/dispatch.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 POST' })
        return
      }

      const text = await readBody(req, 16 * 1024)
      let payload = null
      try {
        payload = JSON.parse(text || '{}')
      } catch (err) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }

      const userText = String(payload?.text ?? '').trim().slice(0, 200)
      if (!userText) {
        json(res, 400, { ok: false, error: 'text 不能为空' })
        return
      }

      // ── P4：真派发（照抄 bili-duty 的 fire()）──────────────────────
      const current = readState()
      const targetId = String(current.target_session_id || '').trim()
      if (!targetId) {
        json(res, 400, { ok: false, code: 'NO_TARGET', error: '还没选目标会话：在面板里选一个「正在运行」的会话' })
        return
      }

      // 投递逻辑与定时任务共用（deliverToSession），避免两处行为漂移
      const delivered = deliverToSession(ctx, targetId, userText)
      if (!delivered.ok) {
        json(res, delivered.code === 'NO_SESSION' ? 400 : 500, {
          ok: false,
          code: delivered.code,
          error: delivered.error,
        })
        return
      }

      const seq = current.tasks.length + 1
      const task = normalizeTask({
        id: `t${seq}`,
        text: userText,
        status: 'done',
        createdAt: Date.now(),
        finishedAt: Date.now(),
        result: `已投递给会话 ${targetId.slice(0, 8)}…（P4：投递成功；结果回流是 P5）`,
        sessionId: targetId,
      }, seq - 1)

      const saved = saveState({ tasks: [...current.tasks, task] })
      if (!saved.ok) {
        json(res, 500, { ok: false, error: `消息已投递，但任务没写进盘：${saved.error}` })
        return
      }

      json(res, 200, { ok: true, task, mode: 'live', createUserMessage: createUserMessageSource })
    },
  })

  /** P3：读任务列表（惰性推进 mock 状态；推进后顺手落盘，保证下次读一致）。 */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/tasks.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: '只支持 GET' })
        return
      }

      const current = readState()
      const advanced = advanceTasks(current.tasks)
      const changed = advanced.some((t, i) => t.status !== current.tasks[i]?.status)
      if (changed) {
        const saved = saveState({ tasks: advanced })
        if (!saved.ok) log('任务状态推进没写进盘：', saved.error)
      }
      const unreadCount = advanced.filter((t) => t.readAt == null).length

      json(res, 200, { ok: true, tasks: advanced, unreadCount, now: Date.now() })
    },
  })

  /** P5：标记任务已读（body 里给 `ids` 就标这些，不给就全部标）。 */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/tasks/read.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const text = await readBody(req, 16 * 1024)
      let payload = {}
      try {
        payload = JSON.parse(text || '{}')
      } catch (err) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const ids = Array.isArray(payload?.ids) ? payload.ids.map(String) : []
      const current = readState()
      const now = Date.now()
      let marked = 0
      const tasks = current.tasks.map((t) => {
        if (t.readAt != null) return t
        if (ids.length > 0 && !ids.includes(t.id)) return t
        marked += 1
        return { ...t, readAt: now }
      })
      const saved = saveState({ tasks })
      if (!saved.ok) {
        json(res, 500, { ok: false, error: `已读标记没写进盘：${saved.error}` })
        return
      }
      json(res, 200, { ok: true, marked, unreadCount: tasks.filter((t) => t.readAt == null).length })
    },
  })

  /** P5：清空任务记录（面板里的「清空」按钮用；DSH 重启时也会自动清一次）。 */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/tasks/clear.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const saved = saveState({ tasks: [] })
      if (!saved.ok) {
        json(res, 500, { ok: false, error: `清空没写进盘：${saved.error}` })
        return
      }
      json(res, 200, { ok: true, tasks: [], unreadCount: 0 })
    },
  })

  /** P7：头像二进制（客户端把它当球的背景图；没设置就 404，客户端退回默认 🐟）。 */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/avatar',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      const avatar = readAvatarFile()
      if (!avatar) {
        json(res, 404, { ok: false, error: '还没设置头像' })
        return
      }
      res.writeHead(200, {
        'Content-Type': avatar.mime,
        'Cache-Control': 'no-cache',
        'Content-Length': String(avatar.buf.length),
      })
      res.end(avatar.buf)
    },
  })

  /**
   * P7：头像管理。
   *   GET    读当前状态（扩展名 + 访问地址）
   *   PUT    上传：body `{ dataUrl: "data:image/png;base64,…" }`（≤2MB，验魔数）
   *   DELETE 恢复默认（🐟）
   */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/avatar.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()

      if (method === 'GET' || method === 'HEAD') {
        const ext = readState().avatar || null
        json(res, 200, {
          ok: true,
          avatar: ext,
          url: ext ? `/fish-orb/avatar?v=${ext}` : null,
          accept: Object.keys(AVATAR_MIME),
          maxBytes: AVATAR_MAX_BYTES,
        })
        return
      }

      if (method === 'DELETE') {
        for (const ext of Object.keys(AVATAR_MIME)) {
          try { fs.rmSync(path.join(FISH_ORB_HOME, `avatar.${ext}`), { force: true }) } catch (err) { /* 忽略 */ }
        }
        saveState({ avatar: null })
        json(res, 200, { ok: true, avatar: null })
        return
      }

      if (method !== 'PUT') {
        json(res, 405, { ok: false, error: '只支持 GET / PUT / DELETE' })
        return
      }

      // dataURL 比原文件大约 1.37 倍，留足余量
      const text = await readBody(req, 8 * 1024 * 1024)
      let payload = null
      try {
        payload = JSON.parse(text || '{}')
      } catch (err) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }

      const dataUrl = String(payload?.dataUrl || '')
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl)
      if (!m) {
        json(res, 400, { ok: false, error: '只接受 png / jpeg / webp 的 base64 dataURL' })
        return
      }
      const ext = m[1]
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length === 0) {
        json(res, 400, { ok: false, error: '图片是空的' })
        return
      }
      if (buf.length > AVATAR_MAX_BYTES) {
        json(res, 413, { ok: false, error: `图片太大（${Math.round(buf.length / 1024)}KB > 2048KB）` })
        return
      }
      if (!looksLikeImage(buf, ext)) {
        json(res, 415, { ok: false, error: '文件头与声明的格式不符（拒绝伪装文件）' })
        return
      }

      ensureDir(FISH_ORB_HOME)
      // 先清掉其它扩展名，避免读取时拿到旧图
      for (const other of Object.keys(AVATAR_MIME)) {
        try { fs.rmSync(path.join(FISH_ORB_HOME, `avatar.${other}`), { force: true }) } catch (err) { /* 忽略 */ }
      }
      try {
        fs.writeFileSync(path.join(FISH_ORB_HOME, `avatar.${ext}`), buf, { mode: 0o600 })
      } catch (err) {
        json(res, 500, { ok: false, error: `头像没写进盘：${String(err?.message || err)}` })
        return
      }
      const saved = saveState({ avatar: ext })
      if (!saved.ok) {
        json(res, 500, { ok: false, error: `头像已写盘，但状态没保存：${saved.error}` })
        return
      }
      json(res, 200, { ok: true, avatar: ext, url: `/fish-orb/avatar?v=${ext}`, bytes: buf.length })
    },
  })

  /** 定时任务：GET 列表 / POST 创建 / PUT 更新 / DELETE 删除。 */
  registerRoute({
    kind: 'exact',
    path: '/fish-orb/schedules.json',
    handler: async (req, res) => {
      const method = String(req?.method || 'GET').toUpperCase()
      const state = readState()

      if (method === 'GET' || method === 'HEAD') {
        json(res, 200, { ok: true, schedules: state.schedules, now: Date.now() })
        return
      }

      const rawBody = await readBody(req, 16 * 1024)
      let payload = {}
      try {
        payload = JSON.parse(rawBody || '{}')
      } catch (err) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        return
      }

      if (method === 'DELETE') {
        const id = String(payload.id || '')
        if (!id) {
          json(res, 400, { ok: false, error: '需要 id' })
          return
        }
        const left = state.schedules.filter((s) => s.id !== id)
        if (left.length === state.schedules.length) {
          json(res, 404, { ok: false, error: '没这条任务' })
          return
        }
        saveState({ schedules: left })
        json(res, 200, { ok: true, schedules: left })
        return
      }

      if (method === 'PUT') {
        const id = String(payload.id || '')
        const hit = state.schedules.find((s) => s.id === id)
        if (!hit) {
          json(res, 404, { ok: false, error: '没这条任务' })
          return
        }
        const merged = normalizeSchedule({ ...hit, ...payload, id }, 0)
        if (!merged) {
          json(res, 400, { ok: false, error: '规则无效（once / interval / daily）' })
          return
        }
        // 规则或开关变了就重算下一次；关闭时清空
        merged.nextRunAt = merged.enabled ? nextOccurrence(merged.rule, Date.now()) : null
        const list = state.schedules.map((s) => (s.id === id ? merged : s))
        saveState({ schedules: list })
        json(res, 200, { ok: true, schedule: merged, schedules: list })
        return
      }

      if (method !== 'POST') {
        json(res, 405, { ok: false, error: '只支持 GET / POST / PUT / DELETE' })
        return
      }

      const taskText = String(payload.text ?? '').trim().slice(0, 200)
      const rule = normalizeRule(payload.rule)
      if (!taskText) {
        json(res, 400, { ok: false, error: 'text 不能为空' })
        return
      }
      if (!rule) {
        json(res, 400, { ok: false, error: 'rule 无效：只支持 once / interval / daily' })
        return
      }
      const seq = state.schedules.length + 1
      const created = normalizeSchedule({
        id: `s${seq}`,
        text: taskText,
        rule,
        sessionId: typeof payload.sessionId === 'string' && payload.sessionId
          ? payload.sessionId
          : state.target_session_id,
        enabled: payload.enabled !== false,
      }, seq - 1)
      created.nextRunAt = created.enabled ? nextOccurrence(created.rule, Date.now()) : null
      const list = [...state.schedules, created].slice(-MAX_SCHEDULES)
      saveState({ schedules: list })
      json(res, 200, { ok: true, schedule: created, schedules: list })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/fish-orb/health.json',
    handler: async (req, res) => {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      let stateFileExists = false
      try { stateFileExists = fs.existsSync(STATE_FILE) } catch (err) { /* 忽略 */ }
      json(res, 200, {
        ok: true,
        plugin: 'dsh-fish-orb',
        version: VERSION,
        stateFile: STATE_FILE,
        stateFileExists,
        webServerReady: Boolean(webServerRef),
        services: {
          agents: agents ? typeof agents : 'unavailable',
          connection: typeof ctx.get === 'function' ? typeof ctx.get('connection') : 'n/a',
        },
      })
    },
  })

  // ── 定时任务 tick（形态参考 dsh-tauri-scheduler）─────────────────────
  // 关键设计（抄它的）：
  //   ① tickInFlight 防重入 —— 上一跳没跑完就跳过下一跳；
  //   ② 到点只投递一次，nextRunAt 推到下一个未来时刻 —— **绝不补跑堆积**；
  //   ③ 投递失败也推进 nextRunAt（否则同一次会每跳重试一次）。
  let tickInFlight = false

  async function tickSchedules() {
    const state = readState()
    const now = Date.now()
    const due = state.schedules.filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= now)
    if (due.length === 0) return

    const updates = new Map()
    for (const s of due) {
      const result = s.sessionId && s.text ? deliverToSession(ctx, s.sessionId, s.text) : { ok: false, error: '任务缺会话或内容', code: 'INVALID' }
      const next = nextOccurrence(s.rule, now)
      updates.set(s.id, {
        lastRunAt: now,
        lastResult: result.ok ? '已投递' : String(result.error || '投递失败'),
        nextRunAt: next,
      })
      log(`定时任务 ${s.id} ${result.ok ? '已投递' : `失败(${result.code || ''})：${result.error}`}`)
    }

    saveState({ schedules: state.schedules.map((s) => (updates.has(s.id) ? { ...s, ...updates.get(s.id) } : s)) })
  }

  const tickTimer = setInterval(() => {
    if (tickInFlight) return
    tickInFlight = true
    void tickSchedules()
      .catch((err) => log('tick 出错：', String(err?.message || err)))
      .finally(() => { tickInFlight = false })
  }, SCHEDULE_TICK_MS)
  try { ctx.effect(() => () => clearInterval(tickTimer)) } catch (err) { /* 卸载时释放 */ }

  // P5：任务只是**临时记录** —— DSH 重启即视为一次新的运行周期，清掉上一次的旧任务。
  // （用户要求：这类数据不该长期留在盘上；面板里另有手动「清空」按钮）
  try {
    const before = readState()
    if (before.tasks.length > 0) {
      saveState({ tasks: [] })
      log(`启动清理：清掉 ${before.tasks.length} 条上次运行留下的任务`)
    }
  } catch (err) {
    /* 清理失败不影响启动 */
  }

  log(`已激活（v${VERSION}）｜状态文件 ${STATE_FILE}`)
}
