# ICT Brain Live Bridge v1.0

Opera/Chromium extension that connects explicitly authorized TradingView tabs to the native ICT Brain backend.

## What it does

- Connect up to four TradingView tabs.
- Assign instrument/timeframe labels per tab (for example NQ 1H, NQ 15m, MNQ 5m, MNQ 1m).
- Composite visible TradingView canvas layers directly from each connected tab.
- Send all connected chart screenshots in a single request to `https://iron-brain.vercel.app/api/analyze`.
- Run manually or every 30 seconds / 1 minute / 2 minutes / 5 minutes.
- Show LONG / SHORT / WAIT in the extension popup.
- Raise a browser notification only when a new fixed LONG/SHORT strategy signature appears.
- Never place broker orders.
- Never calls ChatGPT, Gemini, Claude, Vercel AI Gateway, or another external model API.

## Privacy / access model

The extension only has host access to TradingView and the ICT Brain production domain. A TradingView tab must be explicitly connected from the popup before it is scanned. It does not use TradingView private/internal APIs; it reads the visible chart canvas pixels rendered in the connected page.

The optional ICT Brain access key is stored in Chromium extension local storage and is sent only as the `x-ictbrain-key` header to the configured ICT Brain backend.

## Install in Opera

1. Download or clone this repository.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `live-bridge` folder.
6. Pin **ICT Brain Live Bridge** to the toolbar.

## Connect the recommended four-chart stack

Open four TradingView tabs and connect each one from the extension popup:

1. NQ — 1H
2. NQ — 15m
3. MNQ — 5m
4. MNQ — 1m

On each TradingView tab, open the Live Bridge popup, select its instrument/timeframe, and click **Connect current TradingView tab**.

Then enable **Live Scan**. The default 30-second interval stays below the backend's current best-effort rate limit because all connected tabs are analyzed in one request.

## Important capture limitation

v1 captures TradingView's visible chart canvases from the DOM. This allows background connected tabs to be read without debugger/private API access, but some TradingView layouts can contain DOM-rendered overlays that are not part of a canvas. If a layout hides the price/time scale outside captured canvases, ICT Brain will safely return WAIT rather than invent values.

A future bridge version can add a stronger dedicated TradingView layout adapter and native timestamp extraction.
