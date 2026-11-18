// Adds the zen-proxy provider(s) to the OpenCode config, keeping everything else.
// Usage: node scripts/add-opencode-provider.mjs <config.jsonc> <models.json>
import fs from "node:fs"

const cfgPath = process.argv[2]
const modelsPath = process.argv[3]
const ids = JSON.parse(fs.readFileSync(modelsPath, "utf8"))

const NAMES = {
  "big-pickle": "Big Pickle",
  "mimo-v2.6-flash-free": "MiMo V2.6 Flash",
  "deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash",
  "longcat-2.5-free": "LongCat 2.5",
  "iceman-free": "Iceman",
  "inkling-2-small-free": "Inkling 2 Small",
  "beam-free": "Beam",
  "flint-40b-free": "Flint 40B",
  "nemotron-3.5-super-vl-free": "Nemotron 3.5 Super VL",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
  "hy4-flash-free": "HY4 Flash",
}

const title = (id) => {
  const [base, effort] = id.split("#")
  const name = NAMES[base] || base
  return effort ? `${name} (${effort})` : name
}

const buildModels = () => {
  const models = {}
  for (const id of ids) {
    models[id] = {
      name: title(id),
      tools: true,
      reasoning: true,
      limit: { context: 131072, output: 32768 },
    }
  }
  return models
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
cfg.provider = cfg.provider || {}

const models = buildModels()
cfg.provider.zen = {
  npm: "@ai-sdk/openai-compatible",
  name: "Zen Proxy (hosted)",
  options: { baseURL: "https://zen-proxy-opal.vercel.app/v1", apiKey: "aarsha" },
  models,
}
cfg.provider["zen-local"] = {
  npm: "@ai-sdk/openai-compatible",
  name: "Zen Proxy (local)",
  options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "aarsha" },
  models,
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8")
console.log(`providers: ${Object.keys(cfg.provider).join(", ")}`)
console.log(`models per zen provider: ${Object.keys(models).length}`)
