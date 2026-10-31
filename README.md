# frigate-mcp

Read-only Frigate MCP tools with an optional **pi-durable code-mode bridge**.

Implemented: [issue #1](https://github.com/punissuer/frigate-mcp/issues/1), the stdio `get_system_status` vertical slice. Camera discovery, login/session refresh, camera allowlists, event investigation, media, restart acceptance tests, and remote Streamable HTTP are tracked in [issues #2–#9](https://github.com/punissuer/frigate-mcp/issues). **This is not the complete v1 server.**

## Develop and verify

Use **Node.js 24 LTS, version 24.15.0 or newer within 24.x**.

```sh
npm ci
npm run typecheck
npm test
npm run smoke
```

The smoke command starts a controlled HTTP fixture and runs real QuickJS code mode inside a pi-durable harness. A scripted faux provider supplies the predetermined tool call; it does not contact an LLM. The script discovers the Frigate namespace and calls through the durable bridge → stdio MCP server → fixture HTTP API. Only the selected structured result reaches the simulated model. Tests also exercise ordinary MCP clients, auth failures, schema validation, cancellation, limits, and transport failures.

No NVR or provider credentials are required. Tests never contact a real Frigate instance or modify footage. `npm run build` produces the executable and declarations; `npm pack --dry-run` checks the distributable.

## Local stdio server

Configure an **exact API root**, including `/api` and any reverse-proxy path prefix. A trailing slash is optional. The server will not append another `/api`.

```sh
export FRIGATE_API_ROOT=https://frigate.example.internal/api
export FRIGATE_BEARER_TOKEN='<JWT supplied by your secret manager>'
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
        "FRIGATE_BEARER_TOKEN": "${FRIGATE_BEARER_TOKEN}"
      }
    }
  }
}
```

Environment substitution in this JSON is client-specific. It is **not** a configuration loader supplied by pi-durable. Do not commit credentials or place them in tool arguments.

| Environment variable | Default / meaning |
| --- | --- |
| `FRIGATE_API_ROOT` | Required absolute HTTP(S) API root, without URL credentials, query, or fragment |
| `FRIGATE_BEARER_TOKEN` | Optional externally supplied bearer JWT; no automatic refresh yet |
| `FRIGATE_ALLOW_INSECURE_HTTP` | `false`; must explicitly be `true` for a trusted HTTP network or local fixture |
| `FRIGATE_TIMEOUT_MS` | `15000`, one deadline for all status components; range 1–60000 |
| `FRIGATE_MAX_RESPONSE_BYTES` | `5242880`, per upstream response, enforced while streaming; may only be lowered |
| `FRIGATE_MAX_CONCURRENT` | `4`, concurrent status calls/upstream reads, range 1–32; excess calls return `busy` instead of growing a queue |

Prefer authenticated Frigate port **8971**, directly or through a trusted TLS reverse proxy, and a least-privilege viewer account. Port **5000 bypasses Frigate role enforcement**; use it only on a trusted private network, with explicit HTTP opt-in if applicable. TLS verification stays enabled. Node's `NODE_EXTRA_CA_CERTS` can supply a private CA at process startup. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

In this slice, a 401/403 is returned to the caller; there is no username/password login, refresh, or automatic retry. Never supply Frigate's JWT signing secret. The MCP server does not listen on an HTTP port yet.

## Status contract

`get_system_status({})` makes only `GET /`, `/version`, and `/stats` beneath the configured API root. Unknown input properties are rejected. It returns:

- `structuredContent.ok`, `data`, and `meta`; failures also include a stable `error` and MCP `isError: true`.
- Independent health, version, and statistics component outcomes, including partial results.
- `authorizedApiAccess`: `confirmed` only after a successful, valid protected `/stats` read; `denied` for 401/403; otherwise `unknown`.
- Sanitized camera FPS/detection fields, detector inference speeds, service uptime and update time. No raw statistics, process command lines, RTSP URLs, storage paths, or configuration.
- Observation time, contract release, and compatibility warnings. Retrieval time is not a camera frame timestamp.

Small structured results are mirrored as JSON text in `content` for ordinary clients. Output schemas bound camera/detector entries and identifier lengths; oversized or malformed upstream data fails rather than being silently truncated. Redirects are rejected, and upstream error bodies are never echoed. All endpoints share one deadline; component reads are sequential, avoiding a fan-out beyond the configured concurrency bound.

The current server does **not** implement its own camera allowlist. Only deploy it with upstream account permissions that are appropriate for all observations it can return; additional camera policy is issue #2. Treat all camera/detector names as data, not instructions.

### Compatibility baseline

The fixture contract was checked against **Frigate v0.18.2** tagged source:

- [HTTP handlers: plain-text health/version and authenticated statistics](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/api/app.py)
- [Statistics shape](https://github.com/blakeblackshear/frigate/blob/v0.18.2/frigate/stats/util.py)

`0.18.2` and its hexadecimal commit-suffixed builds are classified `supported` **for this status contract only**. Older pre-0.18 releases are classified `unsupported`; other versions/build formats are `unknown`. Status probes may still succeed on untested versions, but the result explicitly warns about compatibility. This is source/fixture contract testing, **not live-NVR certification**, and does not establish support for future tools.

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
    FRIGATE_BEARER_TOKEN: process.env.FRIGATE_BEARER_TOKEN!,
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

The bridge initializes MCP, validates the exact known read-only manifest, and registers `mcp__frigate__get_system_status` as a replay-safe nested tool. Connect again on host restart; never persist the live client, credentials, or transport. Tool-contract upgrades require a compatible bridge; an unknown manifest fails closed.

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

Durable code mode journals delivered nested results; interrupted safe reads may run again and observe changed state. This slice does **not** claim exactly-once external execution, a cross-call snapshot, or completed crash/reopen acceptance coverage (issue #8). The deterministic harness/fixture example is in `examples/smoke.ts`.

The full approved plan and dependency graph are in [docs/spec.md](docs/spec.md).
