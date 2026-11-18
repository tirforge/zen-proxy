#!/usr/bin/env node
// zen-proxy · dashboard + bridge
//
// Serves the zen-proxy dashboard (public/index.html) and hands every /v1/*
// request to an opencode-free-bridge instance, which does the actual upstream
// work (v2 gate shape, identity, fallbacks, egress pool).
//
//   node server.mjs          # local: auto-starts the bridge under Bun
//
// On Vercel the bridge cannot run (the free-tier gate refuses Node's TLS
// fingerprint), so the deployment acts as dashboard + reverse proxy in front of
// a bridge you run elsewhere: set BRIDGE_URL to a reachable bridge.

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")
const IS_VERCEL = !!process.env.VERCEL

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  bridgeUrl: "http://127.0.0.1:20129",
  bridgeDir: "bridge",
  autoStartBridge: true,
  defaultModel: "",
  fallbackModels: [],
  modelAliases: {},
  responsesModels: ["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*"],
  proxyKey: "",
  // "all models" mode: accept any model id (including ones the catalog does not
  // have) and any effort suffix (`model#high`), routing them to a real free
  // model instead of failing with "Model is unavailable".
  allModels: false,
  allModelsTarget: "nemotron-3.5-lightning-free",
  effortVariants: ["minimal", "low", "medium", "high", "max"],
}

// Old zen-proxy environment names, kept for drop-in compatibility. They are
// re-applied on every boot and win over zen-proxy.json.
const ENV_MAP = {
  HOST: (v) => ({ host: v }),
  PORT: (v) => (Number(v) > 0 ? { port: Number(v) } : {}),
  PROXY_KEY: (v) => ({ proxyKey: v }),
  DEFAULT_MODEL: (v) => ({ defaultModel: v }),
  BRIDGE_URL: (v) => ({ bridgeUrl: v.replace(/\/$/, "") }),
  BRIDGE_DIR: (v) => ({ bridgeDir: v }),
  AUTO_START_BRIDGE: (v) => ({ autoStartBridge: v !== "0" }),
  ALL_MODELS: (v) => ({ allModels: v !== "0" && v !== "" }),
  ALL_MODELS_TARGET: (v) => ({ allModelsTarget: v }),
}

const JSON_ENV_MAP = {
  FALLBACK_MODELS: "fallbackModels",
  MODEL_ALIASES: "modelAliases",
  RESPONSES_MODELS: "responsesModels",
}

function parseList(value) {
  const raw = String(value).trim()
  if (!raw) return null
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean)
  return list.length ? list : null
}

function applyEnv(base) {
  const next = { ...base }
  for (const [name, fn] of Object.entries(ENV_MAP)) {
    const v = process.env[name]
    if (v !== undefined && v !== "") Object.assign(next, fn(v))
  }
  for (const [name, key] of Object.entries(JSON_ENV_MAP)) {
    const parsed = parseList(process.env[name] || "")
    if (parsed && typeof parsed === "object") next[key] = parsed
  }
  return next
}

function loadConfig() {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    // Serverless filesystems are read-only; only persist locally.
    if (!IS_VERCEL) {
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n")
      } catch {}
    }
  }
  return applyEnv({ ...DEFAULTS, ...file })
}

let config = loadConfig()
const startedAt = Date.now()
const logs = []
const recent = []
const counters = { total: 0, errors: 0, times: [] }

function log(msg) {
  const at = new Date().toISOString().slice(11, 19)
  logs.push({ at, msg })
  if (logs.length > 800) logs.splice(0, logs.length - 800)
  console.log(`[${at}] ${msg}`)
}

function isLocalHost(value) {
  const h = String(value || "").toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]"
}

// Anything that is not loopback is reachable by other people, so it must never
// be served without a key. On Vercel that is always true.
function hostedExposure() {
  return IS_VERCEL || !isLocalHost(config.host)
}

function isAuthorized(req) {
  if (!config.proxyKey) return !hostedExposure()
  const auth = req.headers.authorization || ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  const headerKey = req.headers["x-api-key"] || ""
  return bearer === config.proxyKey || headerKey === config.proxyKey
}

// Distinct from isAuthorized so hosted-without-key gets an actionable error
// instead of a bare 401 the dashboard cannot explain.
function authMisconfigured() {
  return !config.proxyKey && hostedExposure()
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sameOrigin(req) {
  const host = req.headers.host || ""
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function bridgeJson(pathname, init) {
  const url = config.bridgeUrl.replace(/\/$/, "") + pathname
  const r = await fetch(url, init)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, json, text }
}

let modelCache = { at: 0, ids: [] }
async function bridgeModels(force = false) {
  if (!force && Date.now() - modelCache.at < 15000) return modelCache.ids
  try {
    const r = await bridgeJson("/v1/models")
    const ids = (r.json?.data || []).map((m) => m.id)
    if (ids.length) modelCache = { at: Date.now(), ids }
  } catch {}
  return modelCache.ids
}

// ---------------------------------------------------------------- bridge boot

function findBun() {
  const home = process.env.USERPROFILE || process.env.HOME || ""
  const candidates = [
    process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin", "bun"),
    home && path.join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return "bun"
}

async function bridgeAlive() {
  try {
    const r = await bridgeJson("/health", { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
}

// The bridge only runs under Bun next to the dashboard. When BRIDGE_URL points
// somewhere else (a VPS, a tunnel, another host) this process is a pure
// reverse proxy and must never try to spawn anything.
function bridgeIsLocal() {
  try {
    return isLocalHost(new URL(config.bridgeUrl).hostname)
  } catch {
    return false
  }
}

const bridgeState = { up: false, lastCheck: 0, restarts: 0, lastError: null, starting: false }

async function ensureBridge() {
  if (await bridgeAlive()) {
    if (!bridgeState.up) log(`bridge already running at ${config.bridgeUrl}`)
    bridgeState.up = true
    bridgeState.lastCheck = Date.now()
    return true
  }
  bridgeState.up = false
  bridgeState.lastCheck = Date.now()
  if (!bridgeIsLocal() || IS_VERCEL) {
    bridgeState.lastError = "remote bridge unreachable — check BRIDGE_URL"
    log(bridgeState.lastError)
    return false
  }
  if (!config.autoStartBridge) {
    log("bridge not running and autoStartBridge is off")
    bridgeState.lastError = "autoStartBridge is off"
    return false
  }
  if (bridgeState.starting) return false
  bridgeState.starting = true
  const dir = path.isAbsolute(config.bridgeDir) ? config.bridgeDir : path.join(__dirname, config.bridgeDir)
  if (!fs.existsSync(path.join(dir, "server.js"))) {
    bridgeState.starting = false
    bridgeState.lastError = `bridge entry missing: ${path.join(dir, "server.js")}`
    log(bridgeState.lastError)
    return false
  }
  const port = new URL(config.bridgeUrl).port || "20129"
  const bin = findBun()
  log(`starting bridge: ${bin} server.js (port ${port})`)
  const child = spawn(bin, ["server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => String(d).trim().split("\n").forEach((l) => l && log(`bridge: ${l}`)))
  child.stderr.on("data", (d) => String(d).trim().split("\n").forEach((l) => l && log(`bridge! ${l}`)))
  child.on("exit", (code) => {
    log(`bridge exited (${code})`)
    bridgeState.up = false
  })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await bridgeAlive()) {
      log("bridge is up")
      bridgeState.up = true
      bridgeState.starting = false
      return true
    }
  }
  bridgeState.starting = false
  bridgeState.lastError = "bridge did not come up in 20s"
  log(bridgeState.lastError)
  return false
}

// Keep the bridge alive without a manual restart. Runs every 15s and restarts
// as soon as a health probe fails (with a 30s cooldown so a broken bridge
// cannot turn into a spawn storm).
let watchdogTimer = null
let lastRestartAttempt = 0
function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    const up = await bridgeAlive()
    bridgeState.lastCheck = Date.now()
    if (up) {
      bridgeState.up = true
      return
    }
    const wasUp = bridgeState.up
    bridgeState.up = false
    if (!config.autoStartBridge || bridgeState.starting) return
    if (!bridgeIsLocal() || IS_VERCEL) {
      bridgeState.lastError = "remote bridge unreachable — check BRIDGE_URL"
      return
    }
    if (Date.now() - lastRestartAttempt < 30000) return
    lastRestartAttempt = Date.now()
    log(wasUp ? "bridge stopped responding — restarting" : "bridge is down — attempting restart")
    const ok = await ensureBridge()
    if (ok) bridgeState.restarts++
  }, 15000)
  if (watchdogTimer.unref) watchdogTimer.unref()
}

// ---------------------------------------------------------------- opencode

function run(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let out = ""
    let child
    // spawn(..., { shell: true }) with an args array is deprecated (DEP0190).
    // On Windows the opencode entry is a .cmd shim, so run it through cmd.exe
    // explicitly instead of asking Node to build a shell command string.
    const [file, argv] =
      process.platform === "win32"
        ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmd, ...args]]
        : [cmd, args]
    try {
      child = spawn(file, argv, { windowsHide: true })
    } catch (e) {
      resolve({ out: String(e), code: -1 })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ out, code: -2 }) }, timeoutMs)
    child.stdout?.on("data", (d) => (out += d))
    child.stderr?.on("data", (d) => (out += d))
    child.on("error", (e) => { clearTimeout(timer); resolve({ out: out + String(e), code: -1 }) })
    child.on("exit", (code) => { clearTimeout(timer); resolve({ out, code }) })
  })
}

async function opencodeStatus() {
  const st = await run("opencode", ["service", "status"], 10000)
  const urls = st.out.match(/https?:\/\/[^\s"'<>]+/g) || []
  return { url: urls[0] || null, raw: st.out.trim().slice(0, 2000) }
}

async function opencodePair() {
  const res = await run("opencode", ["pair"], 15000)
  const urls = res.out.match(/https?:\/\/[^\s"'<>]+/g) || []
  const link = urls.find((u) => u.includes("/auth/connect/")) || urls[0] || null
  const qr = res.out.split("\n").filter((l) => /[█▀▄]/.test(l)).join("\n")
  return { link, qr: qr || null, raw: res.out.trim().slice(0, 4000) }
}

// ---------------------------------------------------------------- status

async function buildStatus() {
  let health = null
  let upstreamOk = false
  let upstream = config.bridgeUrl
  let ua = "opencode-free-bridge"
  let uaAutoVersion = ""
  let models = []
  let bridgeGate = null
  try {
    const h = await bridgeJson("/health", { signal: AbortSignal.timeout(4000) })
    health = h.json
    upstreamOk = h.ok && (health?.status === "ok" || !!health?.identity)
    upstream = health?.identity?.endpoints?.chatUrl || config.bridgeUrl
    ua = health?.identity?.userAgent || ua
    uaAutoVersion = health?.identity?.release?.version || ""
    bridgeGate = health?.identity?.gate?.status || null
  } catch {}

  models = await bridgeModels()
  const configured = config.fallbackModels || []
  const served = models.length ? models : configured

  const now = Date.now()
  const times = counters.times.filter((t) => now - t < 5 * 60 * 1000)
  counters.times = times
  const lastMinute = times.filter((t) => now - t < 60 * 1000).length

  const observed = {}
  for (const r of recent) {
    observed[r.model] ||= { ok: 0, fail: 0 }
    if (r.status < 300) observed[r.model].ok++
    else observed[r.model].fail++
  }

  return {
    upstreamOk,
    upstream,
    ua,
    uaAutoVersion,
    deployment: {
      hosted: hostedExposure(),
      vercel: IS_VERCEL,
      remoteBridge: !bridgeIsLocal() || IS_VERCEL,
      bridgeMisconfigured: IS_VERCEL && bridgeIsLocal(),
      keyRequired: !!config.proxyKey,
      keyMissing: authMisconfigured(),
    },
    allModels: !!config.allModels,
    allModelsTarget: config.allModelsTarget,
    uptime: Math.floor((now - startedAt) / 1000),
    requests: {
      total: counters.total,
      errors: counters.errors,
      lastMinute,
      last5m: times.length,
    },
    models: { total: served.length, allowed: served.length, served },
    recent,
    sync: {
      at: modelCache.at || null,
      running: false,
      working: [],
      rateLimited: [],
      // The v2 gate only answers agent-shaped traffic, so a catalog entry is
      // reported as agent-only instead of pretending a probe proved it.
      gated: served,
      flaky: [],
      dead: [],
      observed,
    },
    bridge: {
      url: config.bridgeUrl,
      panel: config.bridgeUrl + "/",
      gate: bridgeGate,
      version: health?.version || null,
      runtime: health?.runtime || null,
      discoveredModels: health?.discoveredModels ?? served.length,
      egress: health?.egress?.mode || null,
      up: bridgeState.up,
      restarts: bridgeState.restarts,
      lastCheck: bridgeState.lastCheck || null,
      lastError: bridgeState.lastError,
    },
  }
}

// ---------------------------------------------------------------- /v1 proxy

// Models that exist in the wider ecosystem but not in the free catalog. In
// all-models mode a request for one of these is answered by the closest free
// model instead of a 400 "Model is unavailable".
const FAMILY_ROUTES = [
  [/^(gpt-|chatgpt|openai\/|o[1-4](-|$))/i, "deepseek-v4.1-flash-free"],
  [/^(claude|anthropic\/|sonnet|opus|haiku)/i, "beam-free"],
  [/^(grok|xai\/)/i, "beam-free"],
  [/^(gemini|google\/|gemma)/i, "nemotron-3.5-super-vl-free"],
  [/^(qwen|deepseek|kimi|moonshot|glm|z-?ai\/)/i, "deepseek-v4.1-flash-free"],
  [/^(llama|meta\/|mistral|codestral|mixtral)/i, "flint-40b-free"],
]

const EFFORT_SUFFIX = /#(minimal|low|medium|high|max)$/i

function splitEffort(model) {
  const m = String(model || "")
  const match = m.match(EFFORT_SUFFIX)
  if (!match) return { base: m, effort: "" }
  return { base: m.slice(0, -match[0].length), effort: match[1].toLowerCase() }
}

function pickFamilyRoute(model) {
  for (const [re, target] of FAMILY_ROUTES) if (re.test(model)) return target
  return ""
}

function expandedModelList(entries) {
  if (!config.allModels) return entries
  const out = []
  for (const entry of entries) {
    out.push(entry)
    for (const effort of config.effortVariants || []) {
      out.push({ ...entry, id: `${entry.id}#${effort}`, x_effort: effort })
    }
  }
  return out
}

async function proxyV1(req, res) {
  if (authMisconfigured()) {
    return sendJson(res, 503, {
      error: {
        type: "unauthorized",
        message: "PROXY_KEY is not set. This deployment is publicly reachable, so it refuses to serve until you set it.",
      },
    })
  }
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: { type: "unauthorized", message: "proxy key required" } })
  }
  const target = config.bridgeUrl.replace(/\/$/, "") + req.url
  const started = Date.now()
  const chunks = []
  try {
    for await (const c of req) chunks.push(c)
  } catch {
    // Client hung up mid-upload; nothing to proxy and no response to send.
    log(`${req.method} ${req.url} -> client aborted during upload`)
    return
  }
  let body = chunks.length ? Buffer.concat(chunks) : undefined
  let model = ""
  let requestedModel = ""
  let servedBy = ""

  // Model routing: effort suffix (`#high`), aliases, then all-models family
  // routing, then defaultModel for an unknown id. Without this the dashboard's
  // alias + default settings were written but never used, and an alias
  // upstream rejects 400s.
  if (body && /json/.test(req.headers["content-type"] || "") && /\/v1\/(chat\/completions|responses|messages)$/.test(req.url.split("?")[0])) {
    try {
      const parsed = JSON.parse(body.toString("utf8"))
      requestedModel = typeof parsed.model === "string" ? parsed.model : ""
      const { base, effort } = splitEffort(requestedModel)
      const aliases = config.modelAliases && typeof config.modelAliases === "object" ? config.modelAliases : {}
      let resolved = base
      if (resolved && typeof aliases[requestedModel] === "string") resolved = aliases[requestedModel]
      else if (resolved && typeof aliases[resolved] === "string") resolved = aliases[resolved]

      const known = await bridgeModels()
      const isKnown = (id) => !known.length || known.includes(id)

      if (resolved && !isKnown(resolved)) {
        const family = config.allModels ? pickFamilyRoute(resolved) : ""
        if (family && isKnown(family)) resolved = family
        else if (config.defaultModel && isKnown(config.defaultModel)) resolved = config.defaultModel
        else if (config.allModels && isKnown(config.allModelsTarget)) resolved = config.allModelsTarget
      }
      if (!resolved) {
        resolved = config.defaultModel || (config.allModels ? config.allModelsTarget : "") || ""
      }

      if (effort) {
        // The variant is a first-class request here: forward it as the
        // upstream `reasoning_effort` the bridge already understands.
        if (parsed.reasoning_effort === undefined) parsed.reasoning_effort = effort
      }
      if (resolved && resolved !== base) parsed.model = resolved
      else if (resolved !== requestedModel && resolved) parsed.model = resolved

      if (parsed.model !== requestedModel) body = Buffer.from(JSON.stringify(parsed))
      model = resolved || ""
      servedBy = resolved && resolved !== requestedModel ? resolved : ""
    } catch {}
  } else {
    try {
      if (body) model = JSON.parse(body.toString("utf8")).model || ""
    } catch {}
  }

  let status = 502
  // Abort the upstream request when the client hangs up. Without this an
  // abandoned stream keeps consuming quota until the bridge finishes it.
  const abort = new AbortController()
  let clientGone = false
  const onClose = () => {
    if (res.writableFinished) return
    clientGone = true
    abort.abort()
  }
  res.on("close", onClose)
  try {
    const fwdHeaders = { ...req.headers }
    // The body may have been rewritten for model routing, so a stale
    // content-length (and any transfer framing) must not be forwarded.
    delete fwdHeaders["content-length"]
    delete fwdHeaders["transfer-encoding"]
    fwdHeaders.host = new URL(config.bridgeUrl).host
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      signal: abort.signal,
    })
    status = upstreamRes.status
    const headers = {}
    for (const [k, v] of upstreamRes.headers) {
      if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k)) continue
      headers[k] = v
    }
    if (servedBy) headers["x-zen-served-by"] = servedBy

    const ctype = String(headers["content-type"] || "")
    const streaming = /event-stream/i.test(ctype)
    // JSON responses can be rewritten so the caller sees the model it asked
    // for (including `#effort` variants) while `zen_served_by` records the
    // free model that actually answered. SSE is passed through untouched.
    if (requestedModel && !streaming && /application\/json/i.test(ctype)) {
      const text = await upstreamRes.text()
      let out = text
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.model === "string" && parsed.model !== requestedModel) parsed.model = requestedModel
          if (servedBy) parsed.zen_served_by = servedBy
          out = JSON.stringify(parsed)
        }
      } catch {}
      headers["content-length"] = Buffer.byteLength(out)
      res.writeHead(status, headers)
      res.end(out)
    } else {
      res.writeHead(status, headers)
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(Buffer.from(value))
          }
        } catch {
          // Either the client disconnected (upstream aborted) or the bridge
          // dropped the stream; both are already accounted for below.
        }
      }
      res.end()
    }
  } catch (e) {
    if (clientGone) {
      status = 499 // non-standard, "client closed request" — kept out of error stats
    } else if (!res.headersSent) {
      sendJson(res, 502, { error: { type: "bridge_unreachable", message: String(e?.message || e) } })
    } else res.end()
  } finally {
    res.off("close", onClose)
    // A stream can also end "successfully" after the client is already gone
    // (res.write on a destroyed socket is silently dropped), so decide the
    // recorded status here rather than in the catch block alone.
    if (clientGone) status = 499
    recordRequest({ model: model || "(none)", status, ms: Date.now() - started })
    if (clientGone) log(`${req.method} ${req.url} -> client aborted after ${Date.now() - started}ms`)
    else if (!req.url.includes("/models")) log(`${req.method} ${req.url} -> ${status} ${Date.now() - started}ms ${model}`)
  }
}

async function handleModels(req, res) {
  if (authMisconfigured()) {
    return sendJson(res, 503, {
      error: "PROXY_KEY is not set on this public deployment.",
      code: "proxy_key_missing",
    })
  }
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: { type: "unauthorized", message: "proxy key required" } })
  }
  try {
    const r = await bridgeJson("/v1/models", { signal: AbortSignal.timeout(15000) })
    const payload = r.json && typeof r.json === "object" ? r.json : { object: "list", data: [] }
    const entries = Array.isArray(payload.data) ? payload.data : []
    const data = expandedModelList(entries)
    return sendJson(res, 200, {
      ...payload,
      object: "list",
      data,
      all_models: !!config.allModels,
      effort_variants: config.allModels ? config.effortVariants : [],
    })
  } catch (e) {
    return sendJson(res, 502, {
      error: { type: "bridge_unreachable", message: String(e?.message || e) },
    })
  }
}

// Collapse consecutive identical (model, status) requests into a single row
// with a count, rather than flooding the feed with 1s.
function recordRequest({ model, status, ms }) {
  counters.total++
  if (status >= 400 && status !== 499) counters.errors++
  counters.times.push(Date.now())
  if (counters.times.length > 5000) {
    const cutoff = Date.now() - 5 * 60 * 1000
    counters.times = counters.times.filter((t) => t >= cutoff)
  }
  const last = recent[recent.length - 1]
  if (last && last.model === model && last.status === status && Date.now() - last.at < 10000) {
    last.count++
    last.at = Date.now()
    last.ms = ms
  } else {
    recent.push({ at: Date.now(), model, status, ms, count: 1 })
    if (recent.length > 100) recent.shift()
  }
}

// ---------------------------------------------------------------- routes

const handleRequest = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
  const pathname = url.pathname

  // /v1/models is answered here so all-models mode can expand every entry into
  // its `#effort` variants. Everything else under /v1/ is proxied verbatim.
  if (pathname === "/v1/models" && req.method === "GET") return handleModels(req, res)

  if (pathname.startsWith("/v1/")) return proxyV1(req, res)

  if (authMisconfigured() && pathname.startsWith("/api/")) {
    return sendJson(res, 503, {
      error:
        "PROXY_KEY is not set. This deployment is publicly reachable, so the dashboard and API are locked until it is configured.",
      code: "proxy_key_missing",
    })
  }

  if (pathname === "/api/status") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    try {
      return sendJson(res, 200, await buildStatus())
    } catch (e) {
      return sendJson(res, 500, { error: String(e?.message || e) })
    }
  }

  if (pathname === "/api/config") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    if (req.method === "GET") return sendJson(res, 200, { config })
    if (req.method === "PUT" || req.method === "POST") {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "cross-origin write rejected" })
      try {
        const incoming = JSON.parse(await readBody(req))
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          return sendJson(res, 400, { error: "config must be a JSON object" })
        }
        // Whitelist + type-check every writable key. A stray value used to be
        // merged verbatim, so the dashboard's "restore" action (which posts
        // { fallbackModels: true }) or a string where an array belongs would
        // break /api/status and the model table.
        const next = { ...config }
        for (const k of ["host", "bridgeUrl", "bridgeDir", "defaultModel", "proxyKey", "allModelsTarget"]) {
          if (typeof incoming[k] === "string") next[k] = incoming[k]
        }
        if (Number.isFinite(Number(incoming.port)) && Number(incoming.port) > 0) next.port = Number(incoming.port)
        if (typeof incoming.autoStartBridge === "boolean") next.autoStartBridge = incoming.autoStartBridge
        if (typeof incoming.allModels === "boolean") next.allModels = incoming.allModels
        if (Array.isArray(incoming.effortVariants)) {
          next.effortVariants = incoming.effortVariants
            .map((v) => String(v).toLowerCase())
            .filter((v) => ["minimal", "low", "medium", "high", "max"].includes(v))
        }

        if (incoming.fallbackModels === true) {
          const ids = await bridgeModels(true)
          next.fallbackModels = ids
        } else if (Array.isArray(incoming.fallbackModels)) {
          next.fallbackModels = incoming.fallbackModels.filter((m) => typeof m === "string" && m)
        }

        if (incoming.modelAliases && typeof incoming.modelAliases === "object" && !Array.isArray(incoming.modelAliases)) {
          const aliases = {}
          for (const [from, to] of Object.entries(incoming.modelAliases)) {
            if (typeof from === "string" && typeof to === "string" && to) aliases[from] = to
          }
          next.modelAliases = aliases
        }

        if (Array.isArray(incoming.responsesModels)) {
          next.responsesModels = incoming.responsesModels.filter((p) => typeof p === "string")
        }

        config = next
        let persisted = true
        try {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
        } catch {
          // Read-only filesystem (Vercel): keep the change for this instance
          // and tell the caller to put it in environment variables instead.
          persisted = false
        }
        log(`config saved${persisted ? "" : " (memory only — filesystem is read-only)"}`)
        return sendJson(res, 200, {
          ok: true,
          config,
          persisted,
          note: persisted ? undefined : "Filesystem is read-only here. Set the same values as environment variables (PROXY_KEY, DEFAULT_MODEL, ALL_MODELS, ...) to make them permanent.",
        })
      } catch (e) {
        return sendJson(res, 400, { error: String(e?.message || e) })
      }
    }
    return sendJson(res, 405, { error: "method not allowed" })
  }

  if (pathname === "/api/test" && req.method === "POST") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    let model = ""
    try { model = JSON.parse(await readBody(req)).model || "" } catch {}
    model = model || config.defaultModel || (await bridgeModels())[0] || "big-pickle"
    const started = Date.now()
    try {
      const r = await fetch(config.bridgeUrl.replace(/\/$/, "") + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 16,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000),
      })
      const text = await r.text()
      const ms = Date.now() - started
      const gated = /FreeUsageLimitError|FreeTierError/i.test(text)
      recordRequest({ model, status: r.status, ms })
      return sendJson(res, 200, {
        ok: r.ok,
        status: r.status,
        ms,
        gated,
        detail: r.ok ? "" : text.slice(0, 200),
      })
    } catch (e) {
      return sendJson(res, 200, { ok: false, status: 0, ms: Date.now() - started, detail: String(e?.message || e) })
    }
  }

  if (pathname === "/api/sync" && req.method === "POST") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    const ids = await bridgeModels(true)
    if (ids.length && config.fallbackModels.length === 0) {
      config.fallbackModels = ids
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
      } catch {}
    }
    log(`sync: ${ids.length} models from bridge catalog`)
    return sendJson(res, 200, { ok: true, models: ids, at: modelCache.at })
  }

  if (pathname === "/api/logs") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    const n = Math.min(1000, Number(url.searchParams.get("n")) || 300)
    return sendJson(res, 200, { logs: logs.slice(-n) })
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    counters.total = 0
    counters.errors = 0
    counters.times = []
    recent.length = 0
    return sendJson(res, 200, { ok: true })
  }

  if (pathname === "/api/bridge") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    if (req.method === "POST") {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "cross-origin write rejected" })
      if (!bridgeIsLocal() || IS_VERCEL) {
        return sendJson(res, 200, {
          ok: await bridgeAlive(),
          restarting: false,
          remote: true,
          message: "The bridge runs on another host; restart it there (or restart its Bun process).",
          state: bridgeState,
        })
      }
      const ok = await ensureBridge()
      return sendJson(res, 200, { ok, restarting: !ok, state: bridgeState })
    }
    try {
      const h = await bridgeJson("/health")
      return sendJson(res, 200, {
        ok: h.ok,
        url: config.bridgeUrl,
        panel: config.bridgeUrl + "/",
        health: h.json,
        state: bridgeState,
      })
    } catch (e) {
      return sendJson(res, 200, { ok: false, url: config.bridgeUrl, error: String(e?.message || e), state: bridgeState })
    }
  }

  if (pathname === "/api/opencode/status") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    if (IS_VERCEL) {
      return sendJson(res, 200, {
        url: null,
        raw: "The OpenCode CLI lives on your machine; this deployment cannot see it. Pair locally instead.",
        local: false,
      })
    }
    return sendJson(res, 200, await opencodeStatus())
  }

  if (pathname === "/api/opencode/pair") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    if (IS_VERCEL) {
      return sendJson(res, 200, {
        link: null,
        qr: null,
        raw: "Pairing only works on the machine running OpenCode. Run `node server.mjs` locally, or run `opencode pair` in a terminal.",
        local: false,
      })
    }
    const pair = await opencodePair()
    if (pair.link) log("opencode pair link generated")
    return sendJson(res, 200, pair)
  }

  if (pathname === "/" || pathname === "/index.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"))
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(html)
    } catch {
      return sendJson(res, 500, { error: "index.html missing" })
    }
  }

  if (pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      bridge: config.bridgeUrl,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    })
  }

  // Static assets live under /assets. Never serve the repo root: server.mjs,
  // bridge/ and zen-proxy.json sit there and must stay private.
  if (!pathname.startsWith("/assets/")) return sendJson(res, 404, { error: "not found" })
  if (pathname.includes("..") || pathname.includes("\0")) return sendJson(res, 400, { error: "bad path" })
  const safe = path.normalize(pathname.slice(1))
  const assetsDir = path.join(__dirname, "assets")
  const file = path.join(__dirname, safe)
  if (file.startsWith(assetsDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // Revalidate with an ETag keyed on size + mtime so an edited asset is
    // picked up on a normal refresh instead of a stale cached copy.
    const st = fs.statSync(file)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" })
      return res.end()
    }
    res.writeHead(200, { "content-type": guessType(file), etag, "cache-control": "no-cache" })
    return res.end(fs.readFileSync(file))
  }

  sendJson(res, 404, { error: "not found" })
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log(`request failed: ${e?.message || e}`)
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
    else {
      try { res.end() } catch {}
    }
  })
})

// Vercel (and any other serverless host) imports this module and calls the
// handler per request; it must not open a listener or spawn a bridge.
export { handleRequest }
export default handleRequest

function guessType(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream"
}

if (!IS_VERCEL) {
  server.listen(config.port, config.host, async () => {
    log(`zen-proxy dashboard on http://${config.host}:${config.port}`)
    log(`bridge backend ${config.bridgeUrl}${bridgeIsLocal() ? "" : " (remote)"}`)
    if (authMisconfigured()) log("warning: no PROXY_KEY and this is a non-loopback bind — /api and /v1 are locked")
    await ensureBridge()
    startWatchdog()
  })

  process.on("SIGTERM", () => {
    log("shutting down")
    server.close(() => process.exit(0))
  })
  process.on("SIGINT", () => {
    log("shutting down")
    server.close(() => process.exit(0))
  })
}

// A background failure (bridge watchdog, config write, stream) must not take
// the dashboard down with it.
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e?.message || e}`))
process.on("uncaughtException", (e) => log(`uncaught exception: ${e?.message || e}`))
