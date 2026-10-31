# frigate-mcp

Read-only Frigate MCP tools with an optional **pi-durable code-mode bridge**.

Implemented: [issues #1](https://github.com/punissuer/frigate-mcp/issues/1)–[#9](https://github.com/punissuer/frigate-mcp/issues/9) — the complete read-only v1 surface: `get_system_status`, `list_cameras`, `get_capabilities`, `list_events`, `get_event`, `search_events`, `list_review_items`, `get_review_item`, `get_recording_summary`, `list_recordings`, `get_latest_frame`, `get_event_image`, `get_event_clip`, and `get_recording_clip`, over **stdio** and **Streamable HTTP**, with managed login, camera scope, bounded retries, paged event investigation, semantic search, review segments, recording availability, bounded images, private expiring evidence artifacts, and durable restart/replay acceptance.

## Develop and verify

Use **Node.js 24 LTS, version 24.15.0 or newer within 24.x**.

```sh
npm ci
npm run typecheck
npm test
npm run smoke
```

The smoke command starts a controlled HTTP fixture and runs real QuickJS code mode inside a pi-durable harness. A scripted faux provider supplies the predetermined tool call; it does not contact an LLM. The script discovers the Frigate namespace and calls through the durable bridge → stdio MCP server → fixture HTTP API. Only the selected structured result reaches the simulated model. Tests also exercise ordinary MCP clients, login/session refresh, camera scope, auth failures, schema validation, cancellation, limits, retries, and transport failures.

No NVR or provider credentials are required. Tests never contact a real Frigate instance or modify footage. `npm run build` produces the executable and declarations; `npm pack --dry-run` checks the distributable.

## Remote Streamable HTTP server

The same server can run over Streamable HTTP (legacy SSE is not supported). Start it with:

```sh
export FRIGATE_MCP_TRANSPORT=http
export FRIGATE_API_ROOT=https://frigate.example.internal/api
export FRIGATE_USERNAME='viewer'
export FRIGATE_PASSWORD='<password from your secret manager>'
export FRIGATE_MCP_HTTP_SECRET="$(openssl rand -base64 48)"
export FRIGATE_MCP_HTTP_HOST=127.0.0.1
export FRIGATE_MCP_HTTP_PORT=8080
node dist/cli.js
```

| Environment variable | Default / meaning |
| --- | --- |
| `FRIGATE_MCP_TRANSPORT` | `stdio`; set to `http` for the Streamable HTTP endpoint |
| `FRIGATE_MCP_HTTP_SECRET` | Required in HTTP mode. A high-entropy bearer secret, **distinct from the Frigate credential** |
| `FRIGATE_MCP_HTTP_HOST` | `127.0.0.1`; loopback by default |
| `FRIGATE_MCP_HTTP_PORT` | `8080` |
| `FRIGATE_MCP_HTTP_PATH` | `/mcp` |
| `FRIGATE_MCP_HTTP_ALLOWED_ORIGINS` | Optional comma-separated Origin allowlist; when set, a request with a different `Origin` is refused |
| `FRIGATE_MCP_HTTP_SESSION_TTL_MS` | `1800000`, session lifetime (30 minutes) |
| `FRIGATE_MCP_HTTP_MAX_SESSIONS` | `16`, concurrent sessions |
| `FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK` | Required to bind a non-loopback address |

Security properties of the remote transport:

- **Every** request — tool calls, session operations, and resource reads — must carry `Authorization: Bearer <FRIGATE_MCP_HTTP_SECRET>`. The secret is compared in constant time; a missing and a wrong secret get the same answer.
- The MCP secret is separate from the Frigate credential and never enters the sandbox, a tool argument, or a log line.
- The camera scope, the tool contracts, and every policy limit are identical to the stdio server: a remote client can do exactly what a local one can, and no more.
- Sessions are bounded in number and lifetime, request bodies are bounded in size, and unknown session identifiers and wrong paths are refused with sanitized answers.
- **Bind loopback by default.** A non-loopback bind is an explicit operator decision (`FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK=true`) and must be paired with TLS at the service or a trusted ingress. **Never publish Frigate's internal port 5000**, and never expose Frigate's ports directly; put the MCP endpoint behind your own authenticated reverse proxy.

The durable bridge connects to a remote server with the same tool contracts:

```ts
import { connectFrigateHttp } from 'frigate-mcp/durable';
const bridge = await connectFrigateHttp({ url: 'https://mcp.example.internal/mcp', secret: process.env.FRIGATE_MCP_HTTP_SECRET! });
```

## Install in Hermes

Hermes, and other MCP clients, can add this server with a single command. See
[HERMES_INSTALL.md](HERMES_INSTALL.md) for the full guide: build steps, secret
handling in `~/.hermes/.env`, the `hermes mcp add` invocation, the remote
Streamable HTTP variant, camera scope, the tool inventory, and troubleshooting.

## Local stdio server

Configure an **exact API root**, including `/api` and any reverse-proxy path prefix. A trailing slash is optional. The server will not append another `/api`.

```sh
export FRIGATE_API_ROOT=https://frigate.example.internal/api
export FRIGATE_USERNAME='viewer'
export FRIGATE_PASSWORD='<password from your secret manager>'
node dist/cli.js
```

A stdio MCP client must launch this process; this is not an interactive shell command. After local installation the executable is `frigate-mcp`. Stdout is reserved for MCP messages. Startup failures produce a sanitized stderr diagnostic and nonzero exit status.

Example MCP client configuration (use an absolute executable path and your client's secret injection mechanism):

```json
{
  "mcpServers": {
    "frigate": {
      "command": "node",
      "args": ["/absolute/path/to/frigate-mcp/dist/cli.js"],
      "env": {
        "FRIGATE_API_ROOT": "https://frigate.example.internal/api",
        "FRIGATE_USERNAME": "${FRIGATE_USERNAME}",
        "FRIGATE_PASSWORD": "${FRIGATE_PASSWORD}"
      }
    }
  }
}
```

Environment substitution in this JSON is client-specific. It is **not** a configuration loader supplied by pi-durable. Do not commit credentials or place them in tool arguments.

| Environment variable | Default / meaning |
| --- | --- |
| `FRIGATE_API_ROOT` | Required absolute HTTP(S) API root, without URL credentials, query, or fragment |
| `FRIGATE_USERNAME` | Optional Frigate username for managed `/login` sessions; requires `FRIGATE_PASSWORD` |
| `FRIGATE_PASSWORD` | Optional Frigate password for managed `/login` sessions; requires `FRIGATE_USERNAME` |
| `FRIGATE_BEARER_TOKEN` | Optional externally supplied bearer JWT; forwarded verbatim and never refreshed |
| `FRIGATE_AUTH_COOKIE_NAME` | `frigate_token`, Frigate's `auth.cookie_name`; the cookie the managed session reads |
| `FRIGATE_CAMERAS` | Optional comma-separated camera allowlist; discovery and statistics are restricted to it |
| `FRIGATE_CA_CERT_FILE` | Optional PEM file with a private CA to trust in addition to the system store (HTTPS only) |
| `FRIGATE_TRUSTED_UNAUTHENTICATED` | `false`; required to run without credentials against port 5000 |
| `FRIGATE_ALLOW_INSECURE_HTTP` | `false`; must explicitly be `true` for a trusted HTTP network or local fixture |
| `FRIGATE_TIMEOUT_MS` | `15000`, one deadline for all components of a read; range 1–60000 |
| `FRIGATE_MAX_RESPONSE_BYTES` | `5242880`, per upstream response, enforced while streaming; may only be lowered |
| `FRIGATE_MAX_CONCURRENT` | `4`, concurrent tool calls/upstream reads, range 1–32; excess calls return `busy` instead of growing a queue |
| `FRIGATE_EVENTS_PAGE_SIZE` | `50`, default event page size; range 1–200 and never above the server maximum |
| `FRIGATE_EVENTS_MAX_WINDOW_SECONDS` | `86400`, maximum historical event window (24 hours) |
| `FRIGATE_MAX_RESULT_BYTES` | `262144`, maximum serialized structured result size (256 KiB) |
| `FRIGATE_MEDIA_MAX_BYTES` | `5242880`, maximum image response size (5 MiB), enforced while streaming |
| `FRIGATE_MEDIA_TIMEOUT_MS` | `60000`, deadline for image reads |
| `FRIGATE_ARTIFACT_DIR` | A private directory for evidence artifacts; defaults to a per-user temporary directory |
| `FRIGATE_ARTIFACT_QUOTA_BYTES` | `1073741824`, total storage quota for published artifacts (1 GiB) |
| `FRIGATE_ARTIFACT_TTL_SECONDS` | `3600`, lifetime of a published artifact |
| `FRIGATE_CLIP_MAX_DURATION_SECONDS` | `120`, maximum evidence clip duration |
| `FRIGATE_CLIP_MAX_BYTES` | `52428800`, maximum evidence clip size (50 MiB) |

Prefer authenticated Frigate port **8971**, directly or through a trusted TLS reverse proxy, and a least-privilege viewer account. Port **5000 bypasses Frigate role enforcement**; use it only on a trusted private network, with explicit `FRIGATE_TRUSTED_UNAUTHENTICATED=true` and explicit HTTP opt-in if applicable. TLS verification stays enabled. `FRIGATE_CA_CERT_FILE` adds a private CA without disabling verification; Node's `NODE_EXTRA_CA_CERTS` also works at process startup. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Never supply Frigate's JWT signing secret. The MCP server does not listen on an HTTP port yet.

## Authentication

Three operator-selected modes:

- **Managed session** (`FRIGATE_USERNAME` + `FRIGATE_PASSWORD`): the server signs in with `POST /login`, reads Frigate's configured session cookie (`FRIGATE_AUTH_COOKIE_NAME`, default `frigate_token`), and sends it with later reads. The password is only ever sent in the login request body.
- **External bearer token** (`FRIGATE_BEARER_TOKEN`): the token is forwarded verbatim. It is never refreshed, so an expired token produces an actionable authentication error instead of a retry loop.
- **Unauthenticated**: only for a trusted network or an instance with Frigate authentication disabled.

Session renewals are serialized, so concurrent reads share one login instead of stampeding the upstream. Each read performs **at most one** authentication retry. Rejected credentials are remembered: bad credentials fail once, actionably, and are not retried. A session that Frigate revokes is re-authenticated once per read and then reported.

## Camera scope

`FRIGATE_CAMERAS` restricts what the server may observe:

- `list_cameras` returns only the allowlisted cameras, their zone names, and detection state.
- `get_system_status` drops statistics for cameras outside the scope and omits unscopable global aggregates (detector inference speed) instead of leaking counts or names.
- A request for a camera outside the scope is **rejected** with a `forbidden` error rather than broadened.

Only allowlisted configuration fields are read from `GET /config`: camera identifiers, zone names, detection state, and tracked object labels. Raw configuration, RTSP URLs, provider credentials, filesystem paths, and environment variables never leave the server.

## Tool contracts

### `get_system_status({})`

Makes only `GET /`, `/version`, and `/stats` beneath the configured API root. Unknown input properties are rejected. It returns:

- `structuredContent.ok`, `data`, and `meta`; failures also include a stable `error` and MCP `isError: true`.
- Independent health, version, and statistics component outcomes, including partial results.
- `authorizedApiAccess`: `confirmed` only after a successful, valid protected `/stats` read; `denied` for 401/403; otherwise `unknown`.
- Sanitized camera FPS/detection fields, detector inference speeds, service uptime and update time. No raw statistics, process command lines, RTSP URLs, storage paths, or configuration.
- Observation time, contract release, and compatibility warnings. Retrieval time is not a camera frame timestamp.

### `list_cameras({ camera? })`

Returns the permitted camera identifiers, their zone names, and detection state, plus whether the camera scope is `restricted` or `unrestricted`. An optional `camera` filter narrows the list; a camera outside the scope is rejected.

### `get_capabilities({})`

Returns the tested Frigate version and compatibility, capability flags (`supported` or `unknown`), the tracked object labels, and the effective policy limits (scope, permitted camera count, deadline, response limit, concurrency).

Capability detection never searches events, downloads media, or claims a feature because public health succeeded. Uncertain capabilities — semantic search, image snapshots — are reported as `unknown`. Semantic search additionally cannot be confirmed without a billed upstream search.

### `list_events({ after, before, ... })`

Lists object events (`GET /events`) inside a bounded interval. `after` and `before` are required and are **UTC Unix seconds**; millisecond values are rejected with an actionable units error, as are reversed intervals and windows longer than `FRIGATE_EVENTS_MAX_WINDOW_SECONDS`.

Optional typed filters are translated to the upstream query: `cameras`, `labels`, `subLabels`, `zones`, `hasClip`, `hasSnapshot`, `inProgress`, `minScore`, `maxScore`, `limit`, `offset`, and `sort` (`date_desc` by default). No arbitrary query parameters, paths, or headers are exposed.

The result reports `page` (`limit`, `offset`, `returned`, `nextOffset` when a page was filled, and the effective `ordering`), the requested `interval`, and `completeness`. A filled page is reported as `truncated` with `complete: false` plus a warning — a partial page is never presented as an exact total or as evidence that nothing else happened. Offset paging is the only pagination the pinned release supports; no cursor is invented. Duplicate event identifiers within a page are removed.

### `get_event({ eventId })`

Reads one event (`GET /events/{event_id}`) and returns its identifier, camera, label, sub-label, zones, start/end times, evidence availability (`hasClip`, `hasSnapshot`), and optional score and speed. Event identifiers are validated and URL-encoded; path traversal is rejected before any upstream request.

Events outside the configured camera scope are rejected with `forbidden` and their metadata is never included in the error. Descriptions, OCR, and license-plate text are untrusted upstream data and are not returned. No thumbnail data is embedded.

### `search_events({ query, after, before, ... })`

Searches object events with a natural-language query over `GET /events/search`, inside the same bounded UTC Unix-second interval and with the same camera scope, byte limits, deadlines, and completeness rules as `list_events`. `searchType` selects `thumbnail`, `description`, or `both`; unsupported modes are rejected rather than silently ignored.

The result states the observed capability: `supported` after a successful search, `disabled` when the upstream service reports that semantic search is not enabled, `unsupported` when the release does not provide the endpoint, and `unknown` when the state could not be determined. `get_capabilities` never triggers a search, so it reports `semanticSearch` as `unknown` until a search is actually performed.

Relevance is reported as the upstream `searchDistance` and `searchSource`. A distance is not a confidence score and is not presented as one. The search is read-only: it never regenerates descriptions or embeddings, manages models, invokes Frigate Chat, or starts background work.

### `list_review_items({ after, before, ... })`

Lists review segments (`GET /review`) in a bounded UTC Unix-second interval, with camera, label, zone, `severity` (`alert` or `detection`), and `reviewed` filters. A review segment **groups detections**; it is not one detected object, and the result never equates the two.

The upstream review list has no paging beyond its limit, so no cursor is invented. A filled limit is reported as `complete: false` with a warning that more items may exist. Review items are never marked viewed, and nothing is deleted or modified.

### `get_review_item({ reviewId })`

Reads one review segment (`GET /review/{review_id}`) with its severity, reviewed state, times, and permitted event references. Identifiers are validated and encoded, path traversal is rejected, and a review outside the camera scope is rejected without leaking its references.

### `get_recording_summary({ camera })`

Reports the upstream recording summary for one camera: the days and hours that have recordings, with per-hour event, motion, object, and duration counts. The upstream summary covers **every recorded day** for that camera and cannot be scoped to a window, so a window argument is rejected instead of being ignored. The admin-only recordings/storage endpoint is never used.

### `list_recordings({ camera, after, before })`

Lists the recording intervals of one camera inside a required, bounded UTC Unix-second range, and reports the **gaps** between them, clipped to the requested range. A gap is missing footage, not evidence that nothing happened.

### `get_latest_frame({ camera })`

Fetches the most recent frame of one permitted camera (`GET /{camera}/latest.jpg`) as a bounded MCP image block plus small structured metadata.

- The upstream does not report the capture time, so `captureTime` is `unknown` and `retrievedAt` is reported separately. A retrieval time is not a capture time.
- When the camera is offline, Frigate may answer with a stored preview; the result then reports `source: "preview_fallback"` and a warning instead of claiming a live view.
- The image is returned as an MCP image block. The structured result never carries the image bytes, and the base64 is never printed with `text()`.

### `get_event_image({ eventId, kind })`

Fetches the `snapshot` or `thumbnail` of one permitted object event (`GET /events/{event_id}/snapshot.jpg` or `/thumbnail.jpg`). The event is resolved first and its camera is scope-checked **before** any media is requested.

A missing snapshot (`media_unavailable`), a missing or expired event (`not_found`), and a wrong MIME type (`malformed_response`) are distinct outcomes — never an empty successful image.

### `get_event_clip({ eventId })` and `get_recording_clip({ camera, start, end })`

Retrieve evidence video as a **private, expiring artifact**.

- The event clip resolves the event first: its camera is scope-checked and its duration must be safely bounded (an in-progress event, or one longer than `FRIGATE_CLIP_MAX_DURATION_SECONDS`, is refused before any download starts). The recording clip requires an explicit bounded UTC Unix-second range on a permitted camera.
- Downloads stream to private temporary storage and are published **atomically**: only a complete, size-bounded, `video/mp4` response is renamed into the artifact store. A partial or abandoned download is deleted, and video is never buffered in memory.
- The result carries an opaque `artifactId` and `uri`, the MIME type, the byte count, the creation and expiry times, and the evidence reference (camera, event id, or interval). It never carries the video bytes, a server-local path, or a credential-bearing URL.
- The artifact URI is served as a standard MCP resource. Identifiers are unguessable, guessed identifiers are refused, the camera scope is re-checked on read, and an expired artifact fails explicitly even if a durable transcript still mentions it.
- A crash between publication and the durable result commit can leave a duplicate artifact. Cleanup relies on the quota and the TTL; exactly-once download effects are not claimed.

Small structured results are mirrored as JSON text in `content` for ordinary clients. Output schemas bound camera/detector entries and identifier lengths; oversized or malformed upstream data fails rather than being silently truncated. Redirects are rejected, and upstream error bodies are never echoed. All components of a read share one deadline; reads are sequential, avoiding a fan-out beyond the configured concurrency bound.

Transient failures (network errors, 408, 429, 5xx) are retried at most twice within the deadline, with jitter and bounded `Retry-After` handling. Authorization, not-found, and validation failures are never retried.

### Compatibility baseline

The fixture contract was checked against **Frigate v0.18.2** tagged source:

- [HTTP handlers: plain-text health/version and authenticated statistics](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/app.py)
- [Authentication: `/login`, the `frigate_token` cookie, and role checks](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/auth.py)
- [Events: `/events` filters, ordering, and offset paging](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/event.py)
- [Reviews: `/review` filters, severity, and review state](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/review.py)
- [Recordings: `/\{camera\}/recordings` and the daily/hourly summary](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/record.py)
- [Statistics shape](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/stats/util.py)

`0.18.2` and its hexadecimal commit-suffixed builds are classified `supported` **for the status and discovery contracts only**. Older pre-0.18 releases are classified `unsupported`; other versions/build formats are `unknown`. Probes may still succeed on untested versions, but the result explicitly warns about compatibility. This is source/fixture contract testing, **not live-NVR certification**, and does not establish support for future tools.

Exact tested dependency versions are locked: MCP SDK **1.32.2**, Zod **4.6.7**, pi-durable/pi-ai/pi-codemode/Chord **1.4.0**. The server entry point never imports durable; the bridge's durable and pi-ai peers are optional for ordinary MCP users.

## pi-durable integration

Install the optional durable peers at **1.4.0** in the host application, along with pi-codemode and Chord. Pi CLI's `mcp.json` alone does not register tools in a pi-durable harness.

```ts
import { connectFrigateStdio, frigateNamespace } from 'frigate-mcp/durable';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';

const bridge = await connectFrigateStdio({
  command: process.execPath,
  args: ['/absolute/path/to/frigate-mcp/dist/cli.js'],
  env: {
    FRIGATE_API_ROOT: process.env.FRIGATE_API_ROOT!,
    FRIGATE_USERNAME: process.env.FRIGATE_USERNAME!,
    FRIGATE_PASSWORD: process.env.FRIGATE_PASSWORD!,
  },
});
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
registry.install(bridge.extension);
registry.install(createCodemodeExtension({
  sandbox,
  namespaces: [frigateNamespace],
}));
// Open your harness with this registry. Keep the bridge installed and its tools
// enabled. They use callers: ['tools'], so only code mode is offered to the model.
// On shutdown: close the harness first, then sandbox.close(), then bridge.close().
```

The bridge initializes MCP, validates the exact known read-only manifest, and registers `mcp__frigate__get_system_status`, `mcp__frigate__list_cameras`, `mcp__frigate__get_capabilities`, `mcp__frigate__list_events`, `mcp__frigate__get_event`, `mcp__frigate__search_events`, `mcp__frigate__list_review_items`, `mcp__frigate__get_review_item`, `mcp__frigate__get_recording_summary`, `mcp__frigate__list_recordings`, `mcp__frigate__get_latest_frame`, and `mcp__frigate__get_event_image` as replay-safe nested tools. Connect again on host restart; never persist the live client, credentials, or transport. Tool-contract upgrades require a compatible bridge; an unknown manifest fails closed.

A code-mode investigation can use:

```js
const namespace = await describeNamespace('frigate');
const result = await tools.mcp__frigate__get_system_status({});
if (result.isError || !result.structuredContent.ok) {
  text({ error: result.structuredContent.error, partial: result.structuredContent.data });
} else {
  text(result.structuredContent.data);
}
```

The bridge preserves MCP `content`, `structuredContent`, and `isError` in durable structured output. Returned schema-valid tool errors resolve inside scripts and must be checked. Transport/harness failures can reject: use `try/catch` or `Promise.allSettled()` when independent calls should continue.

Image tools keep their image block inside the preserved `content` array, so a script selects the block and forwards it with code mode's `image()` instead of printing base64:

```js
const frame = await tools.mcp__frigate__get_latest_frame({ camera: 'front' });
if (frame.isError || !frame.structuredContent.ok) {
  text({ error: frame.structuredContent.error });
} else {
  const picture = frame.content.find(block => block.type === 'image');
  if (picture) image(picture);
  text(frame.structuredContent.data);
}
```

### Retrieving an evidence artifact on the host

The server and the agent may run on different hosts, so artifact bytes are fetched over the MCP transport — never from a server-local path, and code mode never plays MP4:

```ts
const clip = await bridge.extension.tools.find(t => t.name === 'mcp__frigate__get_event_clip');
const result = await clip.execute({ eventId: '1700000000.100000' }, api, context);
const uri = result.structuredOutput.structuredContent.data.uri;
const artifact = await bridge.readArtifact(uri); // { mimeType, byteLength, blob }
await fs.writeFile('evidence.mp4', Buffer.from(artifact.blob, 'base64'));
```

Durable code mode journals delivered nested results; interrupted safe reads may run again and observe changed state. This slice does **not** claim exactly-once external execution or a cross-call snapshot. The deterministic harness/fixture example is in `examples/smoke.ts`.

### Restart and recovery

The durable bridge is designed for a host that restarts:

- **Persist the harness, not the connection.** Use a persistent durable storage (SQLite or JSONL) and reinstall the same extensions — the Frigate bridge and the code-mode extension — after a restart. Never persist the MCP client, the transport handle, or credentials.
- **Committed observations are reused.** After a crash, the code-mode tool reruns the script and hands it the journaled results, so a nested call whose result was committed is not issued again.
- **Interrupted safe reads may repeat.** A read that was in flight when the process died has no committed result, so it follows its own replay policy and may run again — and it can observe newer data.
- **Replay is not exactly-once execution.** It is not a cross-call snapshot either: two calls in the same investigation can observe different moments of a live system.
- **The upstream session is re-established.** The restarted server authenticates again; an expired external bearer token fails with an actionable error instead of refreshing itself.
- **Artifacts expire independently.** An artifact URI recorded before a restart fails explicitly once its TTL has passed, even though the durable transcript still mentions it.
- **Manifest changes fail closed.** If the server no longer offers exactly the known read-only manifest, the bridge refuses to connect instead of rebinding an operation to something else. Upgrade the bridge and the server together, then restart the host.

### Release acceptance and live checks

- `npm test` runs the whole offline suite: it never contacts a real NVR, never modifies configuration, reviews, events, or footage, and never needs a model provider or an NVR credential.
- `npm run smoke`, `npm run example:investigation`, and `npm run example:fallback` are reproducible offline demonstrations of the same code-mode seam (discovery, bounded cross-camera reads, image forwarding, an unavailable feature with a fallback, and clip delivery).
- An **opt-in** live check is available for a real deployment:

  ```sh
  FRIGATE_LIVE_API_ROOT=https://frigate.example.internal/api \
  FRIGATE_USERNAME=viewer FRIGATE_PASSWORD=... \
  npm run test:live
  ```

  It only reads health, version, statistics, and configuration, and it is skipped unless `FRIGATE_LIVE_API_ROOT` is set. Default CI stays offline.

Known limitations are documented where they apply: the contract is verified against **Frigate v0.18.2** only, other releases report `unknown` or `unsupported` explicitly, semantic search and image snapshots are `unknown` until a real call proves them, review lists have no upstream paging, and the recording summary cannot be scoped to a window.

## Retention

Artifact lifetime and transcript retention are separate concerns:

- **Artifacts** live in `FRIGATE_ARTIFACT_DIR`, are bounded by `FRIGATE_ARTIFACT_QUOTA_BYTES`, and expire after `FRIGATE_ARTIFACT_TTL_SECONDS`. Expired artifacts are removed, and the directory is created with private permissions.
- **Transcripts, tool results, and image blocks** are retained by the durable host according to the host's own storage policy. They can contain surveillance observations and image bytes, so that storage should be protected and expired on the host's schedule — the server does not and cannot purge it.
- The server never logs image bytes, event descriptions, or credentials.

The full approved plan and dependency graph are in [docs/spec.md](docs/spec.md).
