# zen-proxy — dashboard + bridge

One app, two layers:

```
  browser ──► zen-proxy dashboard  (http://127.0.0.1:8787)
                   │  /v1/*  reverse proxy
                   ▼
              opencode-free-bridge  (http://127.0.0.1:20129)
                   │  v2 gate shape, identity, tool manifest, egress pool
                   ▼
              https://opencode.ai/inference/openai/v1
```

The **dashboard** is the original zen-proxy UI: live request feed, model list with
per-model tests, settings, logs. The **backend** is
[`azrinaldi/opencode-free-bridge`](https://github.com/azrinaldi/opencode-free-bridge)
vendored under [`bridge/`](bridge), because it is the implementation that actually
passes OpenCode's v2 free-tier gate (correct `<env>` system block, full tool
profile, session IDs, Bun TLS fingerprint).

## Quick start

Requirements: **Node 18+** for the dashboard and **Bun** for the bridge
(the gateway refuses Node's TLS stack).

```bash
# once
#   Windows: irm bun.sh/install.ps1 | iex
#   Linux/macOS: curl -fsSL https://bun.sh/install | bash

git clone https://github.com/tirforge/zen-proxy
cd zen-proxy
node server.mjs
```

Open <http://127.0.0.1:8787>. The dashboard auto-starts the bridge on first boot
(`bun bridge/server.js`, port `20129`) if it is not already listening.

Point any agent at the dashboard — not directly at the bridge:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `public` (or your `PROXY_KEY` once set) |
| Model | any id from `GET /v1/models` |

## Deploying on Vercel

Vercel runs Node functions, and the free-tier gate refuses Node's TLS
fingerprint — so the bridge **cannot** run there. Deploy the dashboard/proxy on
Vercel and point it at a bridge you run somewhere with Bun (VPS, home server,
tunnel):

```
browser ──► Vercel (dashboard + /v1 proxy) ──► https://your-host:20129 (Bun bridge) ──► opencode
```

1. Import `tirforge/zen-proxy` in Vercel. No build step: `index.html`, `assets/`
   are static and `api/index.mjs` is the function (wired by `vercel.json`).
2. Set environment variables in the project settings:

| Variable | Required | Example |
|---|---|---|
| `PROXY_KEY` | **yes** | a long random string — the dashboard and `/v1` stay locked without it |
| `BRIDGE_URL` | **yes** | `https://bridge.example.com` (public URL of your Bun bridge) |
| `ALL_MODELS` | no | `1` enables all-models mode by default |
| `DEFAULT_MODEL` | no | `nemotron-3.5-lightning-free` |
| `HOST` / `PORT` | no | ignored on Vercel |
| `FALLBACK_MODELS`, `MODEL_ALIASES`, `RESPONSES_MODELS` | no | JSON |

3. On the bridge host, start it so the Vercel function can reach it:
   `PANEL_ALLOWED_HOSTS=bridge.example.com PORT=20129 bun server.js`
   (put it behind HTTPS/Caddy/Cloudflare; never expose a bare port to the world
   without a proxy). If you also want the egress panel reachable from the
   dashboard, allow that hostname in `PANEL_ALLOWED_HOSTS`.

Notes for the hosted setup:

- `PROXY_KEY` is enforced for `/v1/*` and `/api/*`; `/health` stays open. With no
  key on a public deployment the app answers `503 proxy_key_missing` instead of
  silently serving the free quota to anyone.
- The OpenCode web UI / pair buttons are local-only and are hidden on Vercel.
- The dashboard's Save button writes to memory only there (read-only
  filesystem); set the environment variables above to persist.
- Functions time out after 60s (`vercel.json`), so very long generations are
  cut off by the platform.

## What the dashboard adds over the bridge alone

- **Overview** — requests served, upstream health, bridge gate state, live feed
- **Models** — every free model the bridge discovered, one-click test, default model
- **Settings** — bridge URL, default model, all-models mode + target, effort
  variants, aliases, proxy key, fallback models
- **Logs** — request log tail
- **Bridge backend card** — bridge version/runtime, egress mode, gate status,
  restart count; turns red with a banner if the bridge stops answering
- **OpenCode buttons**
  - `◱ Bridge egress panel` → the bridge's own panel (`:20129`), where the egress
    proxy/pool is configured
  - `◈ OpenCode web UI` → opens the OpenCode server URL (`opencode service status`)
  - `🔗 Pair OpenCode` → runs `opencode pair`, shows the one-time sign-in link
    (valid 5 minutes), copies it to the clipboard
  - `↻ Restart bridge` → re-spawns the bridge immediately (the watchdog does the
    same automatically when `/health` fails; it retries every 15s after a 30s
    cooldown)

## Web UIs

| UI | URL | Purpose |
|---|---|---|
| Dashboard | `http://127.0.0.1:8787/` | stats, models, tests, settings, logs, pair button |
| Bridge panel | `http://127.0.0.1:20129/` | egress proxy / pool, per-egress usage |
| OpenCode web | `http://127.0.0.1:28894` (Windows) / `:49374` | full chat UI; open via **Pair OpenCode** |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | proxied to the bridge (OpenAI Chat) |
| `POST` | `/v1/responses` | proxied (OpenAI Responses) |
| `POST` | `/v1/messages` | proxied (Anthropic Messages) |
| `GET` | `/v1/models` | model list (expanded with `#effort` variants in all-models mode) |
| `GET` | `/` | dashboard |
| `GET` | `/health` | dashboard health |
| `GET`/`PUT` | `/api/config` | read / update `zen-proxy.json` |
| `GET` | `/api/status` | stats, models, bridge state |
| `POST` | `/api/test` | `{"model":"..."}` — tiny completion |
| `POST` | `/api/sync` | refresh model list from the bridge |
| `GET` | `/api/logs?n=300` | log tail |
| `GET` | `/api/bridge` | bridge `/health` passthrough + watchdog state |
| `POST` | `/api/bridge` | restart the bridge now |
| `GET` | `/api/opencode/status` | OpenCode server URL |
| `GET` | `/api/opencode/pair` | run `opencode pair`, return link |

## Configuration (`zen-proxy.json`, created on first run)

| Key | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | Dashboard bind (restart required) |
| `bridgeUrl` | `http://127.0.0.1:20129` | Bridge backend (loopback or remote) |
| `bridgeDir` | `bridge` | Vendored bridge location |
| `autoStartBridge` | `true` | Spawn the bridge if it is not listening (local only) |
| `defaultModel` | `""` | Model used when a request asks for an unknown id |
| `fallbackModels` | `[]` | Filled by the first sync when empty |
| `modelAliases` | `{}` | e.g. `{"gpt-4o":"beam-free"}` |
| `proxyKey` | `""` | Require a bearer key for `/v1/*` and `/api/*` |
| `allModels` | `false` | All-models mode (see below) |
| `allModelsTarget` | `nemotron-3.5-lightning-free` | Model unknown ids are routed to |
| `effortVariants` | `minimal, low, medium, high, max` | `#effort` suffixes exposed and accepted |

Dashboard writes are same-origin only and require JSON, so a random web page
cannot rewrite your config.

### Environment variables (old names, still supported)

The original zen-proxy variable names are kept and win over the JSON file, which
is what a Vercel deployment uses (read-only filesystem):

| Variable | Maps to |
|---|---|
| `HOST`, `PORT` | bind address |
| `PROXY_KEY` | `proxyKey` |
| `DEFAULT_MODEL` | `defaultModel` |
| `BRIDGE_URL` | `bridgeUrl` |
| `BRIDGE_DIR` | `bridgeDir` |
| `AUTO_START_BRIDGE` (`0` disables) | `autoStartBridge` |
| `ALL_MODELS` (`1` enables) | `allModels` |
| `ALL_MODELS_TARGET` | `allModelsTarget` |
| `FALLBACK_MODELS` | JSON array or comma list |
| `MODEL_ALIASES` | JSON map |
| `RESPONSES_MODELS` | JSON array or comma list |
| `ZEN_PROXY_CONFIG` | config file path |

## All-models mode

Set `ALL_MODELS=1` (env) or tick **All-models mode** in Settings when you want any
model name to work, not just the 11 free catalog ids:

- `/v1/models` lists every free model plus its `#effort` variants
  (`beam-free#high`, `nemotron-3.5-lightning-free#low`, …).
- A request for `model#effort` is routed to that model and the effort is sent
  upstream as `reasoning_effort` (the bridge already forwards it; models that do
  not reason simply ignore it).
- A request for a model the catalog does not have (`gpt-4o`, `claude-3-5-sonnet`,
  `grok-2`, anything else) is answered by the closest free model — `gpt-*` and
  `o1..o4` go to `deepseek-v4.1-flash-free`, Claude/Grok to `beam-free`,
  Gemini/Gemma to `nemotron-3.5-super-vl-free`, and so on — falling back to
  `allModelsTarget` for unknown families.
- The JSON response keeps the model name you asked for and adds
  `zen_served_by` (plus an `x-zen-served-by` header) so you can see which free
  model actually answered. Streaming responses carry the header only.

Caveat: these are still the free models. Asking for `gpt-5#max` gets you a free
model doing its best — it is not GPT-5. Without all-models mode an unknown id is
rejected by the bridge with `400 Model is unavailable` (or routed to
`defaultModel` if you set one).

## Using the free models from OpenCode itself

`opencode.json` in the project you want to use:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zenbridge/nemotron-3.5-lightning-free",
  "providers": {
    "zenbridge": {
      "name": "zen-proxy bridge",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "public"
      },
      "models": {
        "nemotron-3.5-lightning-free": { "limit": { "context": 262144, "output": 262144 } },
        "beam-free": { "limit": { "context": 1048576, "output": 131072 } }
      }
    }
  }
}
```

Reasoning effort works through variants when the model supports it, e.g.
`opencode run --model zenbridge/beam-free#high "..."`. Effort lists per model come
from OpenCode's own catalog (`models.opencode.ai`).

## Notes and limits

- **This rides OpenCode's anonymous free tier.** Quota is per egress IP, shared,
  and sometimes saturated. `429 FreeUsageLimitError` means the allowance is spent
  or the request shape was refused; the bridge's own health/gate state tells
  which. The egress panel is the sanctioned way to change egress.
- **Bun is required for live traffic** — the gate fingerprints the TLS stack and
  429s Node's.
- The dashboard reports catalog models as **agent-only** rather than "ok": the
  gate only answers agent-shaped traffic, so a bare probe cannot prove a model
  works. `Test` sends a real (small) request and reports the truth.
- **Client aborts are propagated.** If the caller disconnects, the upstream
  bridge request is aborted too, and the feed records it as `abort` (499) instead
  of counting it as an error.
- Do not expose port 8787 or 20129 publicly.

## Credits

- Dashboard/UI and original proxy: [`12errh/zen-proxy`](https://github.com/12errh/zen-proxy) (MIT)
- Backend: [`azrinaldi/opencode-free-bridge`](https://github.com/azrinaldi/opencode-free-bridge) (MIT)
- OpenCode: [`anomalyco/opencode`](https://github.com/anomalyco/opencode)

License: MIT. See [`bridge/LICENSE`](bridge/LICENSE) and
[`bridge/THIRD_PARTY_NOTICES.md`](bridge/THIRD_PARTY_NOTICES.md).
