# Frigate MCP implementation handoff

## Current state

The user approved the spec, test boundary, and nine-ticket implementation breakdown. All nine tickets were published to [punissuer/frigate-mcp](https://github.com/punissuer/frigate-mcp/issues) with `ready-for-agent` labels and native GitHub blocking relationships.

**Issues #1, #2, and #3 are implemented, committed, and pushed to `main`.** The working tree is clean. The next agreed step is **[#4: Semantic event search](https://github.com/punissuer/frigate-mcp/issues/4)**, which has not been started.

The user reported: “afaict it works.” This is positive feedback, not a recorded live-Frigate test result. No live NVR or provider credentials were used by the assistant.

## Read first

1. `README.md`: current usage, configuration, authentication, camera scope, limitations, compatibility, and durable integration.
2. `docs/spec.md`: approved overall design and dependency graph.
3. GitHub issue #4: its full acceptance criteria before implementing the next slice.
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

Five read-only tools are exposed:

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
| `src/http.ts` | Minimal HTTP(S) client: TLS verification, custom CA, no redirects, byte caps, cancellation, transport error kinds |
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
| `examples/smoke.ts` | Reproducible offline end-to-end demonstration |
| `.github/workflows/ci.yml` | Node 24 install, typecheck, tests, smoke, packaging, production audit |
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

- **51 tests passed** (22 from issue #1, 14 from issue #2, 15 from issue #3).
- Typecheck/build/smoke passed.
- Audit reported **zero vulnerabilities**.
- Package dry-run passed.
- Working-tree whitespace check passed.

Tests cover code-mode namespace/search discovery, model-visible versus callable tools, conventional MCP schemas/results, protected endpoint failures despite healthy public probes, version classification, malformed/wrong-MIME responses, chunked-response byte caps, stalled bodies, concurrency rejection, cancellation/recovery of capacity, incompatible manifests, subprocess shutdown, unsafe configuration, and rejected transport calls.

Issue #2 tests additionally cover successful discovery, expired external tokens, rejected credentials, revoked sessions, serialized refresh under concurrency, camera scope on discovery and statistics, role denial, malformed and oversized configuration, redirect rejection on `/config`, transient retry with `Retry-After`, cancellation of a configuration read, and custom-CA handling against a self-signed TLS fixture (skipped when `openssl` is unavailable).

Issue #3 tests additionally cover event filtering and translated query parameters, millisecond/reversed/oversized interval rejection, camera scope on filters and direct lookups, truncated pages with a continuation offset, duplicate identifier removal, equal timestamps, live-page shift warnings, short-page completeness, empty intervals, missing events, role denial, malformed and oversized event responses, and identifier path-traversal rejection.

These are fixture-driven checks, not live deployment certification. Full crash/reopen durability acceptance is reserved for #8.

## Runtime and release baseline

- Node.js **24 LTS, >=24.15.0 and <25**.
- MCP SDK **1.32.2**; Zod **4.6.7**.
- pi-durable, pi-ai, pi-codemode, and Chord **1.4.0**.
- TypeScript **5.9.3**; tsx **4.23.15**.

The Frigate fixture/status/discovery/event contract was checked against **v0.18.2 tagged source**, specifically HTTP handlers in `frigate/api/app.py`, authentication in `frigate/api/auth.py`, event queries in `frigate/api/event.py`, and statistics generation in `frigate/stats/util.py`. Do not substitute current development-branch parameter definitions for a released API guarantee.

Status classifies 0.18.2 and hexadecimal commit-suffixed builds as supported for this narrow contract, pre-0.18 releases as unsupported, and other versions as unknown. It may still return observations for unknown versions, but warns explicitly. No live NVR has been certified.

References:

- https://docs.frigate.video/integrations/api/frigate-http-api/
- https://docs.frigate.video/configuration/authentication/
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/app.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/auth.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/event.py
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

## Next slice: issue #4

Implement the approved ticket end to end, retaining the same high-level test boundary. In particular:

1. Add `search_events` over `GET /events/search` with a bounded natural-language query, and report an explicit unavailable/disabled outcome when the upstream feature is not enabled, rather than a misleading empty result.
2. Keep the same camera scope, UTC Unix-second interval, and completeness metadata rules as `list_events`.
3. Treat the upstream semantic-search endpoint as billable: capability detection must not call it, and a call must be explicit, bounded, and attributable.
4. Extend the bridge's known manifest/registrations, schemas, documentation, fixtures, and boundary tests as part of the slice.

Do not broaden v1 into arbitrary HTTP, mutations, PTZ, Frigate Chat delegation, live streaming, monitoring/background jobs, or multi-instance federation. The user's actual agent application and deployment details have not been identified; do not modify neighboring repositories based on assumptions.

Use authenticated Frigate port 8971 or a trusted TLS reverse proxy. Port 5000 bypasses role enforcement. Never request the JWT signing secret or disable TLS verification; custom CA trust can be supplied through `FRIGATE_CA_CERT_FILE` or Node's startup environment.

## Ticket graph

| Issue | Delivery | Blocked by |
| --- | --- | --- |
| [#1](https://github.com/punissuer/frigate-mcp/issues/1) | First durable-to-Frigate status query; landed | None |
| [#2](https://github.com/punissuer/frigate-mcp/issues/2) | Authentication and camera discovery; landed | #1 |
| [#3](https://github.com/punissuer/frigate-mcp/issues/3) | Filter and inspect object events; landed | #2 |
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
- [ ] Read GitHub issue #4 in full and implement it as the next vertical slice.
