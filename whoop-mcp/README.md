# WHOOP MCP Server (ChatGPT Connector)

A minimal **Model Context Protocol** (MCP) server that connects ChatGPT to **WHOOP v2 API** (read‑only).
It exposes tools to fetch **recovery, sleep, workouts, cycles, and a daily summary**.

## Quick start (Render/Vercel/any Node host)
1. Create a WHOOP Developer app and note the **Client ID** and **Client Secret**.
2. Set the **Redirect URI** in WHOOP to `https://<your-host>/oauth/callback`.
3. Deploy this folder as a Node service (Node 18+).
4. Configure env vars (see `.env.example`). For Vercel, add them in Project → Settings → Environment Variables.
5. Open `https://<your-host>/oauth/login` and finish OAuth. This writes `tokens.json`.
6. In ChatGPT → Settings → **Connectors** → **Create** → URL of MCP server: `https://<your-host>/mcp` → Auth: OAuth.

> NOTE: This demo stores tokens in `tokens.json` on disk (single-user). For multi-user or serverless,
> use a proper secret store (e.g., Vercel KV, Redis, or a database).

### Tools
- `whoop_today_summary` – Get today’s recovery + last sleep in one go.
- `whoop_recovery_range` – Recoveries between ISO datetimes.
- `whoop_sleep_range` – Sleep sessions between ISO datetimes.
- `whoop_workouts_range` – Workouts between ISO datetimes.

## Security
This example is **read-only** and requests only read scopes. Review code before deploying.
