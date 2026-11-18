#!/usr/bin/env node
// zen-proxy · dashboard + bridge
//
// Serves the zen-proxy dashboard (public/index.html) and hands every /v1/*
// request to a local opencode-free-bridge instance, which does the actual
// upstream work (v2 gate shape, identity, fallbacks, egress pool).
//
//   node server.mjs          # or: bun server.mjs
//
// The bridge is auto-started on first boot when it is not already listening.

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")

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
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    return { ...DEFAULTS, ...raw }
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n")
    return { ...DEFAULTS }
  }
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

function isAuthorized(req) {
  if (!config.proxyKey) return true
  const auth = req.headers.authorization || ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  const headerKey = req.headers["x-api-key"] || ""
  return bearer === config.proxyKey || headerKey === config.proxyKey
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

async function ensureBridge() {
  if (await bridgeAlive()) {
    log(`bridge already running at ${config.bridgeUrl}`)
    return
  }
  if (!config.autoStartBridge) {
    log("bridge not running and autoStartBridge is off")
    return
  }
  const dir = path.isAbsolute(config.bridgeDir) ? config.bridgeDir : path.join(__dirname, config.bridgeDir)
  if (!fs.existsSync(path.join(dir, "server.js"))) {
    log(`bridge entry missing: ${path.join(dir, "server.js")}`)
    return
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
  child.on("exit", (code) => log(`bridge exited (${code})`))
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await bridgeAlive()) {
      log("bridge is up")
      return
    }
  }
  log("bridge did not come up in 20s")
}

// ---------------------------------------------------------------- opencode

function run(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let out = ""
    let child
    try {
      child = spawn(cmd, args, { shell: process.platform === "win32", windowsHide: true })
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
    },
  }
}

// ---------------------------------------------------------------- /v1 proxy

async function proxyV1(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: { type: "unauthorized", message: "proxy key required" } })
  }
  const target = config.bridgeUrl.replace(/\/$/, "") + req.url
  const started = Date.now()
  const chunks = []
  for await (const c of req) chunks.push(c)
  let body = chunks.length ? Buffer.concat(chunks) : undefined
  let model = ""

  // Apply model routing from config: aliases first, then defaultModel for an
  // unknown/absent id. Without this the dashboard's alias + default settings
  // were written but never used, and an alias upstream rejects 400s.
  if (body && /json/.test(req.headers["content-type"] || "") && /\/v1\/(chat\/completions|responses|messages)$/.test(req.url.split("?")[0])) {
    try {
      const parsed = JSON.parse(body.toString("utf8"))
      const requested = typeof parsed.model === "string" ? parsed.model : ""
      let resolved = requested
      const aliases = config.modelAliases && typeof config.modelAliases === "object" ? config.modelAliases : {}
      if (requested && typeof aliases[requested] === "string") resolved = aliases[requested]
      const known = await bridgeModels()
      if ((!resolved || (known.length && !known.includes(resolved) && !resolved.includes("/"))) && config.defaultModel) {
        resolved = config.defaultModel
      }
      if (resolved && resolved !== requested) {
        parsed.model = resolved
        body = Buffer.from(JSON.stringify(parsed))
      }
      model = resolved || ""
    } catch {}
  } else {
    try {
      if (body) model = JSON.parse(body.toString("utf8")).model || ""
    } catch {}
  }

  let status = 502
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
    })
    status = upstreamRes.status
    const headers = {}
    for (const [k, v] of upstreamRes.headers) {
      if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k)) continue
      headers[k] = v
    }
    res.writeHead(status, headers)
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
      } catch {}
    }
    res.end()
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: { type: "bridge_unreachable", message: String(e?.message || e) } })
    else res.end()
  } finally {
    const ms = Date.now() - started
    counters.total++
    if (status >= 400) counters.errors++
    counters.times.push(Date.now())
    if (counters.times.length > 5000) {
      const cutoff = Date.now() - 5 * 60 * 1000
      counters.times = counters.times.filter((t) => t >= cutoff)
    }
    recent.push({ at: Date.now(), model: model || "(none)", status, ms, count: 1 })
    if (recent.length > 100) recent.shift()
    if (!req.url.includes("/models")) log(`${req.method} ${req.url} -> ${status} ${ms}ms ${model}`)
  }
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
  const pathname = url.pathname

  if (pathname.startsWith("/v1/")) return proxyV1(req, res)

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
        for (const k of ["host", "bridgeUrl", "bridgeDir", "defaultModel", "proxyKey"]) {
          if (typeof incoming[k] === "string") next[k] = incoming[k]
        }
        if (Number.isFinite(Number(incoming.port)) && Number(incoming.port) > 0) next.port = Number(incoming.port)
        if (typeof incoming.autoStartBridge === "boolean") next.autoStartBridge = incoming.autoStartBridge

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
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
        log("config saved")
        return sendJson(res, 200, { ok: true, config })
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
      counters.total++
      if (r.status >= 400) counters.errors++
      counters.times.push(Date.now())
      recent.push({ at: Date.now(), model, status: r.status, ms, count: 1 })
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
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
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
    try {
      const h = await bridgeJson("/health")
      return sendJson(res, 200, { ok: h.ok, url: config.bridgeUrl, panel: config.bridgeUrl + "/", health: h.json })
    } catch (e) {
      return sendJson(res, 200, { ok: false, url: config.bridgeUrl, error: String(e?.message || e) })
    }
  }

  if (pathname === "/api/opencode/status") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    return sendJson(res, 200, await opencodeStatus())
  }

  if (pathname === "/api/opencode/pair") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })
    const pair = await opencodePair()
    if (pair.link) log("opencode pair link generated")
    return sendJson(res, 200, pair)
  }

  if (pathname === "/" || pathname === "/index.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"))
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(html)
    } catch {
      return sendJson(res, 500, { error: "public/index.html missing" })
    }
  }

  if (pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      bridge: config.bridgeUrl,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    })
  }

  // static assets (if any are added later)
  if (pathname.includes("..") || pathname.includes("\0")) return sendJson(res, 400, { error: "bad path" })
  const safe = path.normalize(pathname).replace(/^([/\\])+/, "")
  const publicDir = path.join(__dirname, "public")
  const file = path.join(publicDir, safe)
  if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": guessType(file) })
    return res.end(fs.readFileSync(file))
  }

  sendJson(res, 404, { error: "not found" })
})

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

server.listen(config.port, config.host, async () => {
  log(`zen-proxy dashboard on http://${config.host}:${config.port}`)
  log(`bridge backend ${config.bridgeUrl}`)
  await ensureBridge()
})

process.on("SIGINT", () => {
  log("shutting down")
  server.close(() => process.exit(0))
})
