# Frigate MCP implementation handoff

## Current state

The user approved the spec, test boundary, and nine-ticket implementation breakdown. All nine tickets were published to [punissuer/frigate-mcp](https://github.com/punissuer/frigate-mcp/issues) with `ready-for-agent` labels and native GitHub blocking relationships.

**Issues #1 through #9 are implemented, committed, and pushed to `main`.** A follow-up release (1.1.0) added self-signed certificate support and the Hermes installation guide after a live deployment attempt exposed two gaps: a self-signed `CN = *` certificate cannot pass a hostname check, and TLS failures were reported as a generic "unable to reach Frigate". The working tree is clean. The read-only v1 surface is complete: fifteen read-only tools over stdio and Streamable HTTP, with durable restart/replay acceptance.

The user reported: “afaict it works.” This is positive feedback, not a recorded live-Frigate test result. No live NVR or provider credentials were used by the assistant.

## Read first

1. `README.md`: current usage, configuration, authentication, camera scope, limitations, compatibility, and durable integration.
2. `docs/spec.md`: approved overall design and dependency graph.
3. `README.md` and this document: the release documentation for both transports, secret injection, CA trust, camera scope, policy defaults, retention, quotas and TTL, typed results, and known compatibility limitations.
4. `src/contract.ts`, `src/frigate.ts`, `src/auth.ts`, `src/http.ts`, and `src/durable.ts`: the existing public contracts and integration boundary.

## What issues #1 and #2 deliver

A complete, executable path:

```text
Predetermined faux-provider tool call (no external LLM)
  → pi-durable codemode tool
  → QuickJS script and tool discovery
  → durable mcp__frigate__* nested tools
  → official MCP client over stdio
  → Frigate MCP server subprocess
  → controlled Frigate HTTP fixture
```

Fourteen read-only tools are exposed:

- `get_system_status({})` reads `/`, `/version`, and `/stats` beneath an explicitly configured API root, and returns independent health/version/statistics outcomes, an `authorizedApiAccess` value confirmed only by a successful valid protected statistics read, allowlisted camera/detector fields, and a bounded, schema-validated success/error envelope mirrored as JSON text.
- `list_cameras({ camera? })` reads only allowlisted fields of `GET /config` and returns permitted camera identifiers, zone names, and detection state. It never returns raw configuration, RTSP URLs, provider keys, or paths.
- `get_capabilities({})` returns the tested version and compatibility, `supported`/`unknown` capability flags, tracked object labels, and the effective policy limits. Capability detection performs no event search and downloads no media.
- `list_events({ after, before, ... })` lists object events over `GET /events` in a required, bounded UTC Unix-second interval, with typed camera/label/sub-label/zone filters and media, progress, and score filters translated to the upstream query. It reports the effective ordering, the requested interval, and explicit completeness metadata; a filled page is reported as truncated with a continuation offset instead of an exact total.
- `get_event({ eventId })` reads one event over `GET /events/{event_id}` and returns its classification, times, and evidence availability. Identifiers are validated and encoded, path traversal is rejected, and events outside the camera scope are rejected without leaking their metadata. Descriptions, OCR, and plate text are treated as untrusted data and are not returned.

Authentication (issue #2):

- Managed username/password sessions use `POST /login` and Frigate's configured authentication cookie (`FRIGATE_AUTH_COOKIE_NAME`, default `frigate_token`). The password is only sent in the login request body.
- Externally supplied bearer JWTs are forwarded verbatim and never refreshed; an expired external token is an actionable error, not a retry loop.
- Session refreshes are serialized, each read performs at most one authentication retry, and rejected credentials are remembered so bad credentials cannot loop.

Camera scope (issue #2):

- `FRIGATE_CAMERAS` restricts discovery and the existing status statistics. Cameras outside the scope are dropped from statistics and rejected when requested explicitly. Unscopable global aggregates (detector inference speed) are omitted rather than leaking a wider scope.

- `search_events({ query, after, before, ... })` searches object events over `GET /events/search` with the same scope, time-unit, byte-limit, deadline, and completeness rules as `list_events`. It reports the observed capability state (`supported`, `disabled`, `unsupported`, `unknown`), never triggers a search during capability discovery, rejects unsupported search modes, and reports relevance as the upstream distance rather than an invented confidence. It is read-only: it never regenerates descriptions or embeddings, manages models, invokes Frigate Chat, or starts background work.

- `list_review_items({ after, before, ... })` lists review segments over `GET /review` with camera, label, zone, severity, and reviewed-state filters. A review segment groups detections and is never equated with one detected object. The upstream review list has no paging beyond its limit, so completeness is reported explicitly and no cursor is invented.
- `get_review_item({ reviewId })` reads one review segment over `GET /review/{review_id}` with its severity, reviewed state, times, and permitted event references. Out-of-scope reviews are rejected without leaking references.
- `get_recording_summary({ camera })` reports the upstream daily/hourly recording summary for one camera and states that the upstream scope covers every recorded day; an unscopable window argument is rejected rather than ignored, and the admin-only storage endpoint is never used.
- `list_recordings({ camera, after, before })` lists a camera's recording intervals in a required bounded range and reports the gaps between them, clipped to the range. A gap is missing footage, not evidence that nothing happened.

- `get_latest_frame({ camera })` fetches `GET /{camera}/latest.jpg` as a bounded MCP image block plus small metadata. The upstream reports no capture time, so `captureTime` is `unknown` and the retrieval time is reported separately; an offline camera is reported as `source: preview_fallback` instead of a live view.
- `get_event_image({ eventId, kind })` fetches an event snapshot or thumbnail. The event camera is resolved and scope-checked before any media is requested, and a missing snapshot, a missing/expired event, and a wrong MIME type are distinct outcomes.
- `get_event_preview_gif({ eventId })` fetches an event's animated preview (`GET /events/{event_id}/preview.gif`) as a bounded `image/gif` block plus small metadata. The event camera is resolved and scope-checked before any media is requested. The bytes must carry a GIF signature (`GIF87a` or `GIF89a`) and an `image/gif` type, a missing preview is `media_unavailable`, and a missing or expired event is `not_found`; the upstream reports no capture time, so freshness is `unknown`, as for the still.

Image bytes never enter a structured result, are never printed with `text()`, and are never logged; the bridge keeps the image block inside the preserved MCP content array so a script can select it and forward it with code mode's `image()`.

Remote transport and release (issue #9):

- `FRIGATE_MCP_TRANSPORT=http` starts the Streamable HTTP endpoint with the official SDK. Every request — tool calls, session operations, and resource reads — must carry `Authorization: Bearer <FRIGATE_MCP_HTTP_SECRET>`, compared in constant time; a missing and a wrong secret get the same answer.
- The MCP secret is high-entropy, distinct from the Frigate credential, and never enters the sandbox, a tool argument, or a log line. Sessions are bounded in count and lifetime, request bodies are bounded in size, and unknown sessions or paths get sanitized answers.
- The endpoint binds loopback by default; a non-loopback bind is an explicit operator decision and must sit behind TLS at the service or a trusted ingress. Frigate's internal port must never be published.
- The camera scope, the tool contracts, and every policy limit are identical on both transports: a remote client can do exactly what a local one can, and no more. The shared code-mode suite runs against the remote transport as well.
- The durable bridge gained `connectFrigateHttp`, which keeps the tool contracts, the manifest validation, and the replay policy unchanged.
- The release adds an opt-in live check (`npm run test:live`) that only reads health, version, statistics, and configuration, is skipped without `FRIGATE_LIVE_API_ROOT`, and never touches a real NVR in default CI. Two runnable code-mode examples cover discovery, bounded cross-camera reads, image forwarding, an unavailable feature with a fallback, and clip delivery.

Restart and recovery (issue #8):

- The recovery test runs a deterministic investigation in a child process against persistent SQLite durable storage, kills that process with SIGKILL while a nested call is in flight, reopens the same storage, reinstalls the bridge and the code-mode extension, and resumes the pending run.
- Upstream request counts show that a committed nested result is **not** issued again while the interrupted replay-safe read **is** issued again, and the resumed script completes with its evidence summary and completeness metadata.
- The orphaned MCP server process exits on its own when its stdin closes, so a crash leaves no unbounded subprocess or temporary media.
- The durable storage is inspected to confirm that no credential is persisted, and only durable results and metadata are stored: never a live MCP client, transport handle, or secret.
- An artifact reference that expired across the restart fails explicitly, and the bridge refuses a changed callable manifest instead of rebinding an operation.

Evidence clips (issue #7):

- `get_event_clip({ eventId })` and `get_recording_clip({ camera, start, end })` download evidence video into private temporary storage and publish it atomically. An event clip resolves the event first: its camera is scope-checked and its duration must be safely bounded before any download starts.
- Downloads stream to disk (never buffered in memory), the byte cap is enforced while streaming, and only a complete `video/mp4` response is renamed into the artifact store. Partial and abandoned downloads are deleted.
- The result carries an opaque artifact id and resource URI, the MIME type, byte count, creation and expiry times, and the evidence reference — never the video bytes, a local path, or a credential-bearing URL.
- Artifacts are served as standard MCP resources with unguessable identifiers, a camera-scope re-check, an explicit failure for expired references, a storage quota, and a TTL. The durable bridge exposes `readArtifact(uri)` so a host on another machine can fetch the bytes over the transport.
- A crash between publication and the durable result commit may leave a duplicate artifact; cleanup relies on quota and TTL, and exactly-once downloads are not claimed.

Nothing is ever marked viewed, deleted, or modified: every upstream call in this slice is a read.

Event policy (issue #3):

- Page size defaults to 50 and is capped at 200 (and never above a stricter operator policy), the historical window defaults to 24 hours, the upstream JSON cap is 5 MiB, the serialized structured result cap is 256 KiB, the metadata deadline is 15 seconds, and upstream concurrency is four. All of these are operator-tunable.
- Only the pinned release's offset paging is used; no cursor is invented, duplicate event identifiers within a page are removed, and paging over a live dataset carries an explicit shift warning.

Transport hardening (issue #2):

- Upstream reads use a minimal `node:http`/`node:https` client with TLS verification on, optional operator-supplied CA, redirect rejection, streamed byte caps, cancellation, and bounded retries (at most twice within the deadline, jitter plus bounded `Retry-After`) for transient network errors, 408, 429, and 5xx only.

The server rejects unsafe configuration, sanitizes startup and upstream errors, and never logs credentials, raw configuration, or upstream payloads. The optional durable bridge validates the exact known read-only manifest (now three tools), registers stable names with `callers: ['tools']` and `replay: 'safe'`, and preserves MCP `content`, `structuredContent`, and `isError`. The ordinary server entry point does not import durable.

## File map

| Location | Purpose |
| --- | --- |
| `src/config.ts` | Operator options/env parsing; exact API-root handling; HTTP opt-in; credential, camera-scope, CA, and policy validation |
| `src/http.ts` | Minimal HTTP(S) client: TLS verification, custom CA, no redirects, byte caps, cancellation, transport error kinds, streaming download to disk |
| `src/artifacts.ts` | Private, quota-bounded, expiring artifact store with atomic publication and cleanup |
| `src/server-http.ts` | Streamable HTTP transport: bearer authentication, Origin validation, bounded sessions and requests |
| `src/auth.ts` | Session manager: managed `/login`, cookie handling, serialized refresh, single authentication retry, bearer forwarding |
| `src/contract.ts` | Zod inputs/outputs for all three tools, sanitization schemas, release classification, expected MCP manifests |
| `src/frigate.ts` | Bounded upstream reads, retries, status/discovery aggregation, camera scoping, sanitized errors, global concurrency admission |
| `src/server.ts` | Separately importable MCP server and read-only tool registration |
| `src/cli.ts` | Executable stdio startup, sanitized diagnostics, shutdown handling |
| `src/durable.ts` | Optional stdio client bridge, manifest validation, durable tool registration, namespace metadata |
| `test/helpers/fixture.ts` | Controlled HTTP/HTTPS fixture modeled on the tagged release; `/login`, `/config`, request recording, sentinel fields |
| `test/helpers/durable.ts` | Deterministic faux-provider/harness/QuickJS runner and real stdio transport |
| `test/helpers/incompatible-server.ts` | Real stdio MCP server with an intentionally rejected manifest |
| `test/status.test.ts` | Discovery/status/result/error/limit/transport boundary tests |
| `test/lifecycle.test.ts` | Manifest rejection, cancellation, startup redaction, configuration safety |
| `test/discovery.test.ts` | Authentication, session refresh, camera scope, retries, TLS/CA, redaction boundary tests |
| `test/events.test.ts` | Event filtering, paging, completeness, scope, units, and identifier boundary tests |
| `test/search.test.ts` | Semantic search capability states, fallback, scope, and truncation boundary tests |
| `test/reviews.test.ts` | Review segment, recording interval, gap, and no-mutation boundary tests |
| `test/media.test.ts` | Image retrieval, offline fallback, scope, size cap, cancellation, and forwarding boundary tests |
| `test/clips.test.ts` | Artifact publication, resource retrieval, quota, TTL, cleanup, and cancellation boundary tests |
| `test/recovery.test.ts` | Crash and resume acceptance, expired artifact references, and manifest-change refusal |
| `test/tls.test.ts` | Self-signed certificate trust, pinning, and the login-then-authenticated-read flow |
| `test/http.test.ts` | Remote transport authentication, Origin validation, session and request bounds, and the shared code-mode suite over HTTP |
| `test/live.test.ts` | Opt-in, non-destructive live compatibility check (skipped without an API root) |
| `examples/investigation.ts` | Discovery, bounded cross-camera reads, and image forwarding |
| `examples/fallback-and-clip.ts` | An unavailable feature with a fallback, and evidence clip delivery |
| `examples/pi-durable-host.ts` | A complete pi-durable host with code mode and the Frigate bridge |
| `docs/PI_DURABLE.md` | The pi-durable code-mode walkthrough |
| `test/helpers/recovery-child.ts` | Child process that runs one investigation against persistent durable storage |
| `examples/smoke.ts` | Reproducible offline end-to-end demonstration |
| `.github/workflows/ci.yml` | Node 24 and 26 matrix: install, typecheck, tests, smoke, the pi-durable example, packaging, production audit |
| `package.json`, `package-lock.json` | Pinned dependencies, optional durable peers, separate exports, build/test commands |
| `tsconfig.json`, `tsconfig.build.json` | Strict NodeNext TypeScript configuration and declaration build |
| `.gitignore` | Existing template plus Node dependencies, secrets, and local SQLite state exclusions |

`dist/` and `node_modules/` are generated/ignored. Build output is required before launching `dist/cli.js`. Do not commit generated dependencies, secrets, or local durable databases.

## Verification already performed

Last full verification, before this handoff document was updated:

```sh
npm ci
npm run typecheck
npm test
npm run smoke
npm audit
npm pack --dry-run
git diff --check
```

Results:

- **102 tests** (101 passed, 1 skipped: the opt-in live check). The suite runs with `--test-concurrency=1`; the earlier parallel run flaked under CPU contention.
- Typecheck/build/smoke passed.
- Audit reported **zero vulnerabilities**.
- Package dry-run passed.
- Working-tree whitespace check passed.

Tests cover code-mode namespace/search discovery, model-visible versus callable tools, conventional MCP schemas/results, protected endpoint failures despite healthy public probes, version classification, malformed/wrong-MIME responses, chunked-response byte caps, stalled bodies, concurrency rejection, cancellation/recovery of capacity, incompatible manifests, subprocess shutdown, unsafe configuration, and rejected transport calls.

Issue #2 tests additionally cover successful discovery, expired external tokens, rejected credentials, revoked sessions, serialized refresh under concurrency, camera scope on discovery and statistics, role denial, malformed and oversized configuration, redirect rejection on `/config`, transient retry with `Retry-After`, cancellation of a configuration read, and custom-CA handling against a self-signed TLS fixture (skipped when `openssl` is unavailable).

Issue #3 tests additionally cover event filtering and translated query parameters, millisecond/reversed/oversized interval rejection, camera scope on filters and direct lookups, truncated pages with a continuation offset, duplicate identifier removal, equal timestamps, live-page shift warnings, short-page completeness, empty intervals, missing events, role denial, malformed and oversized event responses, and identifier path-traversal rejection.

Issue #4 tests additionally cover a successful semantic search with distance and source, a disabled service with an explicit fallback to `list_events`, a missing endpoint reported as unsupported, camera scope on search filters and results, an empty search, malformed upstream search data, a retried transient search failure, truncated search results, and rejected units, windows, and empty queries.

Issue #9 tests additionally cover a remote client running the same read-only investigation over Streamable HTTP, the durable bridge connecting remotely without changing tool contracts, unauthenticated and wrong-secret calls, a hostile Origin, artifacts behind authentication, an oversized request body, an unknown session and a wrong path, and the shared code-mode investigation over the remote transport with the same scope rules.

Issue #8 tests additionally cover a crashed investigation that resumes without repeating committed observations, an expired artifact reference failing explicitly after a restart, and the bridge refusing a changed callable manifest.

Issue #7 tests additionally cover an event clip published as an opaque artifact, artifact bytes read by a conventional MCP resource client, the durable bridge's host-side retrieval helper, guessed and forbidden artifact identifiers, an event whose duration cannot be bounded, bounded and permitted recording clips, missing recordings and wrong clip MIME types, an oversized clip rejected while streaming, quota exhaustion, TTL expiry, and a cancelled download leaving no artifact behind.

Issue #6 tests additionally cover image forwarding through code mode without printing base64, an offline camera reported as a preview fallback, a missing camera and a wrong media type as distinct errors, an oversized image rejected while streaming, event images resolving the camera before fetching media, missing snapshots and expired events as distinct outcomes, camera scope enforced before any media request, a conventional MCP client receiving the image block, and cancellation of an image read.

Issue #5 tests additionally cover an unreviewed alert selection with its details, recording summary, and gaps; forbidden direct identifiers and camera scopes; missing review items; identical review timestamps; the review limit without invented paging; invalid review and recording ranges; an unsupported summary window; role denial; malformed and oversized review responses; and an explicit assertion that no mutating request was made.

These are fixture-driven checks, not live deployment certification. Full crash/reopen durability acceptance is reserved for #8.

## Runtime and release baseline

- Node.js **>=24.15.0 and <27** (24 LTS and 26 are tested; CI runs both).
- MCP SDK **1.32.2**; Zod **4.6.7**.
- pi-durable, pi-ai, pi-codemode, and Chord **1.4.0**.
- TypeScript **5.9.3**; tsx **4.23.15**.

The Frigate fixture/status/discovery/event/review/recording contract was checked against **v0.18.2 tagged source**, specifically HTTP handlers in `frigate/api/app.py`, authentication in `frigate/api/auth.py`, event queries in `frigate/api/event.py`, review queries in `frigate/api/review.py`, recording queries in `frigate/api/record.py`, and statistics generation in `frigate/stats/util.py`. Do not substitute current development-branch parameter definitions for a released API guarantee.

Status classifies 0.18.2 and hexadecimal commit-suffixed builds as supported for this narrow contract, pre-0.18 releases as unsupported, and other versions as unknown. It may still return observations for unknown versions, but warns explicitly. No live NVR has been certified.

References:

- https://docs.frigate.video/integrations/api/frigate-http-api/
- https://docs.frigate.video/configuration/authentication/
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/app.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/auth.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/event.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/review.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/record.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/stats/util.py

## Important integration details

- pi-durable is not Pi CLI/coding-agent. Its inspected 1.4.0 API has no built-in MCP connector; Pi CLI's `mcp.json` does not configure this harness. The bridge is intentional.
- Keep Frigate registrations enabled in the conversation's callable tool set. `callers: ['tools']` prevents direct model exposure while allowing code-mode calls.
- The namespace is `frigate`, with prefix `mcp__frigate__`. Durable `describeNamespace(...).tools` returns **tool-name strings**, not objects.
- The MCP SDK requires an object-shaped top-level output schema. The schemas use an object plus runtime success/error refinement and advertised JSON Schema `oneOf`, rather than a top-level Zod union.
- The bridge compares advertised input/output schemas against its manifest, including the SDK's draft-7 conversion shape. **Adding tools requires deliberately updating the manifest and bridge**, not only registering tools in the server. Preserve strict read-only manifest checks and stable durable names.
- Durable output is different from model-facing text. Keep structured envelopes intact; do not turn all MCP errors into thrown strings or return upstream failures as empty successful data.
- A replay-safe read may be repeated if interrupted before its result is committed and can observe newer data. No exactly-once or cross-call snapshot guarantee is claimed.
- Host lifecycle: create the bridge again after restart; close the harness before closing the sandbox and bridge. Never persist clients, transport objects, or credentials.

## Next slice: issue #8

Implement the approved ticket end to end, retaining the same high-level test boundary. In particular:

1. Crash and reopen a durable harness after one nested result has committed and while a later request is in flight; confirm the committed call is not repeated and the interrupted safe call follows its replay policy.
2. Test credential expiry and expired artifacts across a restart, plus cancellation and clean transport shutdown.
3. Confirm the durable bridge is re-established after a host restart and that no client, transport, or credential is persisted in durable state.
4. Extend the fixtures and boundary tests as part of the slice; do not weaken the replay claims of the current documentation.

Do not broaden v1 into arbitrary HTTP, mutations, PTZ, Frigate Chat delegation, live streaming, monitoring/background jobs, or multi-instance federation. The user's actual agent application and deployment details have not been identified; do not modify neighboring repositories based on assumptions.

Use authenticated Frigate port 8971 or a trusted TLS reverse proxy. Port 5000 bypasses role enforcement. Never request the JWT signing secret or disable TLS verification; custom CA trust can be supplied through `FRIGATE_CA_CERT_FILE` or Node's startup environment.

## Ticket graph

| Issue | Delivery | Blocked by |
| --- | --- | --- |
| [#1](https://github.com/punissuer/frigate-mcp/issues/1) | First durable-to-Frigate status query; landed | None |
| [#2](https://github.com/punissuer/frigate-mcp/issues/2) | Authentication and camera discovery; landed | #1 |
| [#3](https://github.com/punissuer/frigate-mcp/issues/3) | Filter and inspect object events; landed | #2 |
| [#4](https://github.com/punissuer/frigate-mcp/issues/4) | Semantic event search; landed | #3 |
| [#5](https://github.com/punissuer/frigate-mcp/issues/5) | Reviews and recording availability; landed | #2 |
| [#6](https://github.com/punissuer/frigate-mcp/issues/6) | Frames and event images; landed | #3 |
| [#7](https://github.com/punissuer/frigate-mcp/issues/7) | Bounded evidence clips; landed | #3, #5 |
| [#8](https://github.com/punissuer/frigate-mcp/issues/8) | Restart and replay acceptance; landed | #6, #7 |
| [#9](https://github.com/punissuer/frigate-mcp/issues/9) | Secure Streamable HTTP and release acceptance; landed | #8 |
| [#4](https://github.com/punissuer/frigate-mcp/issues/4) | Semantic event search | #3 |
| [#5](https://github.com/punissuer/frigate-mcp/issues/5) | Reviews and recording availability | #2 |
| [#6](https://github.com/punissuer/frigate-mcp/issues/6) | Frames and event images | #3 |
| [#7](https://github.com/punissuer/frigate-mcp/issues/7) | Bounded evidence clips | #3, #5 |
| [#8](https://github.com/punissuer/frigate-mcp/issues/8) | Restart/replay acceptance | #6, #7 |
| [#9](https://github.com/punissuer/frigate-mcp/issues/9) | Secure Streamable HTTP and release acceptance | #8 |

## Suggested resumption checklist

- [x] Inspect and preserve the current uncommitted working tree.
- [x] Read the approved spec and current issue bodies.
- [x] Run typecheck, tests, and smoke to re-establish the baseline.
- [x] Land #1 with a commit and push.
- [x] Implement #2 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #3 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #4 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #5 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #6 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #7 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #8 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
- [x] Implement #9 as the final vertical slice: the Streamable HTTP transport, the shared suite over it, the examples, the opt-in live check, and the release documentation.
