# Frigate MCP server for pi-durable code mode

Status: Spec, test boundary, and nine-ticket breakdown approved by the user. Implementation tickets published to GitHub with the `ready-for-agent` label and native blocking relationships. No implementation is included.

## Problem Statement

The user wants their pi-durable agent to investigate activity captured by Frigate through code mode: discover cameras, find relevant detections and review items, inspect evidence, and report operational problems. Calling Frigate directly from model-generated code would require network access and credentials in the sandbox, repeat API integration work, and complicate durable recovery.

This repository currently contains only a README, license, and ignore rules. There is no implementation, testing convention, domain glossary, or ADR to preserve.

## Solution

Build a standards-compatible Frigate MCP server with a small, typed, read-only investigation surface. Provide a companion pi-durable extension that connects to the server and registers its tools for calls from code mode, without declaring every tool directly to the model.

The model writes JavaScript to compose independent calls, filter event records, compare cameras, and output only relevant evidence. Frigate credentials and HTTP access remain outside the QuickJS sandbox. Durable nested calls preserve completed observations across restart; interrupted read calls may safely run again, but can observe newer data.

First release supports both local stdio and authenticated Streamable HTTP deployment. It does not expose arbitrary HTTP requests, destructive operations, configuration editing, or camera controls. Deliver a working durable integration example as part of the feature, not merely standalone MCP tooling.

## User Stories

1. As an agent operator, I want to connect one Frigate instance, so that my agent can investigate my NVR without custom HTTP scripts.
2. As an operator, I want local stdio deployment, so that a locally hosted agent needs no additional listening service.
3. As an operator, I want authenticated remote MCP deployment, so that an agent outside the NVR host can use the same tools.
4. As an operator, I want credentials supplied through deployment secrets, so that passwords and tokens never enter prompts or tool arguments.
5. As an operator, I want verified TLS and custom CA support, so that a private Frigate deployment can be accessed securely.
6. As an operator, I want a camera allowlist, so that the agent cannot inspect cameras outside its intended scope.
7. As an operator, I want a read-only tool surface, so that an investigation cannot delete footage or alter surveillance settings.
8. As an agent, I want to discover tool schemas through code mode, so that I do not need every tool in the model's initial context.
9. As an agent, I want to list cameras, zones, and tracked labels, so that subsequent filters use valid identifiers.
10. As an agent, I want to check Frigate's version and health, so that I can distinguish missing capabilities from outages.
11. As an agent, I want summarized camera and detector statistics, so that I can identify stale or failing cameras.
12. As a user, I want to ask what happened within a time window, so that I can investigate without browsing every camera manually.
13. As an agent, I want to filter events by camera, label, zone, sub-label, and media availability, so that I can narrow an investigation.
14. As an agent, I want explicit paging and truncation information, so that I do not confuse partial results with complete coverage.
15. As an agent, I want to retrieve an event by ID, so that I can cite its times, classification, and available evidence.
16. As a user, I want semantic event search when supported, so that I can describe an object or activity in ordinary language.
17. As an agent, I want a clear unavailable-capability result, so that I can fall back to ordinary filters when semantic search is disabled.
18. As an agent, I want to distinguish review items from object events, so that I do not mistake one review segment for one detection.
19. As an agent, I want to filter review items by severity and reviewed state, so that I can prioritize unreviewed alerts without modifying them.
20. As an agent, I want recording availability for a camera and interval, so that I can explain gaps in evidence.
21. As an agent, I want a current frame, so that I can inspect the latest available camera image without starting a stream.
22. As an agent, I want event snapshots and thumbnails, so that I can inspect evidence before requesting larger media.
23. As a user, I want bounded clips for events and recording intervals, so that I can review the relevant footage.
24. As an agent, I want media timestamps and freshness caveats, so that a fallback or stale frame is not described as live certainty.
25. As an agent, I want structured JSON and explicit error codes, so that code mode can aggregate results without parsing prose.
26. As an agent, I want independent reads to run concurrently within bounds, so that cross-camera investigations remain responsive.
27. As an operator, I want requests and media downloads bounded, so that model-generated loops cannot exhaust the NVR or host.
28. As an operator, I want interrupted investigations to resume, so that restarting the durable agent does not discard completed tool observations.
29. As an operator, I want cancellation to reach the upstream HTTP request, so that abandoned work stops consuming resources.
30. As an operator, I want logs without credentials or surveillance payloads, so that operational troubleshooting does not create another sensitive archive.
31. As a user, I want incomplete results and unavailable footage clearly identified, so that the agent never presents missing evidence as proof that nothing happened.
32. As a maintainer, I want a documented compatibility baseline and opt-in live checks, so that Frigate API changes can be detected before deployment.

## Implementation Decisions

### Architecture and delivery

- Use TypeScript on a supported Node.js LTS runtime and the official MCP SDK. Pin compatible dependencies and document the supported runtime rather than relying on a globally installed Pi CLI.
- Separate Frigate HTTP access and policy enforcement, MCP tool contracts/transports, and the optional pi-durable client extension. The server must work with ordinary MCP clients and must not depend on durable internals.
- One configured Frigate instance per server process in v1. Base URL, credentials, TLS trust, camera scope, concurrency, response limits, and media policy are operator configuration, not model inputs.
- Offer stdio with protocol-only stdout and stderr diagnostics. Offer Streamable HTTP at an explicit MCP endpoint; legacy SSE is not required.
- Remote mode requires a high-entropy bearer credential distinct from the upstream Frigate credential, constant-time checking, Origin validation when applicable, bounded sessions, and authenticated requests including resource reads. Bind loopback by default; require an explicit non-loopback configuration and TLS at the service or trusted ingress. Never recommend publishing Frigate's internal port.
- Publish server and durable integration as separately importable surfaces. Include transport configuration, secret handling, startup/shutdown, and a durable example with persistent storage and no real LLM requirement for its automated smoke test.

### Frigate authentication and compatibility

- Configure an explicit API-root URL, normally ending in `/api`; join documented relative routes without losing reverse-proxy path prefixes or doubling `/api`.
- Prefer the authenticated Frigate interface on port 8971 with a least-privilege viewer or camera-scoped account. Port 5000 bypasses authentication and role enforcement; allow it only through an explicit trusted-network mode.
- Support an externally supplied bearer JWT and username/password login. The latter uses `/login`, reads the configured authentication cookie from Set-Cookie, and manages session refresh/re-login outside tools. Serialize refreshes, allow at most one authentication retry per read, and never loop on bad credentials. An expired external token produces an actionable authentication error instead of assuming it can be refreshed without credentials.
- Do not request or use Frigate's JWT signing secret. Never disable TLS verification by default; support operator-supplied CA certificates.
- Record the tested Frigate release and its API contract before implementation acceptance. The current documentation is moving; do not claim compatibility with every release or equate development-branch parameter definitions with released support.
- Retrieve version and sanitized capabilities at connection time or on demand. Treat protected endpoint access separately from public health/version success. Optional capability uncertainty must be reported as unknown, not supported.
- Do not perform expensive searches or download footage during capability detection. Configuration inspection returns only allowlisted camera names, zones, labels, and capability flags; never raw configuration, RTSP URLs, passwords, provider keys, or filesystem locations.

### Proposed v1 tool inventory

Routes below are relative to the configured API root. Tool arguments receive their own bounded JSON Schemas; no raw-path, arbitrary-query, arbitrary-header, or arbitrary-URL escape hatch is exposed.

| Tool | Frigate API basis | Contract |
| --- | --- | --- |
| `get_system_status` | `GET /`, `/version`, `/stats` | Health, version, sanitized operational stats, and per-component errors. A successful public health probe does not prove authentication works. |
| `get_capabilities` | Version and allowlisted fields from `GET /config` | Known/unknown capability flags and configured policy bounds. |
| `list_cameras` | Allowlisted fields from `GET /config` | Permitted camera IDs, zones, labels, and safe status fields. |
| `list_events` | `GET /events` | Bounded object-event search with typed filters and supported pagination. |
| `get_event` | `GET /events/{event_id}` | One permitted event, including evidence availability. |
| `search_events` | `GET /events/search` | Optional semantic search with bounded results and explicit unsupported/disabled outcomes. |
| `list_review_items` | `GET /review` | Review segments with event references, severity, and reviewed-state filtering; never mark viewed. |
| `get_review_item` | `GET /review/{review_id}` | One review segment and its permitted evidence references. |
| `get_recording_summary` | `GET /{camera}/recordings/summary` | Documented hourly availability summary, with its actual upstream scope. |
| `list_recordings` | `GET /{camera}/recordings` | Recording intervals within a required bounded time range. |
| `get_latest_frame` | `GET /{camera}/latest.jpg` | Bounded image with observation time and source/freshness caveat. |
| `get_event_image` | `GET /events/{event_id}/snapshot.jpg` or `/thumbnail.jpg` | Explicit snapshot/thumbnail selection, availability checks, bounded image. |
| `get_event_clip` | `GET /events/{event_id}/clip.mp4` | Bounded media retrieval yielding an opaque artifact reference, not inline video. |
| `get_recording_clip` | `GET /{camera}/start/{start}/end/{end}/clip.mp4` | Same artifact contract with bounded duration and byte count. |

- Keep tool names stable and descriptions rich in Frigate terms: object event, review item, alert, detection, recording, snapshot, zone, label. State read-only behavior, units, limits, and optional-feature requirements in descriptions.
- Do not wrap Frigate's Chat API: conversation and reasoning belong to pi-durable/code mode, not a second agent behind the MCP server.
- Omit storage-usage and raw logs from v1; the documented storage endpoint requires admin privileges. Basic health and permitted statistics must work without requiring an administrator account.
- Do not offer an arbitrary-time event-summary contract over `/events/summary`: its inspected parameter definition does not establish arbitrary time-window filtering. Code mode may aggregate retrieved events but must retain partial-result metadata and never claim a sampled count is a total.

### Inputs, results, and evidence

- Use UTC Unix seconds for time inputs and upstream mapping, preserving fractional seconds. Provide human-readable UTC timestamps alongside key evidence times. Require explicit start/end for historical footage; reject reversed ranges and millisecond-looking values with a helpful units error. Do not silently guess a timezone or what “last night” means.
- Accept arrays for camera/label/zone filters and translate into the deployed API's documented query representation. Validate finite numbers, score ranges, identifiers, enum values, and supported combinations. URL-encode route segments and reject path traversal.
- Suggested initial operator-tunable bounds: list page default 50/max 200, historical interval max 24 hours, clip duration max 120 seconds, clip bytes max 50 MiB, image bytes max 5 MiB, upstream JSON max 5 MiB, total tool result max 256 KiB, four concurrent upstream requests, 15-second metadata deadline and 60-second media deadline. These are proposed server policy, not Frigate API limits. Enforce while streaming, not after fully buffering an oversized response.
- Give each tool an MCP output schema with a discriminated success/error envelope. Successful results include data and relevant metadata such as observation time, effective scope/window, warnings, and completeness. Errors include stable code, sanitized message, retryability, and safe status/context; set MCP `isError` too. Mirror structured content as JSON text for conventional clients without duplicating large media.
- Distinguish authentication, forbidden scope, not found/expired media, disabled feature, unsupported version, invalid arguments, rate limit, timeout, cancellation, unreachable upstream, malformed response, and payload-too-large. An error is never an empty successful list.
- Paginate only where supported by the pinned upstream contract. Do not invent cursors for endpoints without stable paging. Return supported offset/continuation information, ordering, and possible truncation; explain that changing live datasets can shift pages. Fix an upper time bound for multi-page historical reads where possible, and deduplicate by event ID. Test equal timestamps at page boundaries.
- If an endpoint cannot demonstrate completeness within server limits, return an explicit incomplete result or bounded-result error, never a fabricated exact total. Avoid silently truncating serialized JSON.
- Image tools return bounded MCP image blocks plus small structured metadata. The bridge must preserve image blocks so code mode can forward them with `image()`; do not print base64 with `text()` or put it in small-value code-mode stores.
- A latest frame can fall back to a preview when a camera is offline. Expose known freshness information; where source capture time is unavailable, label it unknown and distinguish retrieval time from capture time.
- Clips are downloaded through the authenticated upstream client to a configured private artifact store, streamed to temporary files then atomically published. Enforce duration, bytes, timeout, storage quota, and expiry; clean abandoned downloads. Return opaque IDs, MIME type, byte count, creation/expiry times, and evidence references, never upstream cookies or credential-bearing URLs.
- Serve artifacts as authenticated MCP resources with opaque URIs. Document how the host retrieves bytes for user delivery; do not assume the model can play MP4 or that the MCP server's local path exists on the agent host. Clip expiry is independent of durable transcript retention, and expired references must fail clearly.

### Scope and security enforcement

- Treat all Frigate strings, descriptions, OCR, license plates, and upstream error text as untrusted data, never instructions.
- Enforce the camera allowlist on lists, direct-ID lookups, media, statistics, and resources. Reject explicitly forbidden filters rather than silently broadening them. Resolve an event/review ID to its permitted camera before returning evidence; avoid leaking forbidden-camera metadata in errors.
- Push allowed cameras upstream where supported and validate results again. For aggregate endpoints that cannot be safely scoped, omit them or return unsupported under a restricted camera policy rather than leaking counts or names.
- Restrict outbound requests to the configured origin and path prefix. Reject cross-origin redirects and credential forwarding. Resource reads accept only server-issued artifact IDs, not paths or URLs.
- MCP annotations describe read-only and non-destructive upstream behavior; they are hints, not authorization. Downloading evidence still consumes resources and produces sensitive local artifacts, which must be documented and bounded.
- Retry only safe reads on transient network errors/408/429/5xx, at most twice within the overall deadline, with jitter and bounded Retry-After handling. Never retry 403/404/validation failures. Cancellation and client disconnection stop retries and streaming downloads.
- Logs include tool name, request ID, duration, status category, and byte counts. Exclude credentials, raw request bodies, surveillance images, event descriptions, and full upstream response text. Protect artifact directories and document retention.

### pi-durable bridge and recovery

- Target the inspected pi-durable 1.4.0 API initially and pin a tested compatible range. The installed 1.0.3 copy elsewhere is not evidence that it has the same code-mode APIs.
- Unlike Pi CLI/coding-agent, the inspected durable package has no exported MCP connector. Build a thin MCP client adapter using the official SDK rather than claiming that `mcp.json` or coding-agent `createMcpExtension()` automatically works inside durable.
- Connect over stdio or Streamable HTTP, initialize MCP, list tools, validate their schemas against an expected read-only manifest, then register durable tools with stable names `mcp__frigate__<tool>`. Re-establish the client on host restart and close it on shutdown. Never persist client instances, transport handles, or credentials in harness storage.
- Register through `defineTool`/`defineExtension` with `callers: ["tools"]`; install `createCodemodeExtension` with a Frigate namespace prefix and description. Offer code mode to the model while keeping the Frigate registrations enabled in the conversation's callable tool set. Do not confuse durable `callers`/`modelTools` with Pi CLI's `exposure` setting.
- The bridge's structured output schema preserves the MCP `CallToolResult` envelope, including `structuredContent`, `content`, and `isError`. Scripts read `result.structuredContent`, inspect failure status, and forward selected `content` image blocks. Map MCP errors to durable `isError` while retaining the schema-valid envelope; transport or harness-level errors can still reject, so examples must handle both.
- Register only the known read-only tools as `replay: "safe"`. Durable code mode journals delivered nested-call results and reattaches on resume; already committed results must not trigger another MCP request. A call interrupted before commit can issue the read again and observe a different live frame or newer metadata. This is not exactly-once external execution or a snapshot transaction.
- A replayed clip download may leave an additional artifact if a crash occurs after publication but before result commit. Accept bounded duplicates in v1, clean them by quota/TTL, and do not claim exactly-once artifact creation. Durable results retain metadata, not guaranteed perpetual access to external media.
- Preserve deterministic registration names and compatible schemas across restarts. Fail explicitly when the configured server no longer offers required tools; do not silently bind an old name to a different operation. Changes to the callable manifest during an active script require a documented compatibility/restart policy.
- Include examples of discovery, filtered cross-camera reads with bounded concurrency, error handling, snapshot forwarding, artifact retrieval, and restart with persistent durable storage. No sandbox filesystem/network access is required.

### Delivery order

1. Freeze a supported Frigate contract, runtime/dependency versions, schemas, security policy, and the public integration fixture.
2. Deliver stdio investigation tools for discovery, status, events, reviews, and recordings with scoped auth and bounded JSON results.
3. Add images, bounded clips, artifact resources, quotas, and cleanup.
4. Deliver the durable bridge and deterministic code-mode smoke/recovery examples; remote transport must use the same contracts and policy checks.
5. Complete Streamable HTTP hardening, packaging, operator documentation, and opt-in live compatibility checks. Do not call the release complete until the durable end-to-end acceptance tests pass.

## Testing Decisions

- Approved primary seam: invoke a real code-mode script in a pi-durable harness, through the actual MCP client/transport and server, against a controlled HTTP Frigate fixture. Assert externally visible results and observed requests, not private methods or module structure.
- Run the same behavioral suite against stdio and Streamable HTTP, with a deterministic script and no model-provider dependency. Use one fixture to control upstream auth, route behavior, timestamps, pagination, media, failures, and request counts.
- Cover a complete investigation: discover permitted cameras, list events in a fixed interval, retrieve one event and image, inspect review/recording availability, download a bounded clip, then return a compact summary with evidence IDs and explicit completeness.
- Validate tool discovery, input/output schemas, namespace descriptions, code-mode-only caller restrictions, image forwarding, resource retrieval, and preservation of structured MCP errors through the durable bridge.
- Crash/reopen durable storage after one nested result commits and while a later request is in flight. Confirm the committed call is not repeated, the interrupted safe call follows its replay policy, and the resumed script completes. Test credential expiry and expired artifacts after restart. Also test cancellation and clean transport shutdown.
- Cover allowed/forbidden cameras via filters and direct IDs, unscopable aggregates, sanitized config/stats, prompt-like descriptions, credential redaction, path traversal, redirects, bearer authentication, and unauthenticated remote-resource access.
- Cover empty results versus errors, disabled semantic search, unknown capabilities, token refresh contention, auth failures, role denial, missing media, 429/Retry-After, transient 5xx, malformed JSON, wrong MIME types, stream size limits, quota exhaustion, and incomplete downloads.
- Cover Unix-second precision, invalid millisecond inputs, timezone/daylight-saving examples, identical event timestamps, live pagination changes, unavailable upstream paging, and explicit incomplete-result reporting.
- Use a fake clock and fault-controlled fixture for retry/deadline/TTL tests. Add narrow pure-function tests only where boundary tests cannot isolate important input normalization behavior economically.
- No testing prior art exists in this repository. Use the durable documented nested-call/recovery contract as the integration baseline, not assumptions from Pi CLI behavior.
- Keep live-Frigate tests opt-in with environment-supplied credentials and a documented supported release. Default tests must never contact a real NVR, modify configuration, or delete footage.

## Out of Scope

- Full one-to-one wrapping of every Frigate HTTP endpoint.
- Deletion, retention changes, marking reviews viewed, manual event creation, annotations, uploads, configuration writes, service restarts, PTZ, and notification management.
- Face enrollment/recognition management, dedicated plate search tooling, classification model training, Frigate+ submission, chat delegation, and motion-search jobs.
- Live MJPEG/RTSP/WebRTC streaming or a video player inside code mode.
- Always-on MQTT subscriptions, automatic incident monitoring, scheduled polling, or new durable background task systems.
- Cross-instance federation, multi-tenant authorization, MCP OAuth authorization-server implementation, or direct public access to the NVR.
- A replacement for Frigate's event database, exact cross-page historical snapshots, permanent evidence archiving, or exactly-once upstream execution.
- Changes to the user's existing agent application before its actual integration target is identified.

## Further Notes

### Evidence and limitations

- User-provided API index: https://docs.frigate.video/integrations/api/frigate-http-api/
- Authentication, ports, roles, login, and token lifecycle: https://docs.frigate.video/configuration/authentication/
- Key endpoint references: [events](https://docs.frigate.video/integrations/api/events-events-get), [semantic search](https://docs.frigate.video/integrations/api/events-search-events-search-get), [reviews](https://docs.frigate.video/integrations/api/review-review-get), [latest frame](https://docs.frigate.video/integrations/api/latest-frame-camera-name-latest-extension-get), [event snapshot](https://docs.frigate.video/integrations/api/event-snapshot-events-event-id-snapshot-jpg-get), [event clip](https://docs.frigate.video/integrations/api/event-clip-events-event-id-clip-mp-4-get), [recordings](https://docs.frigate.video/integrations/api/recordings-camera-name-recordings-get), and [recording summary](https://docs.frigate.video/integrations/api/recordings-summary-camera-name-recordings-summary-get).
- The API site's server-rendered pages expose routes and access notes but leave many parameter/schema panels to client rendering. Parameter details were cross-checked against Frigate's development-branch event/review query definitions; these are provisional until matched to the selected supported release. The documentation site may be ahead of the user's deployed instance.
- Reviewed the installed pi-durable 1.4.0 README and type declarations, including durable nested calls, code mode, callers, structured output, replay, and storage recovery. Reviewed Pi coding-agent MCP/code-mode documentation to distinguish CLI configuration from durable integration.
- The user's actual Frigate version, deployment location, authentication mode, agent application, desired mutation scope, and media delivery UI were not supplied. The spec deliberately proposes safe defaults rather than treating these as established facts.

### Approved implementation tickets

The user confirmed the test boundary, selected GitHub publication, and approved the following breakdown and creation of the `ready-for-agent` label. Each published issue includes acceptance criteria and shared contracts; dependencies are also configured as native GitHub blocking relationships. The spec itself was not published as a separate parent issue.

| Issue | Delivery | Blocked by |
| --- | --- | --- |
| [#1](https://github.com/punissuer/frigate-mcp/issues/1) | First durable-to-Frigate status query | None |
| [#2](https://github.com/punissuer/frigate-mcp/issues/2) | Secure authentication and camera discovery | #1 |
| [#3](https://github.com/punissuer/frigate-mcp/issues/3) | Filter and inspect object events | #2 |
| [#4](https://github.com/punissuer/frigate-mcp/issues/4) | Search events semantically | #3 |
| [#5](https://github.com/punissuer/frigate-mcp/issues/5) | Investigate reviews and recording availability | #2 |
| [#6](https://github.com/punissuer/frigate-mcp/issues/6) | Inspect camera frames and event images | #3 |
| [#7](https://github.com/punissuer/frigate-mcp/issues/7) | Retrieve bounded evidence clips | #3, #5 |
| [#8](https://github.com/punissuer/frigate-mcp/issues/8) | Resume investigations safely after restart | #6, #7 |
| [#9](https://github.com/punissuer/frigate-mcp/issues/9) | Deploy securely over Streamable HTTP | #8 |

Initial work frontier: #1. Work later tickets only when their blockers are complete.
