// Shared Vercel entry used by every route file under api/.
//
// Vercel maps filesystem paths to functions, so each public route has a small
// file that re-exports this wrapper:
//
//   api/status.mjs              -> /api/status
//   api/health.mjs              -> /api/health  (rewritten from /health)
//   api/v1/models.mjs           -> /api/v1/models (rewritten from /v1/models)
//
// The rewrite only changes the path prefix (/health -> /api/health,
// /v1/* -> /api/v1/*). No query string is involved, because a rewrite
// destination's query is not reliably preserved for functions.
//
// The wrapper maps the path back to what server.mjs expects (/api/health ->
// /health, /api/v1/* -> /v1/*) and never lets a crash escape as an opaque
// FUNCTION_INVOCATION_FAILED page.

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

function publicPath(pathname) {
  if (pathname === "/api/health") return "/health"
  if (pathname.startsWith("/api/v1/")) return pathname.slice(4)
  return pathname
}

function requestPath(req) {
  try {
    const url = new URL(req.url, "http://localhost")
    // Legacy deployments may still send the original path as __zp.
    const original = url.searchParams.get("__zp")
    if (original) {
      url.searchParams.delete("__zp")
      const qs = url.searchParams.toString()
      return original + (qs ? "?" + qs : "")
    }
    url.pathname = publicPath(url.pathname)
    return url.pathname + url.search
  } catch {
    return req.url || "/"
  }
}

export async function route(req, res) {
  // Remember what the platform actually handed us, for /api/_debug and 404s.
  req.__zpIn = req.url
  req.url = requestPath(req)
  try {
    const app = await loadApp()
    await app(req, res)
  } catch (error) {
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

export default route
