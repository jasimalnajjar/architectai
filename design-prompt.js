/* =====================================================================
   ArchitectAI — the LLM contract.

   The deterministic renderer (diagram / doc / Terraform / ADRs / backlog)
   reads a strict spec shape. This module:
     1. SYSTEM_PROMPT     — teaches Claude to act as a solution architect
                            and to emit that exact spec.
     2. EMIT_DESIGN_TOOL  — the single forced tool whose input IS the spec.
     3. normalizeSpec()   — converts the LLM's friendly object form into the
                            tuple form the renderer expects, defensively.
   ===================================================================== */

// Catalog component ids that already ship with real Terraform/CloudFormation +
// curated cost/specs. Reusing these ids makes the Build tab light up with real
// IaC for free; any other id falls back to a sensible per-kind default.
const CATALOG_IDS = [
  "pg", "redis", "s3", "queue", "api", "gw", "cdn", "auth", "worker", "obs",
  "pay", "aisvc", "vec", "ws", "os", "dr", "orders", "cust", "bus", "cdc",
  "kafka", "lake", "flink", "dbt", "wh", "elt", "rtapi", "bi",
];

const KINDS = ["client", "edge", "app", "data", "async", "external", "legacy", "ops"];

export const SYSTEM_PROMPT = `You are ArchitectAI, an expert solution architect. A user describes a system in plain language — greenfield, brownfield (modernisation), or a data platform — and you produce a complete, opinionated solution design by calling the \`emit_design\` tool exactly once.

You think like a principal engineer: you make concrete technology choices (default to AWS unless the user names another cloud), size components, call out the real risks, and sequence delivery. You do NOT hedge with "it depends" — you decide, then explain the trade-off.

## How your output is used
Your tool call is rendered deterministically into four synchronized views: an architecture DIAGRAM (zoned, every node clickable), a DESIGN DOC (decisions, costs, NFRs, risks, roadmap), a BUILD pack (Terraform/CloudFormation/ADRs/backlog generated from the spec), and the raw SPEC JSON. So the spec must be complete and internally consistent — every edge must reference real node ids, every node must sit in a real zone.

## Spec rules
- **zones**: left-to-right tiers the user reads as a flow. Typical greenfield: Clients → Edge → Application → Data → Async/Integration. Give each a short id and a human label.
- **nodes**: each has \`id\` (short, unique, lowercase), \`zone\` (a zone id), \`label\`, \`sub\` (one line: the concrete tech, e.g. "ECS Fargate · 2 tasks"), and \`kind\`.
- **kind** must be one of: ${KINDS.join(", ")}. (client=user-facing app, edge=CDN/WAF/gateway, app=service, data=datastore, async=queue/stream/worker, external=SaaS/3rd-party, legacy=existing estate being strangled, ops=DR/observability/tooling.)
- **edges**: \`{from, to, label}\` directed; set \`dashed: true\` for async/replication/eventual flows.
- **Reuse these catalog ids where the component matches** so the Build tab emits real IaC: ${CATALOG_IDS.join(", ")}. For example use id "pg" for a Postgres/RDS store, "redis" for an ElastiCache cache, "s3" for object storage, "api" for the core API, "gw" for the API gateway, "queue"/"bus"/"kafka" for messaging, "pay" for a payments service, "aisvc"+"vec" for AI + vector search, "cdn", "auth", "worker", "obs", "dr". Keep their meaning intact.
- For a node that ISN'T a catalog id, you MAY include \`meta\`: \`{ desc, cost (USD/month integer, or null for usage-based/external/legacy), specs (object of label→value, 3-5 rows), tf (a Terraform snippet string), cfn (a CloudFormation snippet string) }\`. Provide \`meta\` for the important custom components so their spec drawer, cost, and IaC are rich. Catalog ids already have this — don't duplicate it for them.

## Brownfield
If the request is a migration/modernisation of an existing system, set \`scenario: "brownfield"\` and provide BOTH \`states.current\` (the legacy estate, using kind "legacy") and \`states.target\` (the modernised design). Prefer a strangler-fig approach over a big-bang rewrite, and make the roadmap a phased migration.

## Data platforms
If it's primarily an analytics/streaming/lakehouse system, set \`scenario: "data"\`.

## The doc
- **overview**: 2-4 sentences framing the design and the single most important decision.
- **decisions**: the real architecture choices, each with a one-paragraph rationale that names the trade-off you accepted.
- **nfrs**: scalability, availability, security, performance, cost — each with a concrete target/approach.
- **risks**: honest risks with severity high/med/low. Include at least one the user probably hasn't thought of.
- **phases**: a delivery (or migration) plan, 3-6 phases, each shippable.

## The reply
\`reply\` is a concise markdown chat message (no headings; **bold** and *italic* and bullet "•" lines are fine). Lead with the shape of the design and the key decision, point the user at the Diagram/Design Doc/Build tabs, and invite refinement (e.g. "add a Redis cache", "make it multi-region", "migrate this to Azure"). When the user asks a question rather than a change (e.g. "what are the risks?"), answer it in \`reply\` and return the spec unchanged.

Always call \`emit_design\` exactly once with a complete spec. When refining, return the FULL updated spec, preserving everything the user did not ask to change.`;

const ZONE = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
  },
  required: ["id", "label"],
};

const NODE = {
  type: "object",
  properties: {
    id: { type: "string", description: "short unique lowercase id; reuse a catalog id when it matches" },
    zone: { type: "string", description: "id of a zone in this state" },
    label: { type: "string" },
    sub: { type: "string", description: "one-line concrete tech, e.g. 'ECS Fargate · 2 tasks'" },
    kind: { type: "string", enum: KINDS },
    meta: {
      type: "object",
      description: "Optional rich metadata for non-catalog components.",
      properties: {
        desc: { type: "string" },
        cost: { type: ["integer", "null"], description: "indicative USD/month, or null if usage-based/external/legacy" },
        specs: { type: "object", additionalProperties: { type: "string" } },
        tf: { type: "string", description: "Terraform snippet" },
        cfn: { type: "string", description: "CloudFormation snippet" },
      },
    },
  },
  required: ["id", "zone", "label", "kind"],
};

const EDGE = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    label: { type: "string" },
    dashed: { type: "boolean", description: "true for async/replication/eventual flows" },
  },
  required: ["from", "to"],
};

const STATE = {
  type: "object",
  additionalProperties: false,
  properties: {
    zones: { type: "array", items: ZONE },
    nodes: { type: "array", items: NODE },
    edges: { type: "array", items: EDGE },
  },
  required: ["zones", "nodes", "edges"],
};

export const EMIT_DESIGN_TOOL = {
  name: "emit_design",
  description:
    "Emit the complete solution design: a conversational reply plus the structured spec that renders into the diagram, design doc, and build pack.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "Concise markdown chat message to the user." },
      title: { type: "string", description: "Short title for the design." },
      scenario: { type: "string", enum: ["greenfield", "brownfield", "data"] },
      states: {
        type: "object",
        properties: {
          target: STATE,
          current: { ...STATE, description: "Legacy estate — REQUIRED for brownfield, omit otherwise." },
        },
        required: ["target"],
      },
      doc: {
        type: "object",
        properties: {
          overview: { type: "string" },
          decisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" }, rationale: { type: "string" } },
              required: ["title", "rationale"],
            },
          },
          nfrs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { quality: { type: "string" }, target: { type: "string" } },
              required: ["quality", "target"],
            },
          },
          risks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { severity: { type: "string", enum: ["high", "med", "low"] }, text: { type: "string" } },
              required: ["severity", "text"],
            },
          },
          phases: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" }, detail: { type: "string" } },
              required: ["title", "detail"],
            },
          },
        },
        required: ["overview", "decisions", "nfrs", "risks", "phases"],
      },
    },
    required: ["reply", "title", "scenario", "states", "doc"],
  },
};

/* ---- Convert the LLM's object form → the renderer's tuple form ---- */
function asState(s) {
  if (!s || typeof s !== "object") return null;
  return {
    zones: Array.isArray(s.zones) ? s.zones : [],
    nodes: Array.isArray(s.nodes) ? s.nodes : [],
    edges: Array.isArray(s.edges) ? s.edges : [],
  };
}

export function normalizeSpec(input) {
  const reply = typeof input.reply === "string" ? input.reply : "Here's the design.";
  const doc = input.doc || {};
  const arr = (x) => (Array.isArray(x) ? x : []);

  const states = { target: asState(input.states?.target) };
  if (input.states?.current) states.current = asState(input.states.current);

  const spec = {
    title: input.title || "Untitled design",
    scenario: ["greenfield", "brownfield", "data"].includes(input.scenario) ? input.scenario : "greenfield",
    states,
    doc: {
      overview: doc.overview || "",
      decisions: arr(doc.decisions).map((d) => [d.title || "", d.rationale || ""]),
      nfrs: arr(doc.nfrs).map((n) => [n.quality || "", n.target || ""]),
      risks: arr(doc.risks).map((r) => [["high", "med", "low"].includes(r.severity) ? r.severity : "med", r.text || ""]),
      phases: arr(doc.phases).map((p) => [p.title || "", p.detail || ""]),
    },
  };

  return { reply, spec };
}
