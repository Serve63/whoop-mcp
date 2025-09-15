import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

dotenv.config();

const PORT = process.env.PORT || 3000;
const TOKEN_STORE_FILE = process.env.TOKEN_STORE_FILE || "./tokens.json";
const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer/v2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// CORS — allow ChatGPT client to read the Mcp-Session-Id header
app.use(cors({
  origin: "*",
  exposedHeaders: ["Mcp-Session-Id"],
  allowedHeaders: ["Content-Type", "mcp-session-id"],
}));

// ---- Simple token store (single-user demo) ----
async function readTokens() {
  try {
    const data = await fs.readFile(TOKEN_STORE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}
async function writeTokens(tokens) {
  await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokens, null, 2));
}

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("redirect_uri", process.env.WHOOP_REDIRECT_URI);
  params.set("client_id", process.env.WHOOP_CLIENT_ID);
  params.set("client_secret", process.env.WHOOP_CLIENT_SECRET);

  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Token exchange failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function refreshAccessToken(refresh_token) {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refresh_token);
  params.set("client_id", process.env.WHOOP_CLIENT_ID);
  params.set("client_secret", process.env.WHOOP_CLIENT_SECRET);

  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Refresh failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function ensureAccessToken() {
  const tokens = await readTokens();
  if (!tokens) throw new Error("Not authorized. Visit /oauth/login first.");
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at && tokens.expires_at - 60 > now) {
    return tokens.access_token;
  }
  // Refresh
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const newTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_in: refreshed.expires_in,
    expires_at: now + (refreshed.expires_in || 3600),
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  };
  await writeTokens(newTokens);
  return newTokens.access_token;
}

function scopesParam() {
  const scopes = process.env.WHOOP_SCOPES || "read:recovery read:sleep read:workout read:cycles read:profile";
  return scopes.split(/[\s,]+/).filter(Boolean).join(" ");
}

// ---- OAuth routes ----
app.get("/oauth/login", (req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.WHOOP_CLIENT_ID || "",
    redirect_uri: process.env.WHOOP_REDIRECT_URI || "",
    scope: scopesParam(),
  });
  const url = `${WHOOP_AUTH_URL}?${params.toString()}`;
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");
    const tokens = await exchangeCodeForTokens(code);
    const now = Math.floor(Date.now() / 1000);
    tokens.expires_at = now + (tokens.expires_in || 3600);
    await writeTokens(tokens);
    res.status(200).send("WHOOP connected ✅ — you can close this tab and add the MCP URL (/mcp) in ChatGPT connectors.");
  } catch (e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// ---- WHOOP helpers ----
async function whoopGet(path, params = {}) {
  const token = await ensureAccessToken();
  const url = new URL(WHOOP_API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`WHOOP GET ${url} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

// Basic endpoints
async function getRecoveryRange(start, end, limit = 10) {
  return whoopGet("/recovery", { start, end, limit });
}
async function getSleepRange(start, end, limit = 10) {
  // Sleep collection lives under activity
  return whoopGet("/activity/sleep", { start, end, limit });
}
async function getWorkoutsRange(start, end, limit = 10) {
  return whoopGet("/activity/workout", { start, end, limit });
}
async function getProfile() {
  return whoopGet("/user/profile/basic");
}

// ---- MCP server & tools ----
const transports = {}; // sessionId -> transport

function buildMcpServer() {
  const server = new McpServer({
    name: "whoop-mcp",
    version: "0.1.0"
  });

  // Tool: today summary
  server.registerTool(
    "whoop_today_summary",
    {
      title: "WHOOP: today summary",
      description: "Get today's recovery plus last night's sleep summary.",
      inputSchema: {}
    },
    async () => {
      const now = new Date();
      const end = now.toISOString();
      const start = new Date(now.getTime() - 1000*60*60*24*2).toISOString(); // last 48h window
      const [recovery, sleep, profile] = await Promise.all([
        getRecoveryRange(start, end, 1),
        getSleepRange(start, end, 1),
        getProfile()
      ]);
      const rec = recovery?.records?.[0];
      const slp = sleep?.records?.[0];
      const name = profile?.first_name ? `${profile.first_name} ${profile.last_name||""}`.trim() : "user";
      const lines = [];
      if (rec?.score) {
        lines.push(`Recovery: ${rec.score.recovery_score}% | RHR ${rec.score.resting_heart_rate} bpm | HRV ${rec.score.hrv_rmssd_milli?.toFixed?.(0)} ms`);
      }
      if (slp?.score?.stage_summary) {
        const s = slp.score.stage_summary;
        const fmt = (ms)=> (ms/3600000).toFixed(1)+"h";
        lines.push(`Sleep: in bed ${fmt(s.total_in_bed_time_milli)}, REM ${fmt(s.total_rem_sleep_time_milli)}, Deep ${fmt(s.total_slow_wave_sleep_time_milli)}`);
      }
      return {
        content: [{ type: "text", text: `${name} — ${lines.join(" | ")}` }]
      };
    }
  );

  // Tool: recovery range
  server.registerTool(
    "whoop_recovery_range",
    {
      title: "WHOOP: recovery range",
      description: "Get recoveries between start and end ISO datetimes (UTC).",
      inputSchema: {
        start: z.string().describe("ISO datetime, e.g. 2025-09-01T00:00:00Z"),
        end: z.string().describe("ISO datetime, e.g. 2025-09-15T23:59:59Z"),
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ start, end, limit = 10 }) => {
      const data = await getRecoveryRange(start, end, limit);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Tool: sleep range
  server.registerTool(
    "whoop_sleep_range",
    {
      title: "WHOOP: sleep range",
      description: "Get sleep sessions between start and end ISO datetimes (UTC).",
      inputSchema: {
        start: z.string(),
        end: z.string(),
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ start, end, limit = 10 }) => {
      const data = await getSleepRange(start, end, limit);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Tool: workouts range
  server.registerTool(
    "whoop_workouts_range",
    {
      title: "WHOOP: workouts range",
      description: "Get workouts between start and end ISO datetimes (UTC).",
      inputSchema: {
        start: z.string(),
        end: z.string(),
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ start, end, limit = 10 }) => {
      const data = await getWorkoutsRange(start, end, limit);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// POST /mcp — client→server messages (initialize, call tools, etc.)
app.post("/mcp", async (req, res) => {
  try {
    const sessionIdHeader = req.headers["mcp-session-id"];
    let transport = sessionIdHeader ? transports[sessionIdHeader] : undefined;

    if (!sessionIdHeader && isInitializeRequest(req.body)) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = buildMcpServer();
      await server.connect(transport);
      // Store by session
      transports[transport.sessionId] = transport;
    } else if (!transport) {
      // No session to handle this request
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err.message || err) }, id: null });
    }
  }
});

// GET /mcp — server→client notifications via stream (per spec)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`WHOOP MCP server listening on port ${PORT}`);
});
