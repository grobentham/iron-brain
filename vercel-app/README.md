# ICT Brain v4 — Native Analysis Engine

ICT Brain v4 is a server-side screenshot analysis tool for NQ/MNQ/ES futures.

## Core architecture

The production analysis path is self-contained software. It does **not** call ChatGPT, OpenAI, Gemini, Claude, Vercel AI Gateway, or another external inference API.

Pipeline:

1. Browser compresses and uploads 1–4 screenshots.
2. `sharp` normalizes the images in the Vercel function.
3. The native pixel engine reconstructs a candlestick series from chart geometry.
4. Deterministic structure code derives swings, liquidity raids, displacement, structural shifts, FVGs, breaker retests, rejection signals and multi-timeframe bias.
5. Local Tesseract OCR reads the execution chart's right-side price scale. English trained data is bundled through `@tesseract.js-data/eng`, so the backend does not depend on a runtime language-data CDN.
6. Local grounding converts screenshot Y positions into actual prices and validates entry/stop/target geometry and R:R.
7. The backend returns exactly one LONG, SHORT, or WAIT result.

## Native setup coverage in v4.0

Executable now: S01, S05, S06, S09, S11, S12.

Fail-closed for now: S02 SMT and time-window-dependent S03/S04/S10, plus S08 session sequencing, until native timestamp/cross-market alignment extraction is certified. The engine does not invent those setups.

## Safety boundaries

- One direction, one setup, one entry, one stop, one target.
- No TP2/TP3, runner, scale-in, backup entry, second-best trade, or alternative direction.
- Screenshots are processed in memory and are not intentionally stored by ICT Brain.
- No broker connectivity or order placement.
- Confidence is deterministic visible-evidence quality, not win probability.
- If candle reconstruction, setup evidence, OCR price grounding, or trade geometry is weak, the result is WAIT.
