# CodeZ Extension Host

A clean-room, VS Code–compatible **extension host** for CodeZ. It runs real
`.vsix` extension JavaScript against a `vscode` API implementation and talks to
the CodeZ renderer (Monaco + React) over a structured RPC protocol — the
"Theia-style compatible host" approach.

## Architecture

```
Tauri renderer (React + Monaco)          Tauri host (Rust)         Node sidecar (this package)
┌───────────────────────────┐  ext_host  ┌──────────────────┐  stdio  ┌──────────────────────────┐
│ MainThread* bridges        │◀──events──▶│ ext_host.rs      │◀──────▶ │ extensionHostProcess      │
│ rpcProtocol (renderer copy)│  invoke    │ broker (stdin)   │  NDJSON │ rpcProtocol + ExtHost*    │
│ Monaco language registry   │            │ vsix.rs (unpack) │         │ vscode API factory        │
└───────────────────────────┘            └──────────────────┘         │ 3rd-party extension JS    │
                                                                       └──────────────────────────┘
```

- **Transport**: line-delimited JSON (NDJSON). The renderer cannot talk to the
  Node process directly, so the Rust host brokers it: the sidecar's stdout lines
  are emitted on the `codez:ext-host` Tauri event channel, and the renderer
  sends frames back through the `ext_host_send` command (→ sidecar stdin).
- **Protocol**: `src/common/{proxyIdentifier,rpcProtocol,protocol,dto}.ts`.
  `MainThread*` shapes run on the renderer; `ExtHost*` shapes run here. Methods
  are `$`-prefixed and routed by numeric proxy id. The renderer keeps a
  byte-compatible copy of the `common/` modules under `src/extensions/common/`.
- **API surface**: `src/host/apiFactory.ts` assembles the `vscode` namespace
  from the `ExtHost*` services and the concrete types in `types-impl.ts`.
  `require('vscode')` is intercepted per-extension in `extensionService.ts`.

## Building

```bash
npm install
npm run build      # -> dist/host.js (+ dist/smoke.js)
npm run smoke      # in-process loopback test (no Tauri required)
npm run typecheck
```

`dist/host.js` is what the Rust host launches:
`node <resources>/extension-host/host.js`. Resolution order in
`ext_host.rs`: explicit arg → `$CODEZ_EXT_HOST_JS` → bundled resource → dev
paths (`extension-host/dist/host.js`). Override the Node binary with
`$CODEZ_NODE`.

## Packaging (Node runtime)

Tauri does not embed Node. For shipped builds:

1. `tauri.conf.json` bundles `dist/host.js` into app resources
   (`bundle.resources`), and `beforeBuildCommand` runs `npm run build:exthost`.
2. The app currently launches the host with the system `node` (or `$CODEZ_NODE`).
   To make installs fully self-contained, add a per-platform Node binary as a
   Tauri **externalBin** sidecar and point `node_bin()` at it. (Tracked as the
   remaining hardening item — see milestone M17.)

## Licensing strategy

- This host is an **MIT clean-room implementation**. It does *not* vendor source
  files from `microsoft/vscode` or `eclipse-theia/theia`; the public `vscode`
  extension API contract and the RPC pattern are reimplemented here.
- Eclipse Theia (EPL-2.0) was used only as a *reference* for the MainThread-side
  design; no Theia source is copied, so the project stays MIT by default.
- Extensions are installed from **Open VSX** (and user-supplied `.vsix`) to avoid
  the VS Code Marketplace Terms of Service.

## Compatibility tier (professional)

Implemented capability bridges: commands, documents/editors, workspace + fs +
configuration, messages, status bar, quick input, output channels, language
features (completion / hover / definition / references / highlights / symbols /
formatting / code actions / signature help / diagnostics), tree views, webviews,
terminals, SCM providers, tasks (via PTY), debug (DAP), testing, and notebook
serializers.

Known limits: native (`.node`) modules require ABI-matching prebuilds; remote /
container extension hosts are out of scope for this tier.
