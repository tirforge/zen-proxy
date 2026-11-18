// Auth shim in front of the OpenCode free bridge.
//
// The bridge itself has no authentication, and it should never be exposed
// unauthenticated: it spends free-tier quota on OpenCode's behalf.
//
//   tailnet / tunnel ──> this (0.0.0.0:20130, Bearer <key>) ──> 127.0.0.1:20129
//
// The key is the same PROXY_KEY the dashboard uses, so the Vercel proxy's
// Authorization header passes straight through.

const PORT = Number(process.env.AUTH_PORT || 20130)
const HOST = process.env.AUTH_HOST || "0.0.0.0"
const TARGET = (process.env.BRIDGE_TARGET || "http://127.0.0.1:20129").replace(/\/$/, "")
const KEY = process.env.BRIDGE_KEY || ""

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/healthz") {
      return json(200, { ok: true, shim: "zen-bridge-auth", target: TARGET, keyRequired: !!KEY })
    }

    const auth = req.headers.get("authorization") || ""
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    const headerKey = req.headers.get("x-api-key") || ""
    if (KEY && bearer !== KEY && headerKey !== KEY) {
      return json(401, { error: { type: "unauthorized", message: "bridge key required" } })
    }

    const headers = new Headers(req.headers)
    headers.delete("host")
    headers.set("host", new URL(TARGET).host)

    const init = { method: req.method, headers, redirect: "manual" }
    if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body

    let upstream
    try {
      upstream = await fetch(TARGET + url.pathname + url.search, init)
    } catch (e) {
      return json(502, { error: { type: "bridge_unreachable", message: String((e && e.message) || e) } })
    }

    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  },
})

console.log(`[zen-bridge-auth] listening on http://${HOST}:${server.port} -> ${TARGET} (key ${KEY ? "required" : "OFF"})`)
