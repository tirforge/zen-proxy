// Vercel entry point.
//
// Vercel serves public/ as static files (so "/" is the dashboard) and routes
// /api/*, /v1/* and /health here through vercel.json. The destination carries
// the original path in `__zp`, because a rewrite would otherwise replace
// req.url with the function's own path.
//
// The bridge cannot run on Vercel: its free-tier gate refuses Node's TLS
// fingerprint. Point BRIDGE_URL at a bridge running under Bun somewhere
// reachable (VPS, tunnel, home server) and this deployment becomes
// dashboard + reverse proxy in front of it.

import { handleRequest } from "../server.mjs"

export const config = { runtime: "nodejs" }

export default function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost")
    const original = url.searchParams.get("__zp")
    if (original) {
      url.searchParams.delete("__zp")
      const qs = url.searchParams.toString()
      req.url = original + (qs ? "?" + qs : "")
    }
  } catch {}
  return handleRequest(req, res)
}
