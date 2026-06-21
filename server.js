/* =====================================================================
   ArchitectAI — local server for the live (real-AI) experiment.

   Serves the static front-end AND exposes POST /api/design, which turns
   a natural-language brief (or a refinement) into the SAME structured
   spec the deterministic renderer already understands — only now an LLM
   (Claude) emits the spec instead of the hand-written scenario library.

   The renderer (diagram / design doc / Terraform / ADRs / backlog) is
   unchanged: the LLM's only job is to produce a valid spec + a chat reply.

   Run:
     export ANTHROPIC_API_KEY=sk-ant-...
     npm install && npm start
     # → http://localhost:8787   (header flips to "Live AI · Claude")

   With no key set, the site still serves and falls back to the scripted
   demo, so a static deploy keeps working.
   ===================================================================== */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

import {
  SYSTEM_PROMPT, EMIT_DESIGN_TOOL, normalizeSpec,
  CODE_SYSTEM_PROMPT, EMIT_CODE_TOOL, normalizeCode,
} from "./design-prompt.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.ARCHITECTAI_MODEL || "claude-opus-4-8";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

const client = HAS_KEY ? new Anthropic() : null; // reads ANTHROPIC_API_KEY from env

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const STATIC = new Set([
  "/index.html", "/app.js", "/styles.css", "/preview.png", "/favicon.ico",
  "/design-prompt.js",
]);

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ---- Build the Claude request from the client's conversation ---- */
function buildMessages({ history, message, spec }) {
  const messages = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (!turn || typeof turn.text !== "string" || !turn.text.trim()) continue;
    const role = turn.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: turn.text });
  }

  // The latest user turn carries the current design as context, so the model
  // can refine it precisely rather than redesigning from scratch.
  let content = String(message || "").trim();
  if (spec && spec.states) {
    const compact = JSON.stringify({
      title: spec.title,
      scenario: spec.scenario,
      states: spec.states,
      doc: spec.doc,
    });
    content =
      "Here is the CURRENT design spec (refine this — return the complete updated spec, " +
      "preserving everything the user didn't ask to change):\n```json\n" +
      compact + "\n```\n\nMy request: " + content;
  }
  messages.push({ role: "user", content });
  return messages;
}

async function handleDesign(req, res) {
  if (!client) {
    return sendJSON(res, 503, {
      error: "no_api_key",
      message: "Set ANTHROPIC_API_KEY and restart the server to enable live AI.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req) || "{}");
  } catch {
    return sendJSON(res, 400, { error: "bad_request", message: "Invalid JSON body." });
  }
  if (!payload.message || !String(payload.message).trim()) {
    return sendJSON(res, 400, { error: "bad_request", message: "A 'message' is required." });
  }

  const messages = buildMessages(payload);

  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  const findTool = (msg) =>
    msg.content.find((b) => b.type === "tool_use" && b.name === "emit_design");

  try {
    // Primary path: adaptive thinking for the best architecture reasoning,
    // tool_choice "auto" (the system prompt requires a single emit_design call).
    // Stream to stay under HTTP timeouts.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system,
      tools: [EMIT_DESIGN_TOOL],
      tool_choice: { type: "auto" },
      messages,
    });

    let final = await stream.finalMessage();
    let toolUse = findTool(final);

    // Fallback: if the model answered without calling the tool, force it.
    // (Forced tool_choice is incompatible with thinking, so omit thinking here.)
    if (!toolUse) {
      final = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "high" },
        system,
        tools: [EMIT_DESIGN_TOOL],
        tool_choice: { type: "tool", name: "emit_design" },
        messages,
      });
      toolUse = findTool(final);
    }
    if (!toolUse) {
      return sendJSON(res, 502, {
        error: "no_design",
        message: "The model did not return a design. Try rephrasing.",
      });
    }

    const { reply, spec } = normalizeSpec(toolUse.input);
    return sendJSON(res, 200, {
      reply,
      spec,
      model: final.model,
      usage: final.usage,
    });
  } catch (err) {
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    console.error("[/api/design]", err?.message || err);
    return sendJSON(res, status, {
      error: "llm_error",
      message: err?.message || "The design request failed.",
    });
  }
}

async function handleCode(req, res) {
  if (!client) {
    return sendJSON(res, 503, {
      error: "no_api_key",
      message: "Set ANTHROPIC_API_KEY and restart the server to enable code generation.",
    });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || "{}");
  } catch {
    return sendJSON(res, 400, { error: "bad_request", message: "Invalid JSON body." });
  }
  const spec = payload.spec;
  if (!spec || !spec.states) {
    return sendJSON(res, 400, { error: "bad_request", message: "A design 'spec' is required." });
  }

  const messages = [{
    role: "user",
    content:
      "Generate the application code build-out for this design.\n```json\n" +
      JSON.stringify({ title: spec.title, scenario: spec.scenario, states: spec.states, doc: spec.doc }) +
      "\n```",
  }];

  try {
    // Code-only call: force the tool (no thinking, which is incompatible with
    // forced tool_choice), generous max_tokens, streamed to dodge timeouts.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      output_config: { effort: "high" },
      system: [{ type: "text", text: CODE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [EMIT_CODE_TOOL],
      tool_choice: { type: "tool", name: "emit_code" },
      messages,
    });
    const final = await stream.finalMessage();
    const toolUse = final.content.find((b) => b.type === "tool_use" && b.name === "emit_code");
    if (!toolUse) {
      return sendJSON(res, 502, { error: "no_code", message: "The model did not return code. Try again." });
    }
    return sendJSON(res, 200, { ...normalizeCode(toolUse.input), model: final.model, usage: final.usage });
  } catch (err) {
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    console.error("[/api/code]", err?.message || err);
    return sendJSON(res, status, { error: "llm_error", message: err?.message || "Code generation failed." });
  }
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // Confine to known static assets — no traversal, no directory listing.
  if (!STATIC.has(urlPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const filePath = normalize(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url || "/").split("?")[0];

    if (path === "/api/health") {
      return sendJSON(res, 200, { ok: true, live: HAS_KEY, model: HAS_KEY ? MODEL : null });
    }
    if (path === "/api/design") {
      if (req.method !== "POST") return sendJSON(res, 405, { error: "method_not_allowed" });
      return await handleDesign(req, res);
    }
    if (path === "/api/code") {
      if (req.method !== "POST") return sendJSON(res, 405, { error: "method_not_allowed" });
      return await handleCode(req, res);
    }
    return await serveStatic(req, res);
  } catch (err) {
    console.error("[server]", err?.message || err);
    if (!res.headersSent) sendJSON(res, 500, { error: "server_error", message: "Unexpected error." });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ArchitectAI  →  http://localhost:${PORT}`);
  console.log(
    HAS_KEY
      ? `  Live AI enabled · model: ${MODEL}\n`
      : `  ⚠  ANTHROPIC_API_KEY not set — serving the scripted demo only.\n     export ANTHROPIC_API_KEY=sk-ant-... and restart for live AI.\n`
  );
});
