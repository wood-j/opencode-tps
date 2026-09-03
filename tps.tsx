/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

interface StreamSample {
  tokens: number
  timestamp: number
}

interface PartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

// ===== 性能补丁 (2026-09-03) =====
// 原版每个流式 delta 都会: 1) new TextEncoder()+encode (分配) 2) api.state.part() 全量拉取 3) setVersion 触发 re-render
// 补丁: 零分配 UTF-8 长度计算; hasText 按 message 缓存; re-render 节流 500ms (显示精度不受影响, 另有 1s tick 兜底)
const RENDER_MIN_GAP_MS = 500

function utf8ByteLen(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const tui: TuiPlugin = async (api, _options, _meta) => {
  const streamSamples = new Map<string, StreamSample[]>()
  const hasTextCache = new Map<string, boolean>()
  let lastRender = 0

  const [version, setVersion] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const LIVE_STALE_MS = 1500
  const SAMPLE_WINDOW_MS = 5000
  const SINGLE_SAMPLE_MIN_MS = 250
  const SINGLE_SAMPLE_MAX_MS = 1000

  function estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(utf8ByteLen(text) / 5))
  }

  function formatTps(value: number): string {
    if (value < 0) return "-"
    if (value < 10) return value.toFixed(2)
    if (value < 100) return value.toFixed(1)
    return Math.round(value).toString()
  }

  function clearLiveSamples(sessionID: string) {
    if (streamSamples.has(sessionID)) {
      streamSamples.delete(sessionID)
      setVersion((v) => v + 1)
    }
  }

  function singleSampleDuration(samples: StreamSample[]): number {
    const elapsed = Date.now() - samples[0].timestamp
    return Math.max(SINGLE_SAMPLE_MIN_MS, Math.min(elapsed, SINGLE_SAMPLE_MAX_MS))
  }

  function activeDurationMs(samples: StreamSample[]): number {
    if (samples.length < 2) {
      return singleSampleDuration(samples)
    }
    let total = 0
    for (let i = 1; i < samples.length; i++) {
      total += Math.max(0, samples[i].timestamp - samples[i - 1].timestamp)
    }
    const now = Date.now()
    const tail = now - samples[samples.length - 1].timestamp
    total += Math.min(tail, 1000)
    return Math.max(total, SINGLE_SAMPLE_MIN_MS)
  }

  function calcLiveTps(sessionID: string): number {
    if (api.state.session.status(sessionID)?.type === "idle") return -1

    const samples = streamSamples.get(sessionID) ?? []
    const now = Date.now()
    const cutoff = now - SAMPLE_WINDOW_MS
    const active = samples.filter((s) => s.timestamp >= cutoff)

    if (active.length === 0) return -1

    const last = active[active.length - 1]
    if (now - last.timestamp > LIVE_STALE_MS) return -1

    const totalTokens = active.reduce((sum, s) => sum + s.tokens, 0)
    const durationMs = activeDurationMs(active)
    if (durationMs <= 0) return -1

    return (totalTokens / durationMs) * 1000
  }

  const unsubDelta = api.event.on("message.part.delta" as unknown as "message.part.delta", (evt: PartDeltaEvent) => {
    const sessionID = evt.properties.sessionID
    if (!sessionID) return
    if (api.state.session.status(sessionID)?.type === "idle") return

    if (evt.properties.field !== "text") return

    // 补丁: 按 message 缓存 "是否含 text/reasoning part", 避免每 delta 全量 api.state.part() 拉取
    // (parts 只增不减, 一旦为 true 永为 true; false 不缓存以便后续 delta 复查)
    let hasTextOrReasoning = hasTextCache.get(evt.properties.messageID)
    if (hasTextOrReasoning === undefined) {
      const parts = api.state.part(evt.properties.messageID)
      hasTextOrReasoning = parts?.some(
        (p) => p.type === "text" || p.type === "reasoning",
      )
      if (hasTextOrReasoning) hasTextCache.set(evt.properties.messageID, true)
    }
    if (!hasTextOrReasoning) return

    const deltaText = evt.properties.delta
    if (!deltaText || typeof deltaText !== "string") return

    const tokens = estimateTokens(deltaText)
    const now = Date.now()

    let samples = streamSamples.get(sessionID)
    if (!samples) {
      samples = []
      streamSamples.set(sessionID, samples)
    }
    samples.push({ tokens, timestamp: now })

    // 补丁: re-render 节流 (原版每 delta 一次; 500ms 一次 + 1s tick 兜底, 显示精度不变)
    if (now - lastRender >= RENDER_MIN_GAP_MS) {
      lastRender = now
      setVersion((v) => v + 1)
    }
  })

  const unsubUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return

    const sessionID = info.sessionID

    if (info.time.completed) {
      streamSamples.delete(sessionID)
      setVersion((v) => v + 1)
    }
  })

  const unsubPartUpdated = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return

    const sessionID = part.sessionID
    const state = part.state

    if (state.status === "running" || state.status === "completed" || state.status === "error") {
      clearLiveSamples(sessionID)
    }
  })

  const interval = setInterval(() => {
    const now = Date.now()
    const cutoff = now - SAMPLE_WINDOW_MS
    for (const [sessionID, samples] of streamSamples) {
      const pruned = samples.filter((s) => s.timestamp >= cutoff)
      if (pruned.length !== samples.length) {
        streamSamples.set(sessionID, pruned)
      }
    }
    setTick((t) => t + 1)
  }, 1000)

  api.lifecycle.onDispose(() => {
    unsubDelta()
    unsubUpdated()
    unsubPartUpdated()
    clearInterval(interval)
  })

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const sessionID = props.session_id

        const liveTps = createMemo(() => {
          version()
          tick()
          return calcLiveTps(sessionID)
        })

        const textMuted = ctx.theme.current.textMuted

        return (
          <text fg={textMuted}>
            TPS {formatTps(liveTps())}
          </text>
        )
      },
    },
  })
}

export default {
  id: "opencode-tps",
  tui,
}
