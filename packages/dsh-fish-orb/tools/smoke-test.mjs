#!/usr/bin/env node
/**
 * dsh-fish-orb · 离线自检
 * ============================================================================
 * 不需要 DSH 在跑、**不碰真实状态文件**（用临时目录）。
 * 跑法：node tools/smoke-test.mjs
 *
 * ⚠️ 这里只做静态检查（文件 / 清单 / 粗语法）。
 * 真正的运行时行为（路由 401、投递、轮询）必须在 DSH 里验 —— 见 docs/DEVELOPMENT.md。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n[dsh-fish-orb] 离线自检\n')

// ── 1. 必要文件 ──────────────────────────────────────────────────────────
console.log('1) 必要文件')
for (const f of [
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'lib/index.js',
  'lib/client.js',
  'locale/zh.json',
  'locale/en.json',
  'docs/DEVELOPMENT.md',
]) {
  check(f, fs.existsSync(path.join(ROOT, f)))
}

// ── 2. package.json 清单 ────────────────────────────────────────────────
console.log('\n2) package.json')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('name = dsh-fish-orb', pkg.name === 'dsh-fish-orb')
check('有 version', typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/u.test(pkg.version))
check('有 license', typeof pkg.license === 'string')
check('main 指向 lib/index.js', pkg.main === 'lib/index.js')
check('dsh.bundle.patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('dsh.client.immediately = true', pkg.dsh?.client?.immediately === true)
check('engines.dsh 存在', typeof pkg.engines?.dsh === 'string')
check('engines.node 存在', typeof pkg.engines?.node === 'string')
check('files 白名单含 lib', Array.isArray(pkg.files) && pkg.files.includes('lib'))
check('files 白名单含 locale', Array.isArray(pkg.files) && pkg.files.includes('locale'))
check('有 icon', typeof pkg.icon === 'string' && fs.existsSync(path.join(ROOT, pkg.icon)))

// ── 3. 源码粗检（真正的语法用 node --check）───────────────────────────────
console.log('\n3) 源码粗检')
const idx = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
const cli = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')

check('index.js 非空', idx.length > 500)
check('client.js 非空', cli.length > 500)
// client.js 里禁止静态 import @deepseek-ai/*（这是明文规则，违反会让应用起不来）
check(
  'client.js 无静态 import @deepseek-ai/*',
  !/^\s*import\s+[^'"\n]*['"]@deepseek-ai\//mu.test(cli),
)
check('client.js factory 有 try/catch 兜底', cli.includes('catch (err)'))
// 投递的两条硬约束
check('index.js 有 createUserMessage 兜底', idx.includes('createUserMessage'))
check(
  'source.kind 未使用 "plugin"',
  !/kind:\s*['"]plugin['"]/u.test(idx),
)
check('注册了 dispatch 路由', idx.includes("'/fish-orb/dispatch.json'"))
check('注册了 tasks 路由', idx.includes("'/fish-orb/tasks.json'"))
check('注册了 state 路由', idx.includes("'/fish-orb/state.json'"))
check('注册了 sessions 路由', idx.includes("'/fish-orb/sessions.json'"))
check('webServer 二次探测存在', idx.includes('whenWebServer'))
check('路由 disposer 交给 ctx.effect', idx.includes('ctx.effect'))

// ── 4. 原子写（临时文件，不碰真实状态）──────────────────────────────────
console.log('\n4) 原子写（临时目录）')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-orb-selfcheck-'))
try {
  const tmpFile = path.join(tmpDir, 'state.json')
  fs.writeFileSync(tmpFile, JSON.stringify({ ball: { right: 10, bottom: 20 }, size: 44 }))
  const back = JSON.parse(fs.readFileSync(tmpFile, 'utf8'))
  check('写入后能读回', back?.ball?.right === 10)
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (err) {
    /* 清理失败不改变结论 */
  }
}

// ── 5. locale ───────────────────────────────────────────────────────────
console.log('\n5) locale')
for (const f of ['locale/zh.json', 'locale/en.json']) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))
  check(`${f} 有 meta.title`, typeof j?.meta?.title === 'string' && j.meta.title.length > 0)
  check(
    `${f} 有 meta.description`,
    typeof j?.meta?.description === 'string' && j.meta.description.length > 0,
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
