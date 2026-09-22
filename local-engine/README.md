# ICT Brain Local Engine

This is the Windows background engine used by the GitHub Pages website and Live Bridge. It runs the existing deterministic ICT Brain v6.4 code on the user's own PC.

## Architecture

GitHub Pages UI / Opera Live Bridge -> `http://127.0.0.1:8787` -> local ICT Brain engine -> deterministic result.

The server binds only to the loopback address. It does not listen on the LAN. It allows the ICT Brain GitHub Pages origin and Chromium/Firefox extension origins, supports Local Network Access preflight, and exposes only:

- `GET /health`
- `POST /analyze`

No external model API is used.

## Normal Windows use

Use the packaged Windows artifact from the `Build ICT Brain Windows Local Engine` GitHub Actions workflow.

1. Extract the ZIP.
2. Run `local-engine/install.ps1` once from PowerShell.
3. The installer copies the engine to `%LOCALAPPDATA%\ICTBrain\Engine`.
4. It registers `ICTBrainLocalEngine` under the current user's Windows Run key.
5. It starts the engine hidden through `wscript.exe`.
6. On future Windows sign-ins, the engine starts automatically.

There is no BAT file to run every session and no administrator access is required for the normal per-user install.

## Browser permission

Modern Chromium browsers gate requests from a public HTTPS page to loopback behind Local Network Access permission. The GitHub Pages UI explicitly marks its fetch as `targetAddressSpace: 'loopback'`. The first connection can therefore trigger a browser permission prompt. Granting that permission allows the website to talk to the local engine; the website cannot bypass this browser security permission.

The server also returns CORS and Private Network Access headers for the exact GitHub Pages origin.

## Diagnostics

Engine log:

`%LOCALAPPDATA%\ICTBrain\logs\engine.log`

Health endpoint:

`http://127.0.0.1:8787/health`

## Remove

Run `local-engine/uninstall.ps1`. It removes autostart and the installed engine files while keeping logs for diagnostics.
