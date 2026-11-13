# KateStock 2.0 implementation status

The client loads a validated public `data/latest.json`, stores the last valid snapshot locally, and merges quotes into the existing device-only portfolio without replacing manual or newer quotes. This localStorage cache is not encrypted. The source is always shown and snapshots are not live quotes. This is an incremental implementation: no production report is bundled.

The experimental workflow generates an artifact for a fixed public list of owner-approved stock codes. It is **not a market-wide scan**. It uses Eastmoney, an AKShare/Sina fallback for stock history, and the AKShare trading calendar, and fails closed if no current data or a current calendar is available. The workflow is configured to build and deploy on success; it leaves the prior Pages deployment untouched on generation or validation failure. It has not yet been run in GitHub Actions. Verify its provider terms, cross-checks, validation, exchange calendar, and deployment/last-good behavior before relying on it. The scheduled list is maintained in `scripts/public-universe.json`; importing a personal file on a device does not change the scheduled list. Her gold product remains a manual value until its ticker is known. Existing manual refresh is retained.

To test: `npm ci`, `npm run build`, `npm run lint`, and `python3 -m unittest discover -s tests`. Run the experimental workflow with `workflow_dispatch` and examine its artifact before publishing. An optional, bounded DeepSeek Flash briefing runs after ingestion if the `DEEPSEEK_API_KEY` Actions secret is set; the response is validated and failures do not block the deterministic report. No secret belongs in client assets. Existing private holdings never leave the browser as part of this snapshot flow. Manual quote refresh contacts the existing third-party provider with requested stock codes.

The handoff's production requirements remain open: validated coverage/adjustments, complete instrument registry, stable scheduled publication and last-good failure reporting, source verification, expanded signal validation, AI grounding review, browser/offline testing, Pages deployment, account-plan verification, backup/privacy audit, and the requested visibility transition. Do not claim the Pages site is private. Restore the pre-change checkout from the Git bundle before replacing the source if needed; back up device-local data with the app's export first.

## Privacy gate

Historical starter records have been removed from `src/data/initialStocks.ts`; existing device-local data is preserved. The owner has a separate private JSON backup for import on a new device. Review the generated public assets and Git history before release. Existing previously public copies cannot be retracted by making the repository private.

## Portable private files

The Settings page imports JSON, Markdown, text or a ZIP containing one `stocks.json`, `stocks.md` or `stocks.txt`. Markdown/text use lines such as `600000, Name, watch` or a Markdown table with columns code, name, status, shares, cost and annualPnl. Imports add new codes without replacing existing entries. The optional `goldValueCny: 1000` line restores gold value only when the device has none. Markdown export contains private information; JSON export is the full local backup. ZIP entries containing keys are ignored. GitHub Actions secrets must be configured separately. The generated AI text is optional, constrained, labelled and based only on public daily market data.

A local live check on 13 November 2026 produced 27 valid quotes and two failed ETF quotes as of 12 November; no ETF fallback adjustment is assumed. DeepSeek returned a valid optional briefing in a separate local test. No GitHub deployment or scheduled run has been verified.

## Interactive voice research

The Today page includes an optional microphone and a prominent written answer panel, editable transcript, and written/spoken DeepSeek response. Speech recognition depends on browser/device support and may send audio to its speech provider; users can instead use the device keyboard's dictation. Speech playback may require tapping the play button on iOS. A user explicitly sends the transcribed question; no portfolio data is attached automatically.

This feature requires `server/app.py` at the same origin under `/api/chat`; static GitHub Pages does not implement this endpoint. The server requires an `AUTH_TOKEN` and `KEY_ENCRYPTION_KEY`, and accepts a server-side `DEEPSEEK_API_KEY` or its encrypted configured key. Run it behind HTTPS with a strong unique household token and rate limits; the token is held only in the page's in-memory state. The endpoint imposes a daily cap and does not store chat text. The model does not have live quotes, access to the portfolio, or a search tool. Deployment, access control, real iOS microphone, speech playback, and production rate limiting have not been verified.

The scheduled workflow invokes the shared `generateStrategy` engine for each valid public quote. Published signals are watchlist-level rules, not personalized holdings, allocations, or trade orders. Personal risk calculations remain local.
