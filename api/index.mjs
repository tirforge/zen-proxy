// Vercel entry point.
//
// Vercel serves index.html and assets/ statically and routes /api/*, /v1/* and
// /health here through vercel.json. The destination carries the original path
// in `__zp`, because a rewrite would otherwise replace req.url with the
// function's own path.
//
// The bridge cannot run on Vercel: its free-tier gate refuses Node's TLS
// fingerprint. Point BRIDGE_URL at a bridge running under Bun somewhere
// reachable (VPS, tunnel, home server) and this deployment becomes
// dashboard + reverse proxy in front of it.

let appPromise = null

function loadApp() {
  if (!appPromise) {
    appPromise = import("../server.mjs").then((m) => {
      const fn = m.handleRequest || m.default
      if (typeof fn !== "function") throw new Error("server.mjs did not export a handler")
      return fn
    })
  }
  return appPromise
}

function restorePath(req) {
  try {
    const url = new URL(req.url, "http://localhost")
    const original = url.searchParams.get("__zp")
    if (original) {
      url.searchParams.delete("__zp")
      const qs = url.searchParams.toString()
      req.url = original + (qs ? "?" + qs : "")
    }
  } catch {}
}

export default async function handler(req, res) {
  restorePath(req)
  try {
    const app = await loadApp()
    await app(req, res)
  } catch (error) {
    // Never let the platform show an opaque FUNCTION_INVOCATION_FAILED page:
    // answer with the real message so the failing line is visible in the
    // browser and in the Vercel runtime logs.
    const message = String((error && (error.stack || error.message)) || error)
    console.error("[zen-proxy] request failed:", message)
    if (res.headersSent) {
      try { res.end() } catch {}
      return
    }
    const body = JSON.stringify({
      error: "zen_proxy_crashed",
      message: String((error && error.message) || error),
      hint: "Check the Vercel runtime log for the stack trace. Usually BRIDGE_URL is unset or not reachable.",
    })
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    })
    res.end(body)
  }
}
