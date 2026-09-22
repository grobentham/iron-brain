# ICT Brain Web — One Trade

Static GitHub Pages version of the screenshot analyzer.

## Workflow

1. Open the site in **desktop Google Chrome** with the built-in Prompt API available.
2. Add 1–4 chart screenshots.
3. Label instrument/timeframe when known. `AUTO` means the user has not certified the label.
4. Keep the right-side TradingView price scale visible.
5. Press **Find one grounded trade**.
6. The page returns exactly one `LONG`, one `SHORT`, or `WAIT`.

For best context use:

- 1H NQ
- 15m NQ
- 5m MNQ
- 1m MNQ

## Privacy / architecture

- Static site; no application backend.
- No OpenAI API key, Gemini API key, or broker credential.
- Local browser OCR uses Tesseract.js to read right-axis price labels.
- The AI step uses Chrome's built-in on-device Prompt API / Gemini Nano when available.
- The model is not trusted to author numeric Entry / Stop / TP prices.
- The model returns visual Y anchors only.
- The page maps those anchors to prices through independent OCR price-axis calibration.
- Actionable plans require strong calibration, supported setup, minimum visible-evidence confidence, valid visual geometry, valid price geometry, and 0.25-point tick rounding.
- Any failed validation returns `WAIT`.

## Browser support

Chrome's built-in foundation-model Prompt API currently supports desktop Chrome on supported Windows/macOS/Linux/ChromeOS hardware. Chrome on Android/iOS is not currently supported for this API. Unsupported browsers show an unavailable status and do not fabricate a trade.

## Hosting

The `web-app` branch contains the site in `/web`. The included `web-pages.yml` workflow publishes `/web` to GitHub Pages once this repository's **Settings → Pages → Source** is set to **GitHub Actions**.

The expected project URL is:

`https://grobentham.github.io/iron-brain/`

## Trading accuracy

Software checks and grounding logic are not a profitability claim. Actual ICT decision accuracy still needs a labeled screenshot benchmark. Evidence confidence is not win probability.
