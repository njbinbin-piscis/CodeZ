# Releasing AgentZ

This document covers how AgentZ is currently distributed, how end users install
the **unsigned** builds, and the concrete steps + CI secrets needed to enable
code signing, notarization, and in-app auto-update later.

## Current release model (v0.3.0)

- **Unsigned / manual download.** Artifacts are built by
  [`.github/workflows/release.yml`](.github/workflows/release.yml) using
  `tauri-action` and attached to a **published** (non-draft) GitHub release.
- **Platforms produced on tag `v*` (or manual dispatch):**
  - Linux x86_64 + aarch64 — `.deb`, `.AppImage`
  - Windows x86_64 + aarch64 — `.msi`, `.exe` (NSIS)
  - macOS — `.dmg`, `.app` (Apple Silicon and Universal)
- **No in-app updater.** Users update by downloading the newer release manually.

### Cutting a release

1. Bump the version in the three places that must agree:
   - `package.json` (`version`)
   - `src-tauri/Cargo.toml` (`package.version`)
   - `src-tauri/tauri.conf.json` (`version`)
   - (also `extension-host/package.json` if it ships in lockstep)
2. Update [`CHANGELOG.md`](CHANGELOG.md).
3. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
4. The release workflow builds all platforms and publishes the release.

## Installing the unsigned builds (end users)

Because these builds are not yet code signed, the OS will warn that the
publisher is unverified. This is expected.

### macOS (Gatekeeper)

The `.dmg`/`.app` is unsigned and un-notarized, so a normal double-click is
blocked with "AgentZ can't be opened because Apple cannot check it for
malicious software."

1. Drag **AgentZ.app** to `/Applications`.
2. Right-click (or Control-click) the app → **Open** → **Open** in the dialog.
   This records an exception for that copy of the app.
3. If still blocked, remove the quarantine attribute in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/AgentZ.app
   ```

### Windows (SmartScreen)

The `.msi`/`.exe` is unsigned, so SmartScreen shows "Windows protected your PC".

1. Click **More info**.
2. Click **Run anyway**.

### Linux

- **AppImage:** `chmod +x AgentZ_*.AppImage && ./AgentZ_*.AppImage`
- **Debian/Ubuntu:** `sudo dpkg -i agentz_*_amd64.deb` (or `sudo apt install ./agentz_*_amd64.deb` to pull dependencies).

## Diagnostics / logs

AgentZ writes a daily-rolling log to `{config dir}/logs/agentz.log`:

- Linux: `~/.config/com.agentz.desktop/logs/`
- macOS: `~/Library/Application Support/com.agentz.desktop/logs/`
- Windows: `%APPDATA%\com.agentz.desktop\logs\`
- Override the base directory with `AGENTZ_CONFIG_DIR`.

Increase verbosity with `RUST_LOG` (e.g. `RUST_LOG=debug`). See
[`.env.example`](.env.example) for all supported variables.

## Roadmap: signing, notarization, and auto-update

When certificates are available, the following can be enabled with **no
application code changes** — only `release.yml` inputs and repository secrets.

### macOS code signing + notarization

Add to the macOS jobs' `tauri-action` step `env`:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the "Developer ID Application" `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Org (TEAMID)`. |
| `APPLE_ID` | Apple ID used for notarization. |
| `APPLE_PASSWORD` | App-specific password for that Apple ID. |
| `APPLE_TEAM_ID` | Apple developer Team ID. |

### Windows code signing

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CERTIFICATE` | Base64 of the code-signing `.pfx`. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx`. |

Configure `bundle.windows.certificateThumbprint` / `signCommand` (or an Azure
Trusted Signing action) in `tauri.conf.json` accordingly.

### In-app auto-update (`tauri-plugin-updater`)

1. Add the `tauri-plugin-updater` plugin (Rust + JS) and register it.
2. Generate an updater keypair: `npm run tauri signer generate`.
3. Add `plugins.updater` to `tauri.conf.json` with the public key and the
   release endpoint(s) (e.g. the GitHub releases `latest.json`).
4. Add secrets:

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater private key. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater key. |

`tauri-action` will then emit the signed update artifacts and `latest.json`.

## Security note: Content Security Policy

`src-tauri/tauri.conf.json` currently sets `app.security.csp: null` (no CSP).

**Decision for this release: retain `null`.** The renderer loads several rich,
dynamically-evaluated front-end subsystems (Monaco editor workers, Mermaid,
syntax highlighting) and talks to local bridges (LSP over WebSocket) plus
user-configured model/gateway endpoints. A tight CSP would need careful
per-source allow-listing (`script-src`, `worker-src`, `connect-src`, `img-src`,
`style-src`) and regression testing across IDE + Agent modes; shipping a
mis-scoped CSP risks breaking core features.

**Follow-up:** define a least-privilege CSP — start from `default-src 'self'`,
add `connect-src` for the WebSocket bridge and configured API hosts,
`worker-src blob:` for Monaco, and the minimal `style-src`/`img-src` the UI
needs — then validate before enabling. Track as a hardening task post-release.
