/**
 * dsh-fish-orb —— Client 半（P2：面板壳）
 * ============================================================================
 * 形态：静态客户端模块，按官方 templates/decoration 的 `window.__ModuleLoader__.load`
 * 约定注册一个惰性 factory。
 *
 * ⚠️ 三条硬约束（都踩过，见 PLAN.md §2 / §9）：
 *   1. factory 体里任何 throw 都会让这个 entry `failed`，而 web boot 把 entry failed
 *      当**致命** —— 用户看到的就是「应用无法启动」。所以整个 factory 包一层 try/catch。
 *   2. 这里**不能** import '@deepseek-ai/*'（明文禁止）。只用 DOM / fetch。
 *   3. 容器 `pointer-events:none` + 球/面板 `pointer-events:auto` 必须成对。
 *
 * 阶段范围：
 *   P1 ✅ 拖动 + 松手落盘 + F5 后位置不变（位移 < 4px 视为点击）
 *   P2 ← 本阶段：点球展开面板 / Esc 关闭 / 输入框 Enter 只打 console / 靠边反向展开 /
 *          **球大小可调（用户追加需求：32–64px 滑块，落盘）**
 *   P3 起才接 Host 的派发；P2 不打任何网络写请求（除了 P1 已有的位置/大小落盘）。
 *
 * ── P0/P1 实测踩到的坑（已固化在代码里，别改回去）────────────────────
 *   a. `--dsw-alias-label-primary-foreground` 不存在；`brand-primary` 浅色下近黑；
 *      `bg-overlay` 是深色浮层色 ⇒ 球的底色用 `bg-layer-1`，且每个 var() 都带 fallback。
 *   b. 关键样式写 inline（走 <style> 时 border-radius 曾表现怪异）。
 *   c. 形状/位置不依赖 CSS 圆角；坐标一律 Math.round（否则状态文件写进 440.0000305175781）。
 *   d. 拖动必须 setPointerCapture，否则指针移出球就丢 pointerup。
 */

window.__ModuleLoader__.load({
  id: 'dsh-fish-orb',
  factory() {
    try {
      const ROOT_ID = 'fish-orb-root'
      const API = '/fish-orb/state.json'
      const CLICK_THRESHOLD = 4      // 位移小于这个值算点击
      const SAVE_DEBOUNCE_MS = 500
      const PANEL_WIDTH = 320
      const PANEL_GAP = 10

      /** 本地状态（与 Host 状态文件同形，只关心球 / 目标会话）。 */
      let state = { ball: { right: 18, bottom: 132 }, size: 44, target_session_id: '', sessionsList: [] }
      let root = null
      let ball = null
      let panel = null
      let input = null
      let sizeRange = null
      let open = false
      let dragging = false
      let startX = 0
      let startY = 0
      let startRight = 0
      let startBottom = 0
      let movedMax = 0
      let saveTimer = null

      function clampNum(v, min, max, fallback) {
        const n = Number(v)
        if (!Number.isFinite(n)) return fallback
        return Math.min(Math.max(n, min), max)
      }

      function log(...args) {
        try { console.log('[fish-orb]', ...args) } catch (ignored) {}
      }

      // ── 渲染 ────────────────────────────────────────────────────────

      function render() {
        if (!ball) return
        const size = clampNum(state.size, 44, 120, 64)
        const maxRight = Math.max(0, window.innerWidth - size)
        const maxBottom = Math.max(0, window.innerHeight - size)
        const right = Math.round(clampNum(state.ball.right, 0, maxRight, 18))
        const bottom = Math.round(clampNum(state.ball.bottom, 0, maxBottom, 132))
        state.ball = { right, bottom }
        state.size = size
        ball.style.width = size + 'px'
        ball.style.height = size + 'px'
        ball.style.fontSize = Math.round(size * 0.45) + 'px'
        ball.style.right = right + 'px'
        ball.style.bottom = bottom + 'px'
        if (sizeRange) sizeRange.value = String(size)
        if (open) positionPanel()
      }

      /** 面板定位：球靠右就向左展开，靠左就向右展开；垂直方向向上生长并 clamp 在视口内。 */
      function positionPanel() {
        if (!panel || !ball) return
        const size = state.size
        const ballLeft = window.innerWidth - state.ball.right - size
        const ballTop = window.innerHeight - state.ball.bottom - size
        const pw = Math.min(PANEL_WIDTH, Math.max(220, window.innerWidth - 16))
        const ph = panel.offsetHeight || 220

        const spaceRight = window.innerWidth - (ballLeft + size)
        const openToLeft = spaceRight < pw + PANEL_GAP
        let left
        if (openToLeft) {
          left = ballLeft - pw - PANEL_GAP
          if (left < 8) left = 8
        } else {
          left = ballLeft + size + PANEL_GAP
          if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8
        }
        // 底边大致与球底齐平，然后 clamp
        let top = ballTop - ph + size
        top = Math.max(8, Math.min(top, window.innerHeight - ph - 8))

        panel.style.width = pw + 'px'
        panel.style.left = Math.round(left) + 'px'
        panel.style.top = Math.round(top) + 'px'
      }

      // ── 展开 / 收起 ─────────────────────────────────────────────────

      function setOpen(next) {
        open = Boolean(next)
        if (!panel) return
        panel.style.display = open ? 'flex' : 'none'
        if (open) {
          positionPanel()
          try { input && input.focus() } catch (ignored) {}
          void refreshTasks()
          void loadSessions()
          void loadSchedules()
          startPolling()
          void markRead()   // P5：打开面板即视为看过（红点消失）
        } else {
          stopPolling()
        }
      }

      function toggleOpen() {
        setOpen(!open)
      }

      // ── 发送（P3：POST 到 Host，mock 建任务）─────────────────────────

      async function send() {
        const text = String(input?.value || '').trim()
        if (!text) return
        if (!String(state.target_session_id || '').trim()) {
          setStatus('请先在上面选一个「正在运行」的目标会话')
          return
        }
        if (input) input.value = ''
        setStatus('派发中…')

        try {
          const res = await fetch('/fish-orb/dispatch.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || !data.ok) {
            const why = data && data.error ? data.error : `HTTP ${res.status}`
            setStatus(`派发失败：${why}`)
            log('dispatch 失败：', why)
            return
          }
          setStatus(`已派发 #${data.task?.id ?? '?'}（P3 mock，3 秒后变完成）`)
          void refreshTasks()
          startPolling()
        } catch (err) {
          setStatus('派发失败：网络或路由不可用')
          log('dispatch 异常：', err)
        }
      }

      // ── P3：任务状态显示 + 轮询 ──────────────────────────────────────

      /** 面板里的状态行 / 任务列表 / 会话下拉 / 轮询定时器 / 未读红点（在 buildPanel / mount 里赋值）。 */
      let statusEl = null
      let taskListEl = null
      let sessSelect = null
      let sessHint = null
      let pollTimer = null
      let badgeEl = null
      let unreadCount = 0

      /** P5：球上的未读红点。 */
      function updateBadge() {
        if (!badgeEl) return
        badgeEl.style.display = unreadCount > 0 ? 'block' : 'none'
      }

      /** P5：把未读任务标成已读（打开面板就算看过了）。 */
      async function markRead() {
        try {
          await fetch('/fish-orb/tasks/read.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          unreadCount = 0
          updateBadge()
        } catch (err) {
          /* 静默：标已读失败不影响任何功能 */
        }
      }

      /** P4：拉可派发的会话（Host 只返回活着的那些）。 */
      async function loadSessions() {
        if (!sessSelect) return
        try {
          const res = await fetch('/fish-orb/sessions.json', { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          const list = Array.isArray(data?.sessions) ? data.sessions : []
          state.sessionsList = list
          const current = String(data?.current || state.target_session_id || '')

          sessSelect.textContent = ''
          const ph = document.createElement('option')
          ph.value = ''
          ph.textContent = list.length ? '— 选一个会话 —' : '（没有正在运行的会话）'
          sessSelect.appendChild(ph)
          for (const s of list) {
            const opt = document.createElement('option')
            opt.value = s.id
            // 标出"能不能立刻收到派发"：只有运行中的会话才收得到
            const mark = s.live ? '（运行中）' : '（未打开）'
            // 标题挖不到时退到工作目录名 —— 至少能区分是哪个会话（免得满屏"未命名"）
            const dirName = s.cwd ? String(s.cwd).split(/[\\/]/u).filter(Boolean).pop() : ''
            const label = s.title || (dirName ? `📁 ${dirName}` : '(未命名)')
            opt.textContent = `${label} ${mark} · ${String(s.id).slice(0, 8)}…`
            sessSelect.appendChild(opt)
          }
          sessSelect.value = current
          if (sessHint) {
            const liveN = Number(data?.liveCount) || 0
            const hiddenN = Number(data?.hiddenCount) || 0
            sessHint.textContent = data?.available === false
              ? `拿不到会话列表（来源 ${data?.source || '未知'}）`
              : `共 ${list.length} 个会话（已过滤 ${hiddenN} 个归档）· ${liveN} 个正在运行 —— 只有运行中的能收到派发`
          }
        } catch (err) {
          if (sessHint) sessHint.textContent = '拿不到会话列表（Host 路由不可用？）'
        }
      }

      function setStatus(text) {
        if (statusEl) statusEl.textContent = String(text ?? '')
      }

      function statusLabel(t) {
        if (t.status === 'done') return '✅ 完成'
        if (t.status === 'failed') return '❌ 失败'
        if (t.status === 'running') return '⏳ 进行中'
        return '⏳ 待处理'
      }

      function renderTasks(tasks) {
        if (!taskListEl) return
        taskListEl.textContent = ''
        const list = Array.isArray(tasks) ? tasks.slice(-8).reverse() : []
        if (list.length === 0) {
          taskListEl.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#888888);', '还没有任务'))
          return
        }
        for (const t of list) {
          // 每条一个独立卡片 + 显式 flex:0 0 auto ——
          // 之前用 flex column，行会被 list 的 flex 压扁，导致文字重叠（用户实测）。
          const card = el('div', [
            'display:flex',
            'flex-direction:column',
            'gap:2px',
            'flex:0 0 auto',
            'padding:5px 0',
            'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))',
          ].join(';'))

          const head = el('div', 'display:flex;gap:6px;align-items:baseline;flex:0 0 auto;')
          head.appendChild(el('span', 'flex:0 0 auto;font-weight:600;', `#${t.id}`))
          head.appendChild(el('span', 'flex:0 0 auto;', statusLabel(t)))
          head.appendChild(el('span',
            'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666666);',
            String(t.text || '')))
          card.appendChild(head)

          // 结果摘要（Host 已截断到 400 字，这里再省一行空间）
          if (t.result) {
            card.appendChild(el('div', [
              'font-size:11px',
              'color:var(--dsw-alias-label-secondary,#888888)',
              'overflow:hidden',
              'text-overflow:ellipsis',
              'white-space:nowrap',
            ].join(';'), String(t.result)))
          }
          taskListEl.appendChild(card)
        }
      }

      // ── 自定义图片（球的自定义样貌：jpg / png / webp）──────────────

      let avatarExt = null     // null = 用默认字符 🐟

      /** 把头像应用（或撤掉）到球上。 */
      function applyAvatar(ext) {
        avatarExt = ext || null
        if (!ball) return
        if (avatarExt) {
          ball.textContent = ''
          ball.style.backgroundImage = `url('/fish-orb/avatar?v=${encodeURIComponent(avatarExt)}')`
          ball.style.backgroundSize = 'cover'
          ball.style.backgroundPosition = 'center'
          ball.style.backgroundRepeat = 'no-repeat'
        } else {
          ball.style.backgroundImage = ''
          ball.style.backgroundSize = ''
          ball.style.backgroundPosition = ''
          ball.style.backgroundRepeat = ''
          ball.textContent = '🐟'
        }
      }

      async function loadAvatar() {
        try {
          const res = await fetch('/fish-orb/avatar.json', { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json()
          applyAvatar(data?.avatar || null)
        } catch (err) {
          /* 静默：没头像就用默认字符 */
        }
      }

      /** 读用户选的文件 → dataURL → PUT 给 Host。 */
      async function uploadAvatar(file) {
        if (!file) return
        const okTypes = ['image/png', 'image/jpeg', 'image/webp']
        if (!okTypes.includes(file.type)) {
          setStatus('只支持 png / jpg / webp')
          return
        }
        if (file.size > 2 * 1024 * 1024) {
          setStatus('图片太大（上限 2MB）')
          return
        }
        setStatus('上传中…')
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader()
            fr.onload = () => resolve(String(fr.result || ''))
            fr.onerror = () => reject(new Error('读取文件失败'))
            fr.readAsDataURL(file)
          })
          const res = await fetch('/fish-orb/avatar.json', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl }),
          })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || !data.ok) {
            setStatus(`上传失败：${data?.error || 'HTTP ' + res.status}`)
            return
          }
          applyAvatar(data.avatar)
          setStatus('图片已应用')
        } catch (err) {
          setStatus(`上传失败：${err?.message || err}`)
        }
      }

      async function resetAvatar() {
        try {
          await fetch('/fish-orb/avatar.json', { method: 'DELETE' })
          applyAvatar(null)
          setStatus('已恢复默认 🐟')
        } catch (err) {
          setStatus('恢复失败：路由不可用')
        }
      }

      // ── 定时任务 UI（折叠区，不占面板空间）─────────────────────────

      let schedListEl = null
      let schedTextEl = null
      let schedKindEl = null
      let schedMinutesEl = null
      let schedTimeEl = null

      function ruleText(rule) {
        if (!rule) return '规则无效'
        if (rule.kind === 'interval') return `每 ${rule.everyMinutes} 分钟`
        if (rule.kind === 'daily') return `每天 ${rule.time}`
        if (rule.kind === 'once') return '一次性'
        return String(rule.kind || '?')
      }

      function renderSchedules(list) {
        if (!schedListEl) return
        schedListEl.textContent = ''
        if (!Array.isArray(list) || list.length === 0) {
          schedListEl.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#888888);font-size:11px;', '还没有定时任务'))
          return
        }
        for (const s of list) {
          const card = el('div', [
            'display:flex', 'flex-direction:column', 'gap:2px',
            'padding:4px 0', 'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))',
          ].join(';'))
          const head = el('div', 'display:flex;gap:6px;align-items:baseline;')
          head.appendChild(el('span', 'flex:0 0 auto;font-weight:600;', `#${s.id}`))
          head.appendChild(el('span', 'flex:0 0 auto;', s.enabled ? '⏰' : '⏸'))
          head.appendChild(el('span',
            'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666666);',
            String(s.text || '')))
          const del = el('button',
            'border:0;background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#888888);',
            '删除')
          del.type = 'button'
          del.addEventListener('click', () => { void removeSchedule(s.id) })
          head.appendChild(del)
          card.appendChild(head)
          card.appendChild(el('div', 'font-size:11px;color:var(--dsw-alias-label-secondary,#888888);',
            `${ruleText(s.rule)} · 下次 ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}`))
          if (s.lastResult) {
            card.appendChild(el('div', 'font-size:11px;color:var(--dsw-alias-label-secondary,#aaaaaa);',
              `上次：${s.lastResult}`))
          }
          schedListEl.appendChild(card)
        }
      }

      async function loadSchedules() {
        if (!schedListEl) return
        try {
          const res = await fetch('/fish-orb/schedules.json', { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json()
          renderSchedules(data?.schedules || [])
        } catch (err) {
          /* 静默 */
        }
      }

      async function addSchedule() {
        const text = String(schedTextEl?.value || '').trim()
        if (!text) {
          setStatus('先写一句到点要派的话')
          return
        }
        if (!String(state.target_session_id || '').trim()) {
          setStatus('请先在面板里选目标会话')
          return
        }
        const kind = String(schedKindEl?.value || 'interval')
        const rule = kind === 'interval'
          ? { kind: 'interval', everyMinutes: Math.max(1, Number(schedMinutesEl?.value) || 30) }
          : { kind: 'daily', time: String(schedTimeEl?.value || '08:00') }
        try {
          const res = await fetch('/fish-orb/schedules.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, rule, sessionId: state.target_session_id }),
          })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || !data.ok) {
            setStatus(`添加失败：${data?.error || 'HTTP ' + res.status}`)
            return
          }
          if (schedTextEl) schedTextEl.value = ''
          setStatus('定时任务已添加')
          renderSchedules(data.schedules || [])
        } catch (err) {
          setStatus('添加失败：路由不可用')
        }
      }

      async function removeSchedule(id) {
        try {
          const res = await fetch('/fish-orb/schedules.json', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          const data = await res.json().catch(() => null)
          if (data && data.ok) renderSchedules(data.schedules || [])
        } catch (err) {
          /* 静默 */
        }
      }

      function buildScheduler() {
        const box = document.createElement('details')
        box.style.cssText = 'font-size:12px;'
        const sum = document.createElement('summary')
        sum.textContent = '定时任务'
        sum.style.cssText = 'cursor:pointer;color:var(--dsw-alias-label-secondary,#666666);padding:2px 0;'
        box.appendChild(sum)

        const form = el('div', 'display:flex;flex-direction:column;gap:6px;padding:6px 0;')
        const inputCss = 'width:100%;box-sizing:border-box;padding:5px 8px;font:inherit;font-size:12px;border-radius:7px;outline:none;color:var(--dsw-alias-label-primary,#111111);background:var(--dsw-alias-bg-base,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));'

        schedTextEl = document.createElement('input')
        schedTextEl.placeholder = '到点要派的话（≤200 字）'
        schedTextEl.style.cssText = inputCss
        form.appendChild(schedTextEl)

        const ruleRow = el('div', 'display:flex;gap:6px;align-items:center;')
        schedKindEl = document.createElement('select')
        schedKindEl.style.cssText = 'flex:1 1 auto;padding:4px 6px;font:inherit;font-size:12px;border-radius:7px;color:var(--dsw-alias-label-primary,#111111);background:var(--dsw-alias-bg-base,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));'
        const optInterval = document.createElement('option')
        optInterval.value = 'interval'
        optInterval.textContent = '每隔 N 分钟'
        const optDaily = document.createElement('option')
        optDaily.value = 'daily'
        optDaily.textContent = '每天几点'
        schedKindEl.appendChild(optInterval)
        schedKindEl.appendChild(optDaily)
        ruleRow.appendChild(schedKindEl)

        const smallCss = 'width:64px;box-sizing:border-box;padding:4px 6px;font:inherit;font-size:12px;border-radius:7px;color:var(--dsw-alias-label-primary,#111111);background:var(--dsw-alias-bg-base,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));'
        schedMinutesEl = document.createElement('input')
        schedMinutesEl.type = 'number'
        schedMinutesEl.min = '1'
        schedMinutesEl.value = '30'
        schedMinutesEl.style.cssText = smallCss
        ruleRow.appendChild(schedMinutesEl)

        schedTimeEl = document.createElement('input')
        schedTimeEl.type = 'time'
        schedTimeEl.value = '08:00'
        schedTimeEl.style.cssText = smallCss
        schedTimeEl.style.display = 'none'
        ruleRow.appendChild(schedTimeEl)

        schedKindEl.addEventListener('change', () => {
          const isInterval = schedKindEl.value === 'interval'
          schedMinutesEl.style.display = isInterval ? '' : 'none'
          schedTimeEl.style.display = isInterval ? 'none' : ''
        })
        form.appendChild(ruleRow)

        const addBtn = el('button', [
          'align-self:flex-start', 'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18))',
          'background:var(--dsw-alias-bg-base,#ffffff)', 'color:var(--dsw-alias-label-primary,#111111)',
          'border-radius:7px', 'padding:3px 10px', 'font:inherit', 'font-size:11px', 'cursor:pointer',
        ].join(';'), '添加定时任务')
        addBtn.type = 'button'
        addBtn.addEventListener('click', () => { void addSchedule() })
        form.appendChild(addBtn)

        schedListEl = el('div', 'display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto;')
        form.appendChild(schedListEl)

        box.appendChild(form)
        return box
      }

      // ── 页面内右键菜单（形态参考 dsh-tauri-rightclick）──────────────────
      // 只接管两种目标：
      //   ① 选中文字 → 复制 / 搜索 / 发到悬浮框
      //   ② 会话行（[role="treeitem"]）→ 设为派发目标 / 复制标题 / 复制 id
      // 输入框与空白处**不接管**，保留浏览器默认右键（粘贴 / 全选 / 检查元素）。
      //
      // ⚠️ 两个从它源码学来的关键点：
      //   · 会话行的标题藏在「操作」按钮 aria-label 的引号里，不是文本节点；
      //   · 标题匹配**不唯一就不猜**（它 resolveSession 也是唯一命中才返回，否则 null）。

      const EDITABLE_SEL = 'input:not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]'
      const TREE_ITEM_SEL = '[role="treeitem"]'
      const ACTION_BTN_SEL = 'button[aria-label]'

      let menuEl = null

      /**
       * 从会话行提取 `{ title, id }`。
       *
       * ⚠️ 早先的写法只在「标题唯一匹配到 sessionsList」时才给 id，
       * 于是标题取不到 / 同名会话时"复制 id"整行不出现（用户实测反馈）。
       * 现在 id **优先直接从 DOM 属性取**，标题匹配只用来决定"能不能设为派发目标"。
       */
      function sessionInfoFromRow(row) {
        let id = row.getAttribute('data-session-id') || row.getAttribute('data-id') || row.id || ''
        if (!id) {
          const holder = row.querySelector('[data-session-id]')
          if (holder) id = holder.getAttribute('data-session-id') || ''
        }

        let title = ''
        for (const b of row.querySelectorAll(ACTION_BTN_SEL)) {
          const label = b.getAttribute('aria-label') || ''
          if (!/会话|session/iu.test(label)) continue
          const m = /[“"](.+?)[”"]/u.exec(label)
          if (m) {
            title = m[1].trim()
            break
          }
        }
        if (!title) {
          const first = row.querySelector('span')
          title = first ? String(first.textContent || '').trim() : ''
        }
        return { title, id }
      }

      function hideMenu() {
        if (menuEl) menuEl.style.display = 'none'
      }

      function buildMenu() {
        menuEl = el('div', [
          'position:fixed', 'z-index:2147483002', 'display:none',
          'flex-direction:column', 'min-width:150px', 'padding:4px',
          'border-radius:10px',
          'background:var(--dsw-alias-bg-overlay,#ffffff)',
          'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))',
          'box-shadow:0 10px 28px rgba(0,0,0,.22)',
          'pointer-events:auto', 'font-size:12px',
        ].join(';'))
        root.appendChild(menuEl)
        return menuEl
      }

      function menuItem(label, onClick, disabled) {
        const b = el('button', [
          'border:0', 'background:transparent', 'padding:5px 8px', 'border-radius:6px',
          'text-align:left', 'font:inherit', 'font-size:12px',
          'color:var(--dsw-alias-label-primary,#111111)',
        ].join(';'), label)
        b.type = 'button'
        if (disabled) {
          b.disabled = true
          b.style.opacity = '.45'
          b.style.cursor = 'default'
        } else {
          b.style.cursor = 'pointer'
          b.addEventListener('mouseenter', () => { b.style.background = 'var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))' })
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
          b.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            hideMenu()
            try { onClick() } catch (ignored) {}
          })
        }
        menuEl.appendChild(b)
      }

      function menuSplit() {
        menuEl.appendChild(el('div', 'height:1px;margin:3px 4px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.1));'))
      }

      function copyText(text) {
        try { void navigator.clipboard?.writeText(String(text)) } catch (ignored) {}
        setStatus('已复制')
      }

      function showMenu(x, y, row) {
        if (!menuEl) buildMenu()
        menuEl.textContent = ''

        // ⚠️ 刻意**不做**「选中文字」相关菜单项：
        // 选中即弹的划词工具条已经给了「搜索 / 发到悬浮框里」，
        // 右键再放一份就是同一功能两个入口（用户实测反馈：重复、困惑）。
        // 右键菜单只负责划词工具条做不到的那件事 —— **定位到会话行**。
        if (row) {
          const info = sessionInfoFromRow(row)
          // ⚠️ 标题归一化后比较：侧栏行里取到的是「创造 DSH 插件」（带空格），
          // 而会话列表里是「创造DSH插件」（无空格）——直接 === 会因为空格差异匹配失败。
          const norm = (v) => String(v || '').replace(/\s+/gu, '').toLowerCase()
          const matches = info.title && Array.isArray(state.sessionsList)
            ? state.sessionsList.filter((s) => norm(s.title) === norm(info.title))
            : []
          const target = matches.length === 1 ? matches[0] : null
          // id 只要在 DOM 里取到就能复制，与"能否设为目标"无关
          const effectiveId = target ? target.id : info.id

          menuItem(
            target ? `设为派发目标：${info.title}` : '设为派发目标（标题不唯一或未取到）',
            () => {
              state.target_session_id = target.id
              void persist()
              setStatus(`目标会话已设为：${info.title}`)
            },
            !target,
          )
          if (info.title) menuItem('复制会话标题', () => copyText(info.title))
          // id 三级兜底，保证总有出口：
          //   ① DOM 属性直接给 → ② 标题唯一匹配 → ③ 同名多条时列候选 → ④ 都没有就给排障出口
          if (effectiveId) {
            menuItem('复制会话 id', () => copyText(effectiveId))
          } else if (matches.length > 1) {
            for (const m of matches.slice(0, 5)) {
              menuItem(`复制 id：${String(m.id).slice(0, 8)}…`, () => copyText(m.id))
            }
          } else {
            menuItem('复制行 HTML（排障用）', () => copyText(String(row.outerHTML || '').slice(0, 800)))
          }
        }

        if (!menuEl.childElementCount) return
        menuEl.style.display = 'flex'
        // 先显示再量尺寸，才能正确避让右/下边缘
        const w = menuEl.offsetWidth || 160
        const h = menuEl.offsetHeight || 120
        menuEl.style.left = Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8))) + 'px'
        menuEl.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8))) + 'px'
      }

      function onDocContextMenu(e) {
        const target = e.target
        if (!(target instanceof Element)) return
        // 自己面板/球/菜单内部不接管（否则没法右键调试自己的东西）
        if (root && root.contains(target)) return
        // 输入框交给浏览器默认
        if (target.closest(EDITABLE_SEL)) return

        const row = target.closest(TREE_ITEM_SEL)
        if (!row) return

        e.preventDefault()
        showMenu(e.clientX, e.clientY, row)
      }

      /** P5：手动清空任务记录（DSH 重启时 Host 也会自动清一次）。 */
      async function clearTasks() {
        try {
          await fetch('/fish-orb/tasks/clear.json', { method: 'POST' })
          unreadCount = 0
          updateBadge()
          void refreshTasks()
        } catch (err) {
          setStatus('清空失败：路由不可用')
        }
      }

      async function refreshTasks() {
        try {
          const res = await fetch('/fish-orb/tasks.json', { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json()
          if (data && data.ok) {
            renderTasks(data.tasks)
            unreadCount = Number(data.unreadCount) || 0
            updateBadge()
          }
        } catch (err) {
          /* 静默：轮询失败不该打断用户 */
        }
      }

      /** 面板打开时每秒拉一次；关闭时停（PLAN §11：别空转）。 */
      function startPolling() {
        stopPolling()
        pollTimer = setInterval(() => { void refreshTasks() }, 1000)
      }

      function stopPolling() {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      // ── 落盘 ────────────────────────────────────────────────────────

      async function loadState() {
        try {
          const res = await fetch(API, { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json()
          const next = data && data.state ? data.state : null
          if (next) {
            state = {
              ...state,
              ...next,
              ball: { ...state.ball, ...(next.ball && typeof next.ball === 'object' ? next.ball : {}) },
            }
            render()
          }
        } catch (err) {
          /* Host 路由还没就绪也没关系：默认值先顶着 */
        }
      }

      async function persist() {
        try {
          const res = await fetch(API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ball: state.ball,
              size: state.size,
              target_session_id: state.target_session_id,
            }),
          })
          if (!res.ok) log('保存失败：HTTP ' + res.status)
        } catch (err) {
          log('保存失败：', err)
        }
      }

      function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          void persist()
        }, SAVE_DEBOUNCE_MS)
      }

      function clearSaveTimer() {
        if (saveTimer) {
          clearTimeout(saveTimer)
          saveTimer = null
        }
      }

      // ── 板边吸附（形态参考 大肥鱼记账 的鲸鱼挂件）────────────────────

      const SNAP_ZONE = 32   // 距视口边缘多近算"该吸附"（px）

      /**
       * 松手时把球吸到最近的边缘。只在球边缘进入 `SNAP_ZONE` 时才吸，
       * 否则保持原位 —— 不然每次拖到中间都会被拽走。
       * 过渡动画只在吸附这一下加，拖动过程中保持 `transition: none`（否则会拖影）。
       */
      function snapToEdge() {
        if (!ball) return
        const size = state.size
        const vw = window.innerWidth
        const vh = window.innerHeight
        let right = state.ball.right
        let bottom = state.ball.bottom
        const leftPx = vw - right - size      // 球左边缘距视口左边
        const topPx = vh - bottom - size      // 球上边缘距视口上边
        let snapped = false

        // 水平：离右边近就贴右，离左边近就贴左
        if (right <= SNAP_ZONE) {
          right = 0
          snapped = true
        } else if (leftPx <= SNAP_ZONE) {
          right = vw - size
          snapped = true
        }
        // 垂直：离底边近就贴底，离顶边近就贴顶
        if (bottom <= SNAP_ZONE) {
          bottom = 0
          snapped = true
        } else if (topPx <= SNAP_ZONE) {
          bottom = vh - size
          snapped = true
        }

        if (!snapped) return
        state.ball = { right: Math.round(right), bottom: Math.round(bottom) }
        ball.style.transition = 'right .18s ease, bottom .18s ease'
        ball.style.right = state.ball.right + 'px'
        ball.style.bottom = state.ball.bottom + 'px'
        setTimeout(() => {
          try { if (ball) ball.style.transition = '' } catch (ignored) {}
        }, 240)
      }

      // ── 拖动 ────────────────────────────────────────────────────────

      function onPointerDown(e) {
        if (e.button !== 0) return
        dragging = true
        movedMax = 0
        startX = e.clientX
        startY = e.clientY
        startRight = state.ball.right
        startBottom = state.ball.bottom
        try { ball.setPointerCapture(e.pointerId) } catch (ignored) {}
        try { e.preventDefault() } catch (ignored) {}
      }

      function onPointerMove(e) {
        if (!dragging) return
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        movedMax = Math.max(movedMax, Math.abs(dx) + Math.abs(dy))

        const size = state.size
        const maxRight = Math.max(0, window.innerWidth - size)
        const maxBottom = Math.max(0, window.innerHeight - size)
        // 往右拖 → right 变小；往下拖 → bottom 变小；坐标一律取整
        const right = Math.round(Math.min(Math.max(startRight - dx, 0), maxRight))
        const bottom = Math.round(Math.min(Math.max(startBottom - dy, 0), maxBottom))
        state.ball = { right, bottom }
        ball.style.right = right + 'px'
        ball.style.bottom = bottom + 'px'
        if (open) positionPanel()
      }

      function onPointerUp(e) {
        if (!dragging) return
        dragging = false
        try { ball.releasePointerCapture(e.pointerId) } catch (ignored) {}

        if (movedMax < CLICK_THRESHOLD) {
          toggleOpen()          // P2：点球展开/收起
          return
        }
        snapToEdge()            // 松手先吸附（贴边），再落盘
        scheduleSave()
      }

      // ── DOM 构建 ────────────────────────────────────────────────────

      function el(tag, cssText, text) {
        const node = document.createElement(tag)
        if (cssText) node.style.cssText = cssText
        if (text !== undefined) node.textContent = text
        return node
      }

      function buildPanel() {
        panel = el('div', [
          'position:fixed',
          'display:none',
          'flex-direction:column',
          'gap:8px',
          'padding:12px',
          'box-sizing:border-box',
          'border-radius:14px',
          'background:var(--dsw-alias-bg-overlay,#ffffff)',
          'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))',
          'box-shadow:0 14px 36px rgba(0,0,0,.26)',
          'color:var(--dsw-alias-label-primary,#111111)',
          'font-size:13px',
          'line-height:1.5',
          'pointer-events:auto',
        ].join(';'))

        // 标题行
        const head = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;')
        head.appendChild(el('span', '', '小肥鱼球'))
        const closeBtn = el('button', [
          'border:0', 'background:transparent', 'cursor:pointer', 'padding:0 4px',
          'font-size:16px', 'line-height:1', 'color:var(--dsw-alias-label-secondary,#666666)',
        ].join(';'), '×')
        closeBtn.setAttribute('aria-label', '关闭')
        closeBtn.addEventListener('click', () => setOpen(false))
        head.appendChild(closeBtn)

        // P4：目标会话下拉（只列活着的会话；没打开的派不出去）
        const sessWrap = el('div', 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#666666);')
        sessWrap.appendChild(el('span', '', '派给哪个会话'))
        sessSelect = document.createElement('select')
        sessSelect.style.cssText = [
          'width:100%', 'box-sizing:border-box', 'padding:6px 8px', 'font:inherit', 'font-size:12px',
          'border-radius:8px', 'outline:none',
          'color:var(--dsw-alias-label-primary,#111111)',
          'background:var(--dsw-alias-bg-base,#ffffff)',
          'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18))',
        ].join(';')
        sessSelect.addEventListener('change', () => {
          state.target_session_id = sessSelect.value
          // 立刻落盘（不放进防抖）：避免「选完马上关面板」把这次选择丢掉
          void persist()
        })
        sessWrap.appendChild(sessSelect)
        sessHint = el('div', 'font-size:11px;', '只有正在运行的会话能收到派发')
        sessWrap.appendChild(sessHint)

        // 输入框
        input = document.createElement('textarea')
        input.rows = 3
        input.placeholder = '说一句话…（Enter 发送 / Shift+Enter 换行）'
        input.style.cssText = [
          'width:100%', 'box-sizing:border-box', 'resize:none', 'padding:8px 10px',
          'font:inherit', 'font-size:13px', 'border-radius:10px', 'outline:none',
          'color:var(--dsw-alias-label-primary,#111111)',
          'background:var(--dsw-alias-bg-base,#ffffff)',
          'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18))',
        ].join(';')
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            send()
          }
        })

        // 大小调节（用户追加需求：位置/大小可自主调节）
        const sizeRow = el('div', 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#666666);')
        sizeRow.appendChild(el('span', 'flex:0 0 auto;', '球大小'))
        sizeRange = document.createElement('input')
        sizeRange.type = 'range'
        sizeRange.min = '44'
        sizeRange.max = '120'
        sizeRange.step = '2'
        sizeRange.value = String(state.size)
        sizeRange.style.cssText = 'flex:1 1 auto;accent-color:var(--dsw-alias-brand-primary,#3D5AFE);'
        const sizeLabel = el('span', 'flex:0 0 auto;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;', `${state.size}px`)
        sizeRange.addEventListener('input', () => {
          state.size = Math.round(clampNum(sizeRange.value, 44, 120, 64))
          sizeLabel.textContent = `${state.size}px`
          render()
        })
        sizeRange.addEventListener('change', () => scheduleSave())
        sizeRow.appendChild(sizeRange)
        sizeRow.appendChild(sizeLabel)

        // 自定义图片（用户要求：球的样子不局限于一个字符）
        const imgRow = el('div', 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#666666);')
        imgRow.appendChild(el('span', 'flex:0 0 auto;', '球的图片'))
        const fileInput = document.createElement('input')
        fileInput.type = 'file'
        fileInput.accept = 'image/png,image/jpeg,image/webp'
        fileInput.style.display = 'none'
        fileInput.addEventListener('change', () => {
          const f = fileInput.files && fileInput.files[0]
          fileInput.value = ''
          if (f) void uploadAvatar(f)
        })
        const btnCss = [
          'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18))',
          'background:var(--dsw-alias-bg-base,#ffffff)',
          'color:var(--dsw-alias-label-primary,#111111)',
          'border-radius:7px', 'padding:3px 8px', 'font:inherit', 'font-size:11px', 'cursor:pointer',
        ].join(';')
        const pickBtn = el('button', btnCss, '选择图片')
        pickBtn.type = 'button'
        pickBtn.addEventListener('click', () => { try { fileInput.click() } catch (ignored) {} })
        const resetImgBtn = el('button', btnCss, '恢复默认')
        resetImgBtn.type = 'button'
        resetImgBtn.addEventListener('click', () => { void resetAvatar() })
        imgRow.appendChild(pickBtn)
        imgRow.appendChild(resetImgBtn)
        imgRow.appendChild(fileInput)

        // P3：状态行 + 任务列表（轮询刷新，最多显示最近 8 条）
        statusEl = el('div', 'font-size:11px;color:var(--dsw-alias-label-secondary,#666666);min-height:16px;')

        // 任务区标题行 + 清空按钮（用户要求：这类数据不该长期留着，给个手动清理口）
        const taskHead = el('div', 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary,#888888);')
        taskHead.appendChild(el('span', '', '最近任务'))
        const clearBtn = el('button', [
          'border:0', 'background:transparent', 'cursor:pointer', 'padding:0 2px',
          'font-size:11px', 'color:var(--dsw-alias-label-secondary,#888888)',
        ].join(';'), '清空')
        clearBtn.setAttribute('aria-label', '清空任务记录')
        clearBtn.addEventListener('click', () => { void clearTasks() })
        taskHead.appendChild(clearBtn)

        taskListEl = el('div', 'display:block;max-height:150px;overflow-y:auto;overflow-x:hidden;font-size:12px;')

        const hint = el('div', 'font-size:11px;color:var(--dsw-alias-label-secondary,#888888);',
          'P3：Enter 只建任务（mock），3 秒后自动变完成')

        panel.appendChild(head)
        panel.appendChild(sessWrap)
        panel.appendChild(input)
        panel.appendChild(statusEl)
        panel.appendChild(taskHead)
        panel.appendChild(taskListEl)
        panel.appendChild(sizeRow)
        panel.appendChild(imgRow)
        panel.appendChild(buildScheduler())
        panel.appendChild(hint)
        return panel
      }

      function mount() {
        if (document.getElementById(ROOT_ID)) return null

        root = el('div', 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;')
        root.id = ROOT_ID

        ball = el('div', [
          'position:fixed',
          'right:18px',
          'bottom:132px',
          'width:44px',
          'height:44px',
          'box-sizing:border-box',
          'border-radius:12px',                                 // 圆角矩形（用户选的形状）
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'background:var(--dsw-alias-bg-layer-1,#f6f7f9)',     // 浅色底（勿用 bg-overlay：那是深色浮层色）
          'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18))',
          'box-shadow:0 6px 18px rgba(0,0,0,.22)',
          'font-size:20px',
          'line-height:1',
          'pointer-events:auto',                                // 与容器 pointer-events:none 成对
          'user-select:none',
          'cursor:pointer',
          'touch-action:none',                                  // 触屏/笔也别让它滚页面
        ].join(';'))
        ball.className = 'fo-ball'
        ball.setAttribute('role', 'button')
        ball.setAttribute('aria-label', '小肥鱼球')
        ball.setAttribute('title', '小肥鱼球 · 点我展开（P2）')
        ball.textContent = '🐟'

        // P5：未读红点（absolute 定位到球右上角，脱离 flex 居中）
        badgeEl = el('span', [
          'position:absolute',
          'top:-3px',
          'right:-3px',
          'width:10px',
          'height:10px',
          'border-radius:50%',
          'background:#ff3b30',
          'border:1px solid #ffffff',
          'box-shadow:0 0 0 1px rgba(0,0,0,.06)',
          'display:none',
          'pointer-events:none',
        ].join(';'))
        badgeEl.setAttribute('aria-label', '有未读任务')
        ball.appendChild(badgeEl)

        ball.addEventListener('pointerdown', onPointerDown)
        ball.addEventListener('pointermove', onPointerMove)
        ball.addEventListener('pointerup', onPointerUp)
        ball.addEventListener('pointercancel', onPointerUp)

        root.appendChild(ball)
        root.appendChild(buildPanel())
        buildSelTip()   // P6：划词工具条（自己 append 到 root）
        document.body.appendChild(root)

        render()
        void loadState()
        void loadAvatar()    // P7：有自定义图片就换上
        return root
      }

      // ── P6：划词工具条（页面内选中文字 → 选区上方浮出）───────────────

      let selTip = null
      let selText = ''

      /** 搜索：交给默认浏览器（Bing，国内可用性比 Google 稳）。 */
      function searchSelection() {
        const q = String(selText || '').trim()
        if (!q) return
        const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`
        try {
          const w = window.open(url, '_blank', 'noopener')
          if (!w) setStatus('浏览器拦了新窗口：地址已复制到剪贴板')
          if (!w) {
            try { void navigator.clipboard?.writeText(url) } catch (ignored) {}
          }
        } catch (err) {
          setStatus('打开浏览器失败')
        }
        hideSelTip()
      }

      /** 发到悬浮框里：把选中文字填进输入框并展开面板。 */
      function sendSelectionToPanel() {
        const q = String(selText || '').trim()
        if (!q) return
        setOpen(true)
        if (input) {
          input.value = input.value ? `${input.value}\n${q}` : q
          try { input.focus() } catch (ignored) {}
        }
        hideSelTip()
      }

      function hideSelTip() {
        if (selTip) selTip.style.display = 'none'
      }

      function buildSelTip() {
        selTip = el('div', [
          'position:fixed',
          'display:none',
          'gap:4px',
          'padding:4px',
          'border-radius:10px',
          'background:var(--dsw-alias-bg-overlay,#ffffff)',
          'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))',
          'box-shadow:0 8px 24px rgba(0,0,0,.22)',
          'z-index:2147483001',
          'pointer-events:auto',
        ].join(';'))

        const mk = (label, title, fn) => {
          const b = el('button', [
            'border:0', 'background:transparent', 'cursor:pointer',
            'padding:4px 8px', 'border-radius:7px', 'font:inherit', 'font-size:12px',
            'color:var(--dsw-alias-label-primary,#111111)', 'white-space:nowrap',
          ].join(';'), label)
          b.type = 'button'
          b.title = title
          b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
          b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn() })
          return b
        }

        selTip.appendChild(mk('搜索', '用默认浏览器搜索选中内容', searchSelection))
        selTip.appendChild(mk('发到悬浮框里', '把选中文字填进悬浮框的输入框', sendSelectionToPanel))
        root.appendChild(selTip)
        return selTip
      }

      /** 选区上方定位（上方放不下就翻到下方，左右 clamp 在视口内）。 */
      function positionSelTip(rect) {
        if (!selTip) return
        const w = selTip.offsetWidth || 170
        const h = selTip.offsetHeight || 30
        const gap = 8
        let left = rect.left + rect.width / 2 - w / 2
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
        let top = rect.top - h - gap
        if (top < 8) top = Math.min(rect.bottom + gap, window.innerHeight - h - 8)
        selTip.style.left = Math.round(left) + 'px'
        selTip.style.top = Math.round(top) + 'px'
        selTip.style.right = 'auto'
        selTip.style.bottom = 'auto'
      }

      function showSelTipForSelection() {
        if (!selTip) return
        const sel = window.getSelection ? window.getSelection() : null
        const text = sel ? String(sel).trim() : ''
        if (!text || text.length < 2 || text.length > 4000 || !sel.rangeCount) {
          hideSelTip()
          return
        }
        // 选区落在球 / 面板内部时不弹（否则会挡住自己的输入框）
        const anchor = sel.anchorNode
        if (anchor && ball && ball.contains(anchor)) { hideSelTip(); return }
        if (anchor && panel && panel.contains(anchor)) { hideSelTip(); return }

        let rect = null
        try { rect = sel.getRangeAt(0).getBoundingClientRect() } catch (err) { rect = null }
        if (!rect || (rect.width === 0 && rect.height === 0)) { hideSelTip(); return }

        selText = text
        selTip.style.display = 'flex'
        positionSelTip(rect)
      }

      function onDocMouseUp(e) {
        // 点在自己的控件上时不处理
        if (selTip && selTip.contains(e.target)) return
        setTimeout(() => { try { showSelTipForSelection() } catch (ignored) {} }, 10)
      }

      function onDocMouseDown(e) {
        if (selTip && selTip.contains(e.target)) return
        if (menuEl && menuEl.contains(e.target)) return
        hideSelTip()
        hideMenu()
      }

      // ── Esc 关闭（只在面板打开时生效，离开时解绑）──────────────────

      function onKeyDown(e) {
        if (e.key !== 'Escape') return
        if (open) {
          e.preventDefault()
          setOpen(false)
          return
        }
        hideSelTip()
        hideMenu()
      }

      return {
        // 不依赖 Client 服务：DOM 直接挂 body，数据走自己注册的 HTTP 路由
        inject: [],

        apply(ctx) {
          let mountedRoot = null
          try {
            mountedRoot = mount()
          } catch (err) {
            try { console.error('[fish-orb] mount failed:', err) } catch (ignored) {}
          }
          try { document.addEventListener('keydown', onKeyDown) } catch (ignored) {}
          try { document.addEventListener('mouseup', onDocMouseUp) } catch (ignored) {}
          try { document.addEventListener('mousedown', onDocMouseDown) } catch (ignored) {}
          try { document.addEventListener('contextmenu', onDocContextMenu) } catch (ignored) {}

          // 禁用 / 卸载：撤 DOM、解绑事件、清定时器
          try {
            if (typeof ctx?.effect === 'function') {
              ctx.effect(() => () => {
                try { clearSaveTimer() } catch (ignored) {}
                try { stopPolling() } catch (ignored) {}
                try { document.removeEventListener('keydown', onKeyDown) } catch (ignored) {}
                try { document.removeEventListener('mouseup', onDocMouseUp) } catch (ignored) {}
                try { document.removeEventListener('mousedown', onDocMouseDown) } catch (ignored) {}
                try { document.removeEventListener('contextmenu', onDocContextMenu) } catch (ignored) {}
                try {
                  if (ball) {
                    ball.removeEventListener('pointerdown', onPointerDown)
                    ball.removeEventListener('pointermove', onPointerMove)
                    ball.removeEventListener('pointerup', onPointerUp)
                    ball.removeEventListener('pointercancel', onPointerUp)
                  }
                } catch (ignored) {}
                try {
                  if (mountedRoot && mountedRoot.parentNode) mountedRoot.parentNode.removeChild(mountedRoot)
                } catch (ignored) {}
                ball = null
                panel = null
                input = null
                sizeRange = null
                open = false
              })
            }
          } catch (err) {
            try { console.error('[fish-orb] effect register failed:', err) } catch (ignored) {}
          }
        },
      }
    } catch (err) {
      // 吞掉，返回空插件，DSH 照常启动
      try { console.error('[fish-orb] client factory failed:', err) } catch (ignored) {}
      return {}
    }
  },
})
