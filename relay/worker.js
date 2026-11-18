// Minimal TLS-relay for zen-proxy on Cloudflare Workers.
//
// Why this exists: OpenCode's free-tier gate inspects the TLS ClientHello.
// Bun's handshake is accepted; Node's (Vercel, Lambda, Render, anywhere) is
// answered with HTTP 429 "FreeUsageLimitError" in ~60ms, even with identical
// headers. Cloudflare's edge TLS is a different stack, and opencode.ai is
// itself behind Cloudflare, so this Worker forwards the request from an edge
// that the gate accepts.
//
// The Vercel app stays pure Node: it keeps the dashboard, PROXY_KEY, model
// aliases and all-models routing, and only the final hop goes through here.
//
// Deploy (dashboard, no CLI):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker
//   2. Replace the default code with this file
//   3. Settings -> Variables -> add RELAY_KEY = <long random string>
//   4. Deploy, note https://<worker>.<subdomain>.workers.dev
//
// Then in Vercel:
//   RELAY_URL = https://<worker>.<subdomain>.workers.dev
//   RELAY_KEY = <same string>

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // /health is answered here so the relay can be tested without upstream.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, relay: "zen-proxy" }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
    }

    const key = env.RELAY_KEY
    if (key && request.headers.get("x-relay-key") !== key) {
      return new Response(JSON.stringify({ error: "relay key required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }

    // Everything else is forwarded to opencode.ai with the same path.
    const target = "https://opencode.ai" + url.pathname + url.search
    const headers = new Headers(request.headers)
    for (const name of ["host", "x-relay-key", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop"]) {
      headers.delete(name)
    }
    // Ask upstream for the raw body so streaming responses stay streaming.
    headers.set("accept-encoding", "identity")

    const init = { method: request.method, headers, redirect: "manual" }
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body

    let upstream
    try {
      upstream = await fetch(target, init)
    } catch (e) {
      return new Response(JSON.stringify({ error: "relay upstream failed", detail: String(e && e.message || e) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    }

    const out = new Headers(upstream.headers)
    out.set("x-zen-relay", "1")
    out.delete("content-encoding")
    out.delete("content-length")
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}
