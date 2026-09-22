# ICT Brain Live Bridge v1.2

Opera/Chromium extension that connects explicitly authorized TradingView tabs to the native ICT Brain backend.

## What changed in v1.2

- Connects up to **five** TradingView tabs so the full stack can be monitored together: `NQ 1H`, `NQ 15m`, `MNQ 5m`, `MNQ 1m`, `ES 1m`.
- Five-chart requests are analyzed together by ICT Brain v6.4 instead of dropping a higher-timeframe chart to make room for ES.
- Keeps synchronized NQ/MNQ↔ES SMT available on matching certified timeframes while preserving the 1H/15m/5m/1m market context.
- Adds deterministic lifecycle reporting: `WATCHING`, `FORMING`, `CONFIRMED`, `ARMED`, `TRIGGERED`, `TARGET_HIT`, `INVALIDATED`, `EXPIRED`.
- Dynamically recompresses connected chart captures in the extension service worker so a five-chart request stays within the backend upload budget.
- Continues to remember chart connections, reconnect matching TradingView tabs, skip unchanged scans, and keep a bounded local market journal.
- Never places broker orders and never calls ChatGPT, Gemini, Claude, Vercel AI Gateway, or another external model API.

## Recommended five-chart stack

1. NQ — 1H
2. NQ — 15m
3. MNQ — 5m
4. MNQ — 1m
5. ES — 1m

The two 1-minute charts are synchronized only when both native time axes independently certify. SMT remains unavailable rather than guessed when alignment is weak.

## Install / update in Opera

1. Download or clone this repository.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `live-bridge` folder.
5. If the extension was already loaded, press **Reload** after updating the files.
6. Pin **ICT Brain Live Bridge** to the toolbar.

Connect each TradingView chart from the popup, then enable **Live Scan**. Scheduled scans compare capture fingerprints first and do not call the backend when all connected charts are unchanged.

## Lifecycle semantics

`WATCHING` means no coherent strategy is active. `FORMING` means a deterministic hypothesis exists but has not passed all trade requirements. `CONFIRMED` means the creator and critic accepted the plan. `ARMED` means the accepted plan is close to its defined entry. In native five-chart mode, the backend can additionally distinguish entry interaction and terminal outcomes from reconstructed candle geometry; ambiguous same-candle stop/target ordering fails closed rather than inventing an outcome.

## Privacy / access model

Only explicitly connected TradingView tabs are captured. The extension uses visible chart canvases and visible DOM-rendered labels; it does not use TradingView private/internal APIs. The optional ICT Brain access key is stored in Chromium extension local storage and sent only to the configured ICT Brain backend.

## Remaining limitations

TradingView layouts vary. Some labels can remain canvas-only or be virtualized, and Chromium can discard background tabs. Five-chart mode requires enough visible execution-chart price labels to ground Entry/SL/TP without guessing. Session-window rules still require explicit certified timezone evidence.
