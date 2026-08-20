# Iron Brain — MNQ Quant Intelligence Terminal

Iron Brain UI v0.1 is the visual command-center prototype for the MNQ quant system.

## Current milestone

- Cinematic central brain interface
- Animated white neural pathways
- Technical / Cross-Market / Macro / News / Fair Value / Microstructure / Risk / Execution module activity
- LONG / SHORT / WAIT / DO NOT TRADE visual states
- Decision reasons and veto-first trace
- Simulated MNQ price/chart/intelligence feed
- Read-only simulation: no broker connectivity and no order placement

## Safety boundary

This repository contains the **frontend prototype only**. It does not contain private broker credentials and does not authorize or place trades. The frozen V13.5.8 quant engine remains separate.

Fair Value and Microstructure deliberately appear unavailable when their legitimate inputs are absent rather than being fabricated.

## GitHub Pages

This repository is ready for GitHub Pages using the included `.github/workflows/pages.yml` workflow.

After the repository exists on GitHub:

1. Push these files to the `main` branch.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, select **GitHub Actions** if GitHub has not already selected it.
4. The `Deploy Iron Brain to GitHub Pages` workflow publishes the site.

For a repository named `iron-brain`, the expected public address is:

`https://<github-username>.github.io/iron-brain/`

## Local preview

```bash
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Next milestone — UI v0.2

Replace simulated frontend state with a read-only `BrainSnapshot` stream from the frozen V13.5.8 Python quant backend. The browser remains presentation-only and has no execution authority.
