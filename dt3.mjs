const payload = {
  model: "big-pickle",
  messages: [{ role: "user", content: "reply with the single word: ok" }],
  stream: false,
}
async function viaBridge() {
  const r = await fetch("http://127.0.0.1:20129/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
  const t = await r.text()
  return `bridge ${r.status} ${t.slice(0, 120).replace(/\s+/g, " ")}`
}
async function viaNode() {
  const crypto = await import("node:crypto")
  const UA = "opencode/latest/2.0.32/cli"
  const sid = "ses_" + crypto.randomBytes(12).toString("hex")
  const project = crypto.createHash("sha1").update("directory:" + process.cwd()).digest("hex")
  const r = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "*/*", authorization: "Bearer public",
      "user-agent": UA, "x-opencode-client": "cli", "x-opencode-project": project,
      "x-opencode-session": sid, "x-session-affinity": sid, "x-session-id": sid,
    },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(45000),
  })
  const t = await r.text()
  return `node   ${r.status} ${t.slice(0, 120).replace(/\s+/g, " ")}`
}
for (let i = 0; i < 2; i++) {
  console.log(await viaBridge())
  console.log(await viaNode())
}
