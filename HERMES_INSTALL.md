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
- Prefer Frigate's authenticated port **8971** over HTTPS. Port **5000** is the
  internal interface: it bypasses Frigate's role enforcement, and it is often
  not reachable from other hosts at all.

Build the server once (Hermes spawns the built entry point):

```sh
cd /path/to/frigate-mcp
npm ci
npm run build          # produces dist/cli.js
```

## 2. Put the credentials in Hermes' secret store

Hermes keeps secrets in the **active profile's** `.env` (mode 600) and
interpolates `${VAR}` placeholders into the MCP server configuration. Keep the
Frigate password **out** of `config.yaml`.

> **Profile pitfall.** Hermes keeps one `config.yaml` and one `.env` **per
> profile** (`~/.hermes/profiles/<name>/`). The MCP server entry and the
> secrets must live in the **same** profile: an entry in one profile with
> secrets in another starts with no configuration and fails with a bare
> "Connection closed". Check which profile you are in and point every command
> at it:
>
> ```sh
> hermes profile list          # or: echo "$HERMES_HOME"
> export HERMES_HOME=/home/you/.hermes/profiles/<your-profile>
> ```

```sh
cat >> "$HERMES_HOME/.env" <<'EOF'
FRIGATE_API_ROOT=https://frigate.example.internal:8971/api
FRIGATE_USERNAME=viewer
FRIGATE_PASSWORD=your-viewer-password
FRIGATE_CAMERAS=front,back
EOF
```

`FRIGATE_API_ROOT` must be the **exact** API root, including `/api` and any
reverse-proxy path prefix. The server never appends `/api` itself.

Two details that are easy to get wrong:

- **Use the authenticated port over HTTPS.** Frigate's `8971` is the TLS
  interface; plain HTTP to it is rejected with a 400.
- **A self-signed certificate needs pinning** — see the next section.

`FRIGATE_CAMERAS` is optional but recommended: it restricts what the agent can
see (see [Camera scope](#6-camera-scope)).

## 3. Self-signed certificates

Frigate's built-in certificate is self-signed with a wildcard common name
(`CN = *`) and **no subject alternative name**. Two consequences:

- Trusting it as a certificate authority (`FRIGATE_CA_CERT_FILE`) is not
  enough: a hostname check can never match `*`, so the connection fails with
  `certificate_mismatch`.
- The server therefore supports **pinning** the exact certificate with
  `FRIGATE_TLS_PIN_CERT_FILE`. The pinned certificate becomes the only trusted
  anchor for that connection and the hostname is not checked against it, so the
  traffic stays encrypted and only the holder of that certificate can
  impersonate the server.

Export the certificate once:

```sh
mkdir -p ~/.config/frigate-mcp
openssl s_client -connect frigate.example.internal:8971 -servername frigate.example.internal </dev/null 2>/dev/null \
  | sed -n '/BEGIN CERT/,/END CERT/p' > ~/.config/frigate-mcp/frigate-cert.pem
chmod 600 ~/.config/frigate-mcp/frigate-cert.pem
```

and add it to the profile's `.env`:

```sh
FRIGATE_TLS_PIN_CERT_FILE=/home/you/.config/frigate-mcp/frigate-cert.pem
```

If the certificate is issued by a real CA, use `FRIGATE_CA_CERT_FILE` (or
`NODE_EXTRA_CA_CERTS`) instead and skip pinning. TLS verification is never
disabled: `NODE_TLS_REJECT_UNAUTHORIZED=0` is not a supported configuration.

The server reports TLS problems precisely, so a failure names its remedy:

| Error code | Meaning |
| --- | --- |
| `untrusted_certificate` | The certificate is not signed by a trusted authority — set `FRIGATE_CA_CERT_FILE` |
| `certificate_mismatch` | The certificate does not match this host — set `FRIGATE_TLS_PIN_CERT_FILE` |

## 4. Register the server with Hermes

`--args` uses `argparse.REMAINDER`, so it **must be the last option**:

```sh
hermes mcp add frigate \
  --env FRIGATE_API_ROOT='${FRIGATE_API_ROOT}' \
        FRIGATE_USERNAME='${FRIGATE_USERNAME}' \
        FRIGATE_PASSWORD='${FRIGATE_PASSWORD}' \
        FRIGATE_CAMERAS='${FRIGATE_CAMERAS}' \
        FRIGATE_TLS_PIN_CERT_FILE='${FRIGATE_TLS_PIN_CERT_FILE}' \
  --command node \
  --args /absolute/path/to/frigate-mcp/dist/cli.js
```

Hermes performs a discovery probe while adding: it starts the server, lists the
tools, and asks whether to enable them all. Accept, or pick a subset.

> **If the probe fails**, Hermes still saves the entry — but **disabled**. Fix
> the cause (usually the `.env` in the wrong profile, the wrong API root, or an
> untrusted certificate), then enable it:
>
> ```sh
> hermes mcp test frigate      # re-run the probe
> hermes mcp configure frigate  # toggle the server and its tools
> ```

A failed probe usually prints `Connection closed`: the server process exited
before the handshake. The usual causes are a missing `FRIGATE_API_ROOT` (the
server refuses to start without it), an unreachable API root, or a certificate
that is not trusted.

Verify:

```sh
hermes mcp test frigate      # connect and list the tools
hermes mcp list              # the configured servers
hermes mcp configure frigate # toggle individual tools later
```

The next Hermes session picks the server up (MCP discovery runs at startup). If
a gateway or desktop app is already running, restart it.

## 5. Remote option — Streamable HTTP

Use this when Hermes does not run on the Frigate host, or when several agents
should share one server.

On the Frigate host:

```sh
export FRIGATE_MCP_TRANSPORT=http
export FRIGATE_API_ROOT=https://frigate.example.internal:8971/api
export FRIGATE_USERNAME=viewer
export FRIGATE_PASSWORD=your-viewer-password
export FRIGATE_TLS_PIN_CERT_FILE=/home/you/.config/frigate-mcp/frigate-cert.pem
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
bearer token (input is masked). It stores the token in the profile's `.env` as
`MCP_FRIGATE_API_KEY` and writes the header template
`Authorization: Bearer ${MCP_FRIGATE_API_KEY}` into `config.yaml`.

**The MCP endpoint is not Frigate.** Frigate never speaks MCP: pointing Hermes
at the Frigate port gives Frigate's own HTTP answers (a 404 or 405 for
`POST /mcp`), not an MCP session. The MCP endpoint is this server, on its own
port.

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

## 6. Camera scope

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

## 7. What Hermes gets

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

## 8. Configuration reference

| Variable | Default / meaning |
| --- | --- |
| `FRIGATE_API_ROOT` | Required absolute HTTP(S) API root, without URL credentials, query, or fragment |
| `FRIGATE_USERNAME` / `FRIGATE_PASSWORD` | Managed Frigate login (uses `POST /login` with `user` and `password`) |
| `FRIGATE_BEARER_TOKEN` | Alternative: an externally supplied bearer JWT, forwarded verbatim and never refreshed |
| `FRIGATE_AUTH_COOKIE_NAME` | `frigate_token`, Frigate's `auth.cookie_name` |
| `FRIGATE_CAMERAS` | Comma-separated camera allowlist |
| `FRIGATE_CA_CERT_FILE` | PEM file with a private CA to trust (HTTPS only); TLS verification stays on |
| `FRIGATE_TLS_PIN_CERT_FILE` | PEM file with one exact certificate to pin (HTTPS only); required for a self-signed `CN = *` certificate |
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

## 9. Security notes

- **Credentials never enter the sandbox.** They stay in the server process and
  in the profile's `.env`; they are never tool arguments, prompt content, or
  log lines.
- **Use a dedicated viewer account.** The Frigate `admin` account bypasses the
  role checks the camera scope depends on.
- **Rotate a credential that ever appeared in a log, a transcript, or a bug
  report.** Once a secret is printed, treat it as exposed and replace it in
  the Frigate UI and in the profile's `.env`.
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

## 10. Troubleshooting

| Symptom | Check |
| --- | --- |
| `hermes mcp add` cannot connect, probe says `Connection closed` | The `.env` is in a **different profile** than the config; `FRIGATE_API_ROOT` is reachable; the binary is built (`npm run build`); `node` is on `PATH` |
| The server was saved **disabled** | The probe failed — fix the cause, then `hermes mcp configure frigate` to enable it |
| Every tool answers `untrusted_certificate` | The certificate is self-signed: export it and set `FRIGATE_TLS_PIN_CERT_FILE` |
| Every tool answers `certificate_mismatch` | The certificate is trusted but does not match the host: pin it with `FRIGATE_TLS_PIN_CERT_FILE` |
| Frigate itself answers 400 or 404 | The API root points at port 5000 or plain HTTP; use `https://<host>:8971/api` |
| Hermes answers 404/405 on `POST /mcp` | Hermes is pointed at Frigate's port instead of this server's MCP endpoint |
| Tools answer with an authentication error | The Frigate account is wrong, or `FRIGATE_PASSWORD` did not resolve from the profile's `.env` |
| A camera is missing | It is outside `FRIGATE_CAMERAS`, or the Frigate account cannot read it |
| `feature_disabled` from `search_events` | Semantic search is off on that instance; fall back to `list_events` with ordinary filters |
| `not_found` for a clip or image | The evidence expired or was never recorded; a gap in footage is not proof that nothing happened |
| An artifact URI fails to read | It expired, or it was outside the camera scope |

## 11. Optional: check a real instance

The default test suite never touches a real NVR. An opt-in, read-only live
check is available:

```sh
FRIGATE_LIVE_API_ROOT=https://frigate.example.internal:8971/api \
FRIGATE_USERNAME=viewer FRIGATE_PASSWORD=your-viewer-password \
FRIGATE_TLS_PIN_CERT_FILE=/home/you/.config/frigate-mcp/frigate-cert.pem \
npm run test:live
```

It only reads health, version, statistics, and configuration, and it is skipped
unless `FRIGATE_LIVE_API_ROOT` is set.

## Compatibility

The contract was verified against **Frigate v0.18.2** tagged source, and
confirmed against a live `0.18.2` instance. Other releases are reported
explicitly as `unknown` or `unsupported` instead of being claimed as supported.

See the main [README.md](README.md) for the full tool contracts, the
compatibility baseline, the durable bridge, and the restart/replay behaviour.
