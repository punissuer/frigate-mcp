# Using frigate-mcp with pi-durable code mode

This guide wires the read-only Frigate MCP server into a **pi-durable** host
that exposes the tools to the model as **code mode**: the model writes
JavaScript that calls the tools inside a sandbox, and only the script's output
reaches the conversation.

Two pieces:

- **`frigate-mcp`** — the MCP server (stdio or Streamable HTTP) that talks to
  Frigate. It never exposes credentials to the model.
- **`frigate-mcp/durable`** — an optional bridge that connects to that server
  and registers its tools with pi-durable under stable names.

The model calls the tools as `mcp__frigate__<tool>` inside a script, exactly
as it would in any other pi-durable host.

A complete, runnable host is in
[`examples/pi-durable-host.ts`](../examples/pi-durable-host.ts):

```sh
npm run example:pi-durable      # deterministic, offline, against a fixture
```

The example is self-contained: it carries its own Frigate-shaped fixture, so it
also runs from the published package. In a host project:

```sh
npm install frigate-mcp                       # or: npm install github:punissuer/frigate-mcp
npm install @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 \
            @earendil-works/pi-schema@1.5.0 @earendil-works/pi-codemode@1.5.0 @earendil-works/chord@1.5.0
npx tsx node_modules/frigate-mcp/examples/pi-durable-host.ts
```

The host must be ESM (`"type": "module"`), and the example expects the built
server at `node_modules/frigate-mcp/dist/cli.js`.

---

## 1. Install

```sh
npm ci && npm run build          # builds dist/cli.js (the server the bridge spawns)
```

Node.js **24.15.0+** (24 LTS or 26); the tested majors are 24.15.0+ and
26.12.1+, and CI runs the whole suite on both.

In the **host application**, install the optional durable peers at the tested
versions:

```sh
npm install @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 \
            @earendil-works/pi-schema@1.5.0 @earendil-works/pi-codemode@1.5.0 @earendil-works/chord@1.5.0
```

`frigate-mcp` itself declares those as optional peers, so an ordinary MCP
client can install it without them.

## 2. Wire the host

```ts
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { connectFrigateStdio, frigateNamespace } from 'frigate-mcp/durable';

const context = BACKGROUND_CONTEXT;
const storage = await openNodeSqliteStorage('./session.sqlite');   // persists across restarts
const bridge = await connectFrigateStdio({
  command: process.execPath,
  args: ['/absolute/path/to/frigate-mcp/dist/cli.js'],
  env: {
    FRIGATE_API_ROOT: process.env.FRIGATE_API_ROOT!,
    FRIGATE_USERNAME: process.env.FRIGATE_USERNAME!,
    FRIGATE_PASSWORD: process.env.FRIGATE_PASSWORD!,
    // optional: FRIGATE_CAMERAS, FRIGATE_TLS_PIN_CERT_FILE, ...
  },
});
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });

const registry = createRegistry();
registry.install(bridge.extension);                       // the Frigate tools
registry.install(createCodemodeExtension({
  sandbox,
  namespaces: [frigateNamespace],                        // "frigate" / "mcp__frigate__"
  models: false,                                          // keep the model catalog out of the sandbox
}));

const harness = await Harness.open(storage, { models, registry }, context);
```

Notes:

- **The credentials live in the bridge's `env`, never in the sandbox.** The
  sandbox can reach the Frigate tools and nothing else.
- **`frigateNamespace`** is what `describeNamespace('frigate')` and
  `searchTools()` see. Its prefix is `mcp__frigate__`.
- **`callers: ['tools']`** on the bridge's tools keeps them out of the model's
  direct tool list — the model reaches them only by writing code.
- `models: false` turns off the sandbox's `models.*` helpers. Drop it if the
  script should also classify or generate images.

## 3. The script surface

Inside the sandbox the model gets `tools`, `describeNamespace`, `searchTools`,
`describeTool`, `text`, `image`, `store` and `load`:

```js
const namespace = await describeNamespace('frigate');
const cameras = await tools.mcp__frigate__list_cameras({});
if (cameras.isError || !cameras.structuredContent.ok) {
  text({ error: cameras.structuredContent.error });
} else {
  text(cameras.structuredContent.data.cameras);
}
```

Every Frigate tool resolves with the preserved MCP result, so the script sees
`content`, `structuredContent` and `isError`:

| Field | Meaning |
| --- | --- |
| `structuredContent.ok` | `true` on success, `false` with a typed `error` |
| `structuredContent.data` | The typed payload (cameras, events, artifact metadata…) |
| `structuredContent.meta` | `observedAt`, `warnings`, `contractRelease` |
| `structuredContent.error` | `{ code, message, retryable, status? }` |
| `content` | The MCP content blocks (text mirror, and images for the media tools) |
| `isError` | `true` when the tool failed |

A tool error **resolves** inside the script — it does not throw — so the script
must check `structuredContent.ok`. A transport or harness failure **rejects**;
catch it when independent calls should continue:

```js
const results = await Promise.allSettled([
  tools.mcp__frigate__list_events({ after, before, cameras: ['front_door'] }),
  tools.mcp__frigate__list_review_items({ after, before }),
]);
```

## 4. Images and clips

**Images** arrive as MCP image blocks inside `content`. Forward them with
`image()` rather than printing base64:

```js
const frame = await tools.mcp__frigate__get_latest_frame({ camera: 'front_door' });
if (!frame.isError && frame.structuredContent.ok) {
  const picture = frame.content.find(block => block.type === 'image');
  if (picture) image(picture);
  text(frame.structuredContent.data);   // mime, bytes, capture time, source
}
```

The structured result never carries the image bytes, so the metadata stays
small; the image block is what the model actually sees.

`get_event_preview_gif` returns an `image/gif` block the same way; forward it
with `image()` (or hand it to a host helper).

**Clips** become private, expiring artifacts. The tool returns an opaque URI;
the host fetches the bytes over the transport:

```ts
const clip = await bridge.readArtifact(uri);   // { mimeType, byteLength, blob }
await fs.writeFile('evidence.mp4', Buffer.from(clip.blob, 'base64'));
```

`readArtifact` refuses anything that is not a `frigate://artifact/<32 hex>`
URI, so a model-supplied path or URL can never become a file read.

## 5. Restart and replay

The durable harness is what makes a long investigation survive a restart:

- **Persist the storage, not the connection.** Keep the SQLite file; recreate
  the bridge, the sandbox and the harness after a restart, then
  `harness.resume()`.
- **Committed observations are reused.** The code-mode tool journals each
  nested result; after a crash it reruns the script and hands it the journaled
  results, so a call whose result was committed is not issued again.
- **Interrupted safe reads may repeat.** A read that was in flight when the
  process died has no committed result, so it follows its own replay policy
  and may run again — and it can observe newer data.
- **Replay is not exactly-once execution**, and not a cross-call snapshot
  either.
- **Nothing sensitive is persisted**: only tool results and metadata, never the
  MCP client, the transport, or a credential.

```ts
// after a restart
const harness = await Harness.open(await openNodeSqliteStorage('./session.sqlite'), { models, registry }, context);
harness.resume();      // continues the run the last process left unfinished
```

## 6. Shutting down

Close in this order: the harness first, then the sandbox, then the bridge.
Closing the sandbox while a script runs is not an outcome — the script resumes
with the next process's sandbox.

```ts
await harness.close(context);
await sandbox.close();
await bridge.close();
```

## 7. Remote instead of stdio

The same bridge works against the Streamable HTTP endpoint — the tool
contracts, the manifest validation and the replay policy are unchanged:

```ts
const bridge = await connectFrigateHttp({
  url: 'https://mcp.example.internal/mcp',
  secret: process.env.FRIGATE_MCP_HTTP_SECRET!,
});
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Unable to connect to a compatible Frigate MCP server` | The server offers a different manifest — the bridge fails closed rather than rebinding an operation. Upgrade the bridge and the server together, then restart the host. |
| The script cannot find `mcp__frigate__…` | The bridge extension is not installed in the registry, or the namespace is not passed to `createCodemodeExtension`. |
| A tool call rejects in the script | A transport or harness failure (the server died, the schema changed). Catch it and inspect `result.diagnostics`. |
| The tool resolves but `structuredContent` is undefined | The server returned a result that does not match the known contract; treat it as a failure. |
| `busy` from a tool | `FRIGATE_MAX_CONCURRENT` upstream reads are already in flight; lower the script's concurrency or raise the limit. |
| `untrusted_certificate` / `certificate_mismatch` | The server cannot trust Frigate's certificate: see the TLS section of the [README](../README.md). |

## Reference

- [README](../README.md) — the tool contracts, configuration, TLS, and compatibility baseline.
- [HERMES_INSTALL.md](../HERMES_INSTALL.md) — the same server in Hermes (a plain MCP client, no durable bridge).
- [`examples/pi-durable-host.ts`](../examples/pi-durable-host.ts) — the runnable host used above.
