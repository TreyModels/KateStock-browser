# KateStock server deployment

This is a single-household prototype. Serve behind HTTPS. Do not use the development server as a public deployment.

1. Build: `docker build -t katestock .`
2. Generate KEY_ENCRYPTION_KEY: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` (requires cryptography).
3. Generate a separate strong random AUTH_TOKEN. Set both values as hosting secrets, never in the source repository.
4. Run the container with port 8080 and a persistent volume mounted at /data. Configure the hosting provider to keep one instance running. The embedded scheduler requires an always-on process, not a sleeping/serverless host.
5. Open its HTTPS URL on iPhone in Safari, Share > Add to Home Screen. Enter the household access token under Research settings, then enter a DeepSeek API key.

The key is encrypted in SQLite and never returned to the browser. Preserve the encryption key and persistent volume together. The access token is held only in browser memory and must be entered again after reload. Anyone holding it can access this household's settings and reports.

Scheduling is opt-in, defaults off, and permits at most one attempted request per UTC day. Failed attempts count toward the cap. Output is capped at 1800 tokens per request. This is not an RMB spending guarantee; check DeepSeek billing. Delete the API key or disable scheduling to stop future calls.

Current research is explicitly a general research checklist. The model has no live market data, filings retrieval or browsing in this version. Current-price research and valuation ranges require an additional verified data feed. No model output should be represented as current sourced investment research.
