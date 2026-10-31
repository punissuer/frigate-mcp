# Installing frigate-mcp in Hermes

This guide adds the **read-only Frigate MCP server** to
[Hermes](https://github.com/) as an ordinary MCP server.

Hermes is a plain MCP client, so it talks to `frigate-mcp` over the standard
protocol. The optional **pi-durable bridge** (`frigate-mcp/durable`) is *not*
needed here — it exists for pi-durable code-mode hosts. Hermes gets the same
tools, contracts, camera scope, and policy limits either way.

---

## 1. Prerequisites

- **Node.js 24 LTS** (24.15.0 or newer within 24.x) on the machine that runs
  the server.
- A Frigate instance you can reach, and a **least-privilege viewer account**.
- Prefer Frigate's authenticated port **8971** (directly or behind a trusted
  TLS reverse proxy). Port **5000 bypasses Frigate's role enforcement** — only
  use it on a trusted private network, and never publish it.

Build the server once (Hermes spawns the built entry point):

```sh
cd /path/to/frigate-mcp
npm ci
npm run build          # produces dist/cli.js
```

## 2. Put the credentials in Hermes' secret store

Hermes keeps secrets in `~/.hermes/.env` (mode 600) and interpolates
`${VAR}` placeholders into the MCP server configuration. Keep the Frigate
password **out** of `config.yaml`:

```sh
cat >> ~/.hermes/.env <<'EOF'
FRIGATE_API_ROOT=https://frigate.example.internal/api
FRIGATE_USERNAME=viewer
FRIGATE_PASSWORD=your-viewer-password
FRIGATE_CAMERAS=front,back
EOF
```

`FRIGATE_API_ROOT` must be the **exact** API root, including `/api` and any
reverse-proxy path prefix. The server never appends `/api` itself.

`FRIGATE_CAMERAS` is optional but recommended: it restricts what the agent can
see (see [Camera scope](#5-camera-scope)).

## 3. Register the server with Hermes

`--args` uses `argparse.REMAINDER`, so it **must be the last option**:

```sh
hermes mcp add frigate \
  --env FRIGATE_API_ROOT='${FRIGATE_API_ROOT}' \
        FRIGATE_USERNAME='${FRIGATE_USERNAME}' \
        FRIGATE_PASSWORD='${FRIGATE_PASSWORD}' \
        FRIGATE_CAMERAS='${FRIGATE_CAMERAS}' \
  --command node \
  --args /absolute/path/to/frigate-mcp/dist/cli.js
```

Hermes performs a discovery probe while adding: it starts the server, lists the
tools, and asks whether to enable them all. Accept, or pick a subset.

Verify:

```sh
hermes mcp test frigate     # connect and list the tools
hermes mcp list             # the configured servers
hermes mcp configure frigate # toggle individual tools later
```

The next Hermes session picks the server up (MCP discovery runs at startup). If
a gateway or desktop app is already running, restart it.

## 4. Remote option — Streamable HTTP

Use this when Hermes does not run on the Frigate host, or when several agents
should share one server.

On the Frigate host:

```sh
export FRIGATE_MCP_TRANSPORT=http
export FRIGATE_API_ROOT=https://frigate.example.internal/api
export FRIGATE_USERNAME=viewer
export FRIGATE_PASSWORD=your-viewer-password
export FRIGATE_MCP_HTTP_SECRET="$(openssl rand -base64 48)"
export FRIGATE_MCP_HTTP_HOST=127.0.0.1     # loopback by default
export FRIGATE_MCP_HTTP_PORT=8080
node dist/cli.js
```

In Hermes:

```sh
hermes mcp add frigate --url https://mcp.example.internal/mcp --auth header
```

Hermes asks whether the server requires authentication and then prompts for the
bearer token (input is masked). It stores the token in `~/.hermes/.env` as
`MCP_FRIGATE_API_KEY` and writes the header template
`Authorization: Bearer ${MCP_FRIGATE_API_KEY}` into `config.yaml`.

### HTTP transport settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRIGATE_MCP_TRANSPORT` | `stdio` | Set to `http` for the Streamable HTTP endpoint |
| `FRIGATE_MCP_HTTP_SECRET` | — | Required in HTTP mode. High-entropy bearer secret, **distinct from the Frigate credential** |
| `FRIGATE_MCP_HTTP_HOST` | `127.0.0.1` | Bind address; loopback by default |
| `FRIGATE_MCP_HTTP_PORT` | `8080` | Bind port |
| `FRIGATE_MCP_HTTP_PATH` | `/mcp` | Endpoint path |
| `FRIGATE_MCP_HTTP_ALLOWED_ORIGINS` | — | Optional comma-separated Origin allowlist |
| `FRIGATE_MCP_HTTP_SESSION_TTL_MS` | `1800000` | Session lifetime (30 minutes) |
| `FRIGATE_MCP_HTTP_MAX_SESSIONS` | `16` | Concurrent sessions |
| `FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK` | — | Required to bind a non-loopback address |

## 5. Camera scope

`FRIGATE_CAMERAS` restricts the server, not the model:

- `list_cameras` returns only the allowlisted cameras, their zone names, and
  detection state.
- `get_system_status` drops statistics for cameras outside the scope and omits
  unscopable global aggregates (detector inference speed) rather than leaking
  the wider scope.
- A request for a camera outside the scope is **rejected**, not broadened.

Without `FRIGATE_CAMERAS`, the server returns whatever the Frigate account may
read. Only deploy it with an account whose permissions match the data you
intend to expose.

## 6. What Hermes gets

Fourteen read-only tools, registered as `mcp__frigate__<tool>`:

| Tool | Purpose |
| --- | --- |
| `get_system_status` | Health, version compatibility, sanitized statistics, `authorizedApiAccess` |
| `list_cameras` | Permitted camera identifiers, zone names, detection state |
| `get_capabilities` | Capability flags (`supported` / `unknown`), tracked labels, effective policy limits |
| `list_events` | Object events in a bounded UTC Unix-second interval, with completeness metadata |
| `get_event` | One event: classification, times, evidence availability |
| `search_events` | Natural-language search with an explicit capability state |
| `list_review_items` / `get_review_item` | Review segments — a segment groups detections, it is not one object |
| `get_recording_summary` / `list_recordings` | Recording availability, with the gaps between intervals |
| `get_latest_frame` / `get_event_image` | Bounded images, with capture-freshness caveats |
| `get_event_clip` / `get_recording_clip` | Evidence video as a private, expiring artifact |

Every tool answers with a structured envelope (`structuredContent`) mirrored as
JSON text, plus `isError` on failure. The model should check
`structuredContent.ok` before reporting conclusions.

**Evidence artifacts.** The clip tools return an opaque
`frigate://artifact/<id>` URI, not video bytes. Hermes exposes a per-server
`read_resource` utility tool (`mcp__frigate__read_resource`) that fetches those
bytes through the MCP transport — the server's local path is never assumed to
exist on the agent host. Artifacts expire (`FRIGATE_ARTIFACT_TTL_SECONDS`,
default 1 hour) and are bounded by `FRIGATE_ARTIFACT_QUOTA_BYTES` (default
1 GiB).

## 7. Configuration reference

| Variable | Default / meaning |
| --- | --- |
| `FRIGATE_API_ROOT` | Required absolute HTTP(S) API root, without URL credentials, query, or fragment |
| `FRIGATE_USERNAME` / `FRIGATE_PASSWORD` | Managed Frigate login (uses `POST /login`) |
| `FRIGATE_BEARER_TOKEN` | Alternative: an externally supplied bearer JWT, forwarded verbatim and never refreshed |
| `FRIGATE_AUTH_COOKIE_NAME` | `frigate_token`, Frigate's `auth.cookie_name` |
| `FRIGATE_CAMERAS` | Comma-separated camera allowlist |
| `FRIGATE_CA_CERT_FILE` | PEM file with a private CA to trust (HTTPS only); TLS verification stays on |
| `FRIGATE_ALLOW_INSECURE_HTTP` | `true` only for a trusted HTTP network |
| `FRIGATE_TRUSTED_UNAUTHENTICATED` | Required to run without credentials against port 5000 |
| `FRIGATE_TIMEOUT_MS` | `15000` — one deadline for all components of a read |
| `FRIGATE_MAX_RESPONSE_BYTES` | `5242880` — per upstream response, enforced while streaming |
| `FRIGATE_MAX_CONCURRENT` | `4` — concurrent upstream reads; excess calls return `busy` |
| `FRIGATE_EVENTS_PAGE_SIZE` | `50` — event page size, capped at 200 |
| `FRIGATE_EVENTS_MAX_WINDOW_SECONDS` | `86400` — maximum historical event window |
| `FRIGATE_MAX_RESULT_BYTES` | `262144` — maximum serialized structured result |
| `FRIGATE_MEDIA_MAX_BYTES` | `5242880` — maximum image size |
| `FRIGATE_MEDIA_TIMEOUT_MS` | `60000` — deadline for image reads |
| `FRIGATE_ARTIFACT_DIR` | Private directory for evidence artifacts (default: a per-user temp directory) |
| `FRIGATE_ARTIFACT_QUOTA_BYTES` | `1073741824` — artifact storage quota |
| `FRIGATE_ARTIFACT_TTL_SECONDS` | `3600` — artifact lifetime |
| `FRIGATE_CLIP_MAX_DURATION_SECONDS` | `120` — maximum clip duration |
| `FRIGATE_CLIP_MAX_BYTES` | `52428800` — maximum clip size |

## 8. Security notes

- **Credentials never enter the sandbox.** They stay in the server process and
  in Hermes' secret store; they are never tool arguments, prompt content, or
  log lines.
- **The MCP bearer secret is separate from the Frigate credential.** In HTTP
  mode every request — tool calls, session operations, and resource reads —
  must carry it, and it is compared in constant time.
- **Bind loopback by default.** A non-loopback bind is an explicit decision
  (`FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK=true`) and must sit behind TLS at the
  service or a trusted ingress. Never publish Frigate's ports.
- **The server is read-only.** It never writes configuration, marks reviews
  viewed, deletes events or recordings, or starts background jobs. Every
  upstream call is a read.
- **Treat upstream strings as data.** Event descriptions, OCR text, and plate
  numbers are untrusted upstream content, not instructions.
- **Retention.** Artifacts expire on the server's TTL and quota. The
  *transcript* — tool results and image blocks Hermes stores — lives under
  Hermes' own storage policy and may contain surveillance observations;
  protect and expire it on that schedule.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| `hermes mcp add` cannot connect | `FRIGATE_API_ROOT` reachable from this host; the binary built (`npm run build`); `node` on `PATH` |
| Tools answer with an authentication error | The Frigate account is wrong, or `FRIGATE_PASSWORD` did not resolve from `~/.hermes/.env` |
| A camera is missing | It is outside `FRIGATE_CAMERAS`, or the Frigate account cannot read it |
| `feature_disabled` from `search_events` | Semantic search is off on that instance; fall back to `list_events` with ordinary filters |
| `not_found` for a clip or image | The evidence expired or was never recorded; a gap in footage is not proof that nothing happened |
| An artifact URI fails to read | It expired, or it was outside the camera scope |

## 10. Optional: check a real instance

The default test suite never touches a real NVR. An opt-in, read-only live
check is available:

```sh
FRIGATE_LIVE_API_ROOT=https://frigate.example.internal/api \
FRIGATE_USERNAME=viewer FRIGATE_PASSWORD=your-viewer-password \
npm run test:live
```

It only reads health, version, statistics, and configuration, and it is skipped
unless `FRIGATE_LIVE_API_ROOT` is set.

## Compatibility

The contract was verified against **Frigate v0.18.2** tagged source. Other
releases are reported explicitly as `unknown` or `unsupported` instead of being
claimed as supported, and no live NVR has been certified by this project.

See the main [README.md](README.md) for the full tool contracts, the
compatibility baseline, the durable bridge, and the restart/replay behaviour.
