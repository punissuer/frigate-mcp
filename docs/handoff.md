# Frigate MCP implementation handoff

## Current state

The user approved the spec, test boundary, and nine-ticket implementation breakdown. All nine tickets were published to [punissuer/frigate-mcp](https://github.com/punissuer/frigate-mcp/issues) with `ready-for-agent` labels and native GitHub blocking relationships.

**Issue #1 is implemented in the local working tree. Nothing from this work has been committed or pushed. All nine GitHub issues remain open.** Do not discard untracked files: they contain the implementation, tests, and planning documents.

The user reported: “afaict it works.” This is positive feedback, not a recorded live-Frigate test result. No live NVR or provider credentials were used by the assistant.

The next agreed step is **[#2: Secure authentication and camera discovery](https://github.com/punissuer/frigate-mcp/issues/2)**. It has not been started. Review/land #1 before treating its downstream tickets as unblocked.

## Read first

1. `README.md`: current usage, configuration, limitations, compatibility, and durable integration.
2. `docs/spec.md`: approved overall design and dependency graph.
3. GitHub issue #2: its full acceptance criteria before implementing the next slice.
4. `src/contract.ts`, `src/frigate.ts`, and `src/durable.ts`: the existing public contracts and integration boundary.

## What issue #1 delivers

A complete, executable path:

```text
Predetermined faux-provider tool call (no external LLM)
  → pi-durable codemode tool
  → QuickJS script and tool discovery
  → durable mcp__frigate__get_system_status nested tool
  → official MCP client over stdio
  → Frigate MCP server subprocess
  → controlled Frigate HTTP fixture
```

The sole MCP tool, `get_system_status({})`, reads `/`, `/version`, and `/stats` beneath an explicitly configured API root. Component reads are sequential and share a deadline. It returns:

- Independent health/version/statistics outcomes, preserving partial failures.
- `authorizedApiAccess`, which is confirmed only by a successful valid protected statistics read. Public health/version success cannot conceal a 401/403.
- Allowlisted camera FPS/detection fields, detector inference speed, service uptime/update time; never raw stats/configuration or command lines.
- A bounded, schema-validated success/error envelope, mirrored as JSON text for conventional MCP clients.
- Stable error categories, observation time, and compatibility warnings.

The server rejects redirects, bounds streamed response bytes and concurrent calls, supports cancellation, and sanitizes startup and upstream errors. TLS verification stays enabled. Existing bearer-token support is **static token forwarding**, not the completed authentication/session feature from #2.

The optional durable bridge validates the exact known read-only MCP manifest, registers stable names with `callers: ['tools']` and `replay: 'safe'`, and preserves MCP `content`, `structuredContent`, and `isError`. Schema-valid tool errors resolve inside code mode; transport/harness failures can reject. The ordinary server entry point does not import durable.

## File map

| Location | Purpose |
| --- | --- |
| `src/config.ts` | Operator options/env parsing; exact API-root handling; HTTP opt-in; token and policy validation |
| `src/contract.ts` | Zod inputs/outputs, sanitization schemas, release classification, expected MCP manifest |
| `src/frigate.ts` | Bounded upstream reads, status aggregation, sanitized errors, global concurrency admission |
| `src/server.ts` | Separately importable MCP server and read-only tool registration |
| `src/cli.ts` | Executable stdio startup, sanitized diagnostics, shutdown handling |
| `src/durable.ts` | Optional stdio client bridge, manifest validation, durable tool registration, namespace metadata |
| `test/helpers/fixture.ts` | Controlled HTTP fixture modeled on the tagged release; request recording and unsafe sentinel fields |
| `test/helpers/durable.ts` | Deterministic faux-provider/harness/QuickJS runner and real stdio transport |
| `test/helpers/incompatible-server.ts` | Real stdio MCP server with an intentionally rejected manifest |
| `test/status.test.ts` | Discovery/status/result/error/limit/transport boundary tests |
| `test/lifecycle.test.ts` | Manifest rejection, cancellation, startup redaction, configuration safety |
| `examples/smoke.ts` | Reproducible offline end-to-end demonstration |
| `.github/workflows/ci.yml` | Node 24 install, typecheck, tests, smoke, packaging, production audit |
| `package.json`, `package-lock.json` | Pinned dependencies, optional durable peers, separate exports, build/test commands |
| `tsconfig.json`, `tsconfig.build.json` | Strict NodeNext TypeScript configuration and declaration build |
| `.gitignore` | Existing template plus Node dependencies, secrets, and local SQLite state exclusions |

`dist/` and `node_modules/` are generated/ignored. Build output is required before launching `dist/cli.js`. Do not commit generated dependencies, secrets, or local durable databases.

## Verification already performed

Last full verification, before this handoff document was added:

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

- **22 tests passed.**
- Typecheck/build/smoke passed.
- Audit reported **zero vulnerabilities**, including development dependencies at that time.
- Package dry-run passed.
- A real package tarball was installed in a temporary clean consumer directory with optional dependencies omitted. The server imported and instantiated successfully with **pi-durable absent**.
- Working-tree whitespace check passed. GitHub Actions has not been observed running because the code has not been pushed.

Tests cover code-mode namespace/search discovery, model-visible versus callable tools, conventional MCP schemas/results, protected endpoint failures despite healthy public probes, version classification, malformed/wrong-MIME responses, chunked-response byte caps, stalled bodies, concurrency rejection, cancellation/recovery of capacity, incompatible manifests, subprocess shutdown, unsafe configuration, and rejected transport calls.

These are fixture-driven checks, not live deployment certification. Full crash/reopen durability acceptance is reserved for #8.

## Runtime and release baseline

- Node.js **24 LTS, >=24.15.0 and <25**.
- MCP SDK **1.32.2**; Zod **4.6.7**.
- pi-durable, pi-ai, pi-codemode, and Chord **1.4.0**.
- TypeScript **5.9.3**; tsx **4.23.15**.

The Frigate fixture/status contract was checked against **v0.18.2 tagged source**, specifically HTTP handlers in `frigate/api/app.py` and statistics generation in `frigate/stats/util.py`. Do not substitute current development-branch parameter definitions for a released API guarantee.

Status classifies 0.18.2 and hexadecimal commit-suffixed builds as supported for this narrow contract, pre-0.18 releases as unsupported, and other versions as unknown. It may still return observations for unknown versions, but warns explicitly. No live NVR has been certified.

References:

- https://docs.frigate.video/integrations/api/frigate-http-api/
- https://docs.frigate.video/configuration/authentication/
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/app.py
- https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/stats/util.py

## Important integration details

- pi-durable is not Pi CLI/coding-agent. Its inspected 1.4.0 API has no built-in MCP connector; Pi CLI's `mcp.json` does not configure this harness. The bridge is intentional.
- Keep Frigate registrations enabled in the conversation's callable tool set. `callers: ['tools']` prevents direct model exposure while allowing code-mode calls.
- The namespace is `frigate`, with prefix `mcp__frigate__`. Durable `describeNamespace(...).tools` returns **tool-name strings**, not objects.
- The MCP SDK requires an object-shaped top-level output schema. The status schema uses an object plus runtime success/error refinement and advertised JSON Schema `oneOf`, rather than a top-level Zod union.
- The bridge compares advertised input/output schemas against its manifest, including the SDK's draft-7 conversion shape. **Adding tools in #2 requires deliberately updating the manifest and bridge**, not only registering tools in the server. Preserve strict read-only manifest checks and stable durable names.
- Durable output is different from model-facing text. Keep structured envelopes intact; do not turn all MCP errors into thrown strings or return upstream failures as empty successful data.
- A replay-safe read may be repeated if interrupted before its result is committed and can observe newer data. No exactly-once or cross-call snapshot guarantee is claimed.
- Host lifecycle: create the bridge again after restart; close the harness before closing the sandbox and bridge. Never persist clients, transport objects, or credentials.

## Next slice: issue #2

Implement the approved ticket end to end, retaining the same high-level test boundary. In particular:

1. Add username/password login and session refresh/re-login using the selected release's authentication-cookie contract. Keep externally supplied JWT mode; do not assume an expired external token can refresh itself.
2. Serialize concurrent refreshes and permit at most one authentication retry per read. Avoid bad-credential loops.
3. Add `list_cameras` and `get_capabilities` using strictly allowlisted configuration fields; no raw config, RTSP URLs, provider keys, or paths.
4. Add operator camera restrictions and enforce them on discovery **and existing status statistics**. Omit or decline aggregates that cannot be safely scoped.
5. Extend safe retry behavior for transient reads within the overall deadline, including bounded Retry-After handling and cancellation.
6. Update the bridge's known manifest/registrations, schemas, documentation, fixtures, and boundary tests as part of the slice.

Current configuration has only `FRIGATE_API_ROOT`, `FRIGATE_BEARER_TOKEN`, explicit HTTP opt-in, and response/deadline/concurrency limits. There is no camera allowlist or managed login yet. Until #2 lands, upstream account permissions must be appropriate for all status data the server can return.

Use authenticated Frigate port 8971 or a trusted TLS reverse proxy. Port 5000 bypasses role enforcement. Never request the JWT signing secret or disable TLS verification; custom CA trust can be supplied through Node's startup environment.

## Ticket graph

All issues remain open; use native blockers as well as the textual references:

| Issue | Delivery | Blocked by |
| --- | --- | --- |
| [#1](https://github.com/punissuer/frigate-mcp/issues/1) | First durable-to-Frigate status query; implemented locally | None |
| [#2](https://github.com/punissuer/frigate-mcp/issues/2) | Authentication and camera discovery | #1 |
| [#3](https://github.com/punissuer/frigate-mcp/issues/3) | Filter and inspect object events | #2 |
| [#4](https://github.com/punissuer/frigate-mcp/issues/4) | Semantic event search | #3 |
| [#5](https://github.com/punissuer/frigate-mcp/issues/5) | Reviews and recording availability | #2 |
| [#6](https://github.com/punissuer/frigate-mcp/issues/6) | Frames and event images | #3 |
| [#7](https://github.com/punissuer/frigate-mcp/issues/7) | Bounded evidence clips | #3, #5 |
| [#8](https://github.com/punissuer/frigate-mcp/issues/8) | Restart/replay acceptance | #6, #7 |
| [#9](https://github.com/punissuer/frigate-mcp/issues/9) | Secure Streamable HTTP and release acceptance | #8 |

Do not broaden v1 into arbitrary HTTP, mutations, PTZ, Frigate Chat delegation, live streaming, monitoring/background jobs, or multi-instance federation. The user's actual agent application and deployment details have not been identified; do not modify neighboring repositories based on assumptions.

## Suggested resumption checklist

- [ ] Inspect and preserve the current uncommitted working tree.
- [ ] Read the approved spec and current issue #2 body.
- [ ] Run typecheck, tests, and smoke to re-establish the baseline.
- [ ] Review/land #1 with an appropriate commit/push workflow; do not claim it is already merged or closed.
- [ ] Implement #2 as the next vertical slice, extending the real code-mode/stdio/HTTP-fixture tests.
