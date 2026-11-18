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
| API key | `public` |
| Model | any id from `GET /v1/models` |

## What the dashboard adds over the bridge alone

- **Overview** — requests served, upstream health, bridge gate state, live feed
- **Models** — every free model the bridge discovered, one-click test, default model
- **Settings** — default/fallback models, aliases, proxy key, bridge URL
- **Logs** — request log tail
- **Bridge backend card** — bridge version/runtime, egress mode, gate status
- **OpenCode buttons**
  - `◱ Bridge egress panel` → the bridge's own panel (`:20129`), where the egress
    proxy/pool is configured
  - `◈ OpenCode web UI` → opens the OpenCode server URL (`opencode service status`)
  - `🔗 Pair OpenCode` → runs `opencode pair`, shows the one-time sign-in link
    (valid 5 minutes), copies it to the clipboard

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
| `GET` | `/v1/models` | proxied model list |
| `GET` | `/` | dashboard |
| `GET` | `/health` | dashboard health |
| `GET`/`PUT` | `/api/config` | read / update `zen-proxy.json` |
| `GET` | `/api/status` | stats, models, bridge state |
| `POST` | `/api/test` | `{"model":"..."}` — tiny completion |
| `POST` | `/api/sync` | refresh model list from the bridge |
| `GET` | `/api/logs?n=300` | log tail |
| `GET` | `/api/bridge` | bridge `/health` passthrough |
| `GET` | `/api/opencode/status` | OpenCode server URL |
| `GET` | `/api/opencode/pair` | run `opencode pair`, return link |

## Configuration (`zen-proxy.json`, created on first run)

| Key | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | Dashboard bind (restart required) |
| `bridgeUrl` | `http://127.0.0.1:20129` | Bridge backend |
| `bridgeDir` | `bridge` | Vendored bridge location |
| `autoStartBridge` | `true` | Spawn the bridge if it is not listening |
| `defaultModel` | `""` | Model used when a request asks for an unknown id |
| `fallbackModels` | `[]` | Filled by the first sync when empty |
| `modelAliases` | `{}` | e.g. `{"gpt-4o":"beam-free"}` |
| `proxyKey` | `""` | Require a bearer key for `/v1/*` and `/api/*` |

Dashboard writes are same-origin only and require JSON, so a random web page
cannot rewrite your config.

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
- Do not expose port 8787 or 20129 publicly.

## Credits

- Dashboard/UI and original proxy: [`12errh/zen-proxy`](https://github.com/12errh/zen-proxy) (MIT)
- Backend: [`azrinaldi/opencode-free-bridge`](https://github.com/azrinaldi/opencode-free-bridge) (MIT)
- OpenCode: [`anomalyco/opencode`](https://github.com/anomalyco/opencode)

License: MIT. See [`bridge/LICENSE`](bridge/LICENSE) and
[`bridge/THIRD_PARTY_NOTICES.md`](bridge/THIRD_PARTY_NOTICES.md).
