// Validates the zen-proxy additions in an OpenCode config.
// node scripts/validate-opencode-config.mjs <config> <backup> <liveModelsJson>
import fs from "node:fs"

const [cfgPath, bakPath, livePath] = process.argv.slice(2)
const raw = fs.readFileSync(cfgPath)
const cfg = JSON.parse(raw.toString("utf8"))
const bak = JSON.parse(fs.readFileSync(bakPath, "utf8"))
const live = JSON.parse(fs.readFileSync(livePath, "utf8")).data.map((m) => m.id)

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

ok(!raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "file starts with a UTF-8 BOM")
ok(raw.toString("utf8").endsWith("\n"), "file does not end with a newline")

const keys = (o) => Object.keys(o).sort().join(",")
ok(keys(cfg) === keys(bak), `top-level keys changed: ${keys(bak)} -> ${keys(cfg)}`)
ok(JSON.stringify(cfg.mcp) === JSON.stringify(bak.mcp), "mcp block changed")
ok(cfg.model === bak.model, "default model changed")
ok(cfg.small_model === bak.small_model, "small_model changed")

for (const id of Object.keys(bak.provider)) {
  ok(JSON.stringify(cfg.provider[id]) === JSON.stringify(bak.provider[id]), `existing provider ${id} changed`)
}

for (const id of ["zen", "zen-local"]) {
  const p = cfg.provider[id]
  ok(!!p, `${id} provider missing`)
  if (!p) continue
  ok(p.npm === "@ai-sdk/openai-compatible", `${id}: npm is ${p.npm}`)
  ok(typeof p.options?.baseURL === "string" && p.options.baseURL.endsWith("/v1"), `${id}: bad baseURL`)
  ok(p.options?.apiKey === "aarsha", `${id}: apiKey is not aarsha`)
  const models = Object.keys(p.models || {})
  ok(models.length === live.length, `${id}: ${models.length} models, live reports ${live.length}`)
  const missing = live.filter((m) => !p.models[m])
  ok(missing.length === 0, `${id}: missing live models ${missing.join(", ")}`)
  const extra = models.filter((m) => !live.includes(m))
  ok(extra.length === 0, `${id}: models not served upstream ${extra.join(", ")}`)
  for (const m of models) {
    const entry = p.models[m]
    ok(/\S/.test(m) && !/\s/.test(m), `${id}: bad model id "${m}"`)
    ok(typeof entry.name === "string" && entry.name.length > 0, `${id}/${m}: missing name`)
    ok(entry.tools === true, `${id}/${m}: tools is not true`)
    ok(Number.isInteger(entry.limit?.context) && entry.limit.context > 0, `${id}/${m}: bad context limit`)
    ok(Number.isInteger(entry.limit?.output) && entry.limit.output > 0, `${id}/${m}: bad output limit`)
  }
  const dupes = models.length - new Set(models).size
  ok(dupes === 0, `${id}: ${dupes} duplicate model ids`)
  console.log(`${id}: ${models.length} models, baseURL ${p.options.baseURL}`)
}

console.log(problems.length ? "PROBLEMS:\n- " + problems.join("\n- ") : "config OK")
process.exit(problems.length ? 1 : 0)
