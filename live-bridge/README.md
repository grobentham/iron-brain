# ICT Brain Live Bridge v1.1

Opera/Chromium extension that connects explicitly authorized TradingView tabs to the native ICT Brain backend.

## What changed in v1.1

- Remembers chart connections across browser restarts and attempts to reconnect matching TradingView tabs automatically.
- Uses change-aware scanning: scheduled scans hash each captured chart and skip the backend entirely when nothing changed.
- Maintains a bounded local market journal and a simple live lifecycle state: `WATCHING`, `NEW_STRATEGY`, `STILL_VALID`, `NO_CURRENT_STRATEGY`.
- Captures visible TradingView canvas layers plus visible DOM-rendered price/time-axis labels when available.
- Sends deterministic time-axis hints, timezone hints, capture fingerprints, and capture metadata to ICT Brain v6.1.
- The backend fits the visible time labels to candle X coordinates and validates the implied candle spacing against the declared timeframe before certifying the time axis.
- Session-window logic still fails closed unless the chart explicitly exposes a certifiable timezone; NQ↔ES synchronized SMT is not yet enabled.

## Core behavior

- Connect up to four TradingView tabs.
- Recommended stack: NQ 1H, NQ 15m, MNQ 5m, MNQ 1m.
- Run manually or every 30 seconds / 1 minute / 2 minutes / 5 minutes.
- Send all changed connected charts in one backend request.
- Show LONG / SHORT / WAIT and native time-axis status in the popup.
- Notify only when a new fixed LONG/SHORT strategy signature appears.
- Never place broker orders.
- Never call ChatGPT, Gemini, Claude, Vercel AI Gateway, or another external model API.

## Privacy / access model

The extension only has host access to TradingView and the ICT Brain production domain. A TradingView chart must be explicitly connected before it can be remembered or scanned. It does not use TradingView private/internal APIs. It reads chart pixels and visible page labels already rendered in the authorized tab.

The optional ICT Brain access key is stored in Chromium extension local storage and is sent only as the `x-ictbrain-key` header to the configured ICT Brain backend.

## Install in Opera

1. Download or clone this repository.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `live-bridge` folder.
6. Pin **ICT Brain Live Bridge** to the toolbar.

After updating an already loaded unpacked extension, use the **Reload** button on `opera://extensions`.

## Connect the recommended four-chart stack

Open four TradingView tabs and connect each from the popup:

1. NQ — 1H
2. NQ — 15m
3. MNQ — 5m
4. MNQ — 1m

Then enable **Live Scan**. Scheduled scans compare capture fingerprints first. If every connected chart is unchanged, the backend request is skipped and the popup increments **Unchanged scans skipped**.

## Native time-axis behavior

Live Bridge collects visible clock labels such as `09:30`, `10:00`, etc. together with their horizontal positions. ICT Brain v6.1 then:

1. parses usable clock labels;
2. fits a deterministic X→time line;
3. checks fit residuals and horizontal coverage;
4. compares the implied minutes-per-candle with the declared timeframe;
5. annotates reconstructed candles with chart-local times only when the calibration passes.

The engine does not assume a New York timezone merely because the instrument is NQ/MNQ/ES. Eastern session rules require an explicit visible New York / EST / EDT timezone signal and otherwise remain disabled.

## Remaining limitation

TradingView layouts vary. Some labels can remain canvas-only or be virtualized, and background tabs can occasionally be discarded by Chromium. v1.1 detects these conditions and fails closed instead of inventing data. The next major step is synchronized NQ↔ES candle alignment and a full multi-timeframe live market graph.
