# ICT Brain Backend Web v3.0

Server-backed web version of ICT Brain.

## Architecture

Browser responsibilities are intentionally small: select 1–4 screenshots, optionally label instrument/timeframe, resize them for transport, and render the response.

The Vercel backend performs:

1. strict input/type/count/size validation;
2. image normalization with `sharp`;
3. independent OCR of the visible right-side price scale with `tesseract.js`;
4. robust price-axis calibration with outlier rejection;
5. multimodal chart reasoning through Vercel AI Gateway;
6. local conversion of model visual Y anchors into actual prices;
7. NQ/MNQ 0.25 tick rounding;
8. LONG/SHORT geometry and risk/reward validation;
9. one-trade-only output enforcement;
10. safe `WAIT` when any required evidence/grounding step fails.

The model is never asked to author numeric Entry / Stop / Take Profit values. It returns visual Y-permille anchors only. The backend derives prices independently.

## AI authentication

On Vercel, the AI SDK can use the deployment OIDC identity with AI Gateway. No browser API secret is required. The default model is `openai/gpt-5.6-sol`; override it with `ICT_BRAIN_MODEL` if desired.

## Optional private access key

Set `ICT_BRAIN_ACCESS_KEY` as a Vercel environment variable to require a personal key for `/api/analyze`. The browser has a private-access field and stores the key only in localStorage. Never commit the key to GitHub.

## Privacy

ICT Brain does not intentionally persist screenshots. Images are accepted by the serverless function, processed in memory, sent to the configured AI model through Vercel AI Gateway for inference, and discarded when the request ends. Platform/provider operational logging and retention are governed by their policies; `disallowPromptTraining` is requested through AI Gateway.

## Run checks

```bash
npm install
npm run check
npm test
```

## Vercel project

Deploy this directory as the Vercel project root:

`vercel-app`

The public site and `/api/*` backend then share one origin, so there is no CORS or exposed backend URL configuration.
