// Vercel Edge runtime probe: does its TLS stack pass OpenCode's free-tier gate?
export const config = { runtime: "edge" }

export default async function handler(req) {
  const sessionId = "ses_" + crypto.randomUUID().replace(/-/g, "")
  const started = Date.now()
  try {
    const r = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        authorization: "Bearer public",
        "user-agent": "opencode/latest/2.0.32/cli",
        "x-opencode-client": "cli",
        "x-opencode-project": "0".repeat(40),
        "x-opencode-session": sessionId,
        "x-opencode-session-id": sessionId,
        "x-session-affinity": sessionId,
        "x-session-id": sessionId,
      },
      body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "Reply with exactly: ok" }], stream: false }),
    })
    const text = await r.text()
    return new Response(JSON.stringify({ runtime: "edge", status: r.status, ms: Date.now() - started, body: text.slice(0, 600) }), {
      headers: { "content-type": "application/json" },
    })
  } catch (e) {
    return new Response(JSON.stringify({ runtime: "edge", error: String(e?.message || e) }), { headers: { "content-type": "application/json" } })
  }
}
