/* =====================================================================
   ArchitectAI — MVP mockup
   A "wizard of oz" prototype: the chat behaves like an AI architect,
   but responses are scripted/heuristic. The point is to demonstrate the
   core product loop:

      natural language  →  structured spec (JSON)  →  diagram + design doc
                         ↑__________ iterative refinement __________↓

   In the real product, the "classify/build spec" step below is replaced
   by an LLM emitting the same spec format.
   ===================================================================== */

"use strict";

/* ---------------------------------------------------------------------
   Spec format
   ---------------------------------------------------------------------
   {
     title, scenario: "greenfield" | "brownfield",
     states: { target: State, current?: State },   // brownfield has both
     doc: { overview, decisions[], nfrs[], risks[], phases[] }
   }
   State = { zones: [{id,label}], nodes: [{id,zone,label,sub,kind}],
             edges: [{from,to,label,dashed?}] }
--------------------------------------------------------------------- */

const KIND_COLORS = {
  client:   { fill: "#1d2a3f", stroke: "#3e6db5", badge: "CLIENT" },
  edge:     { fill: "#172e2c", stroke: "#2f9e8f", badge: "EDGE" },
  app:      { fill: "#23253f", stroke: "#6c8cff", badge: "SERVICE" },
  data:     { fill: "#33271c", stroke: "#d99a4e", badge: "DATA" },
  async:    { fill: "#2f2138", stroke: "#a96ce0", badge: "ASYNC" },
  external: { fill: "#262a33", stroke: "#7b8499", badge: "EXTERNAL" },
  legacy:   { fill: "#36211f", stroke: "#c05b50", badge: "LEGACY" },
  ops:      { fill: "#1c3022", stroke: "#4cc38a", badge: "OPS" },
};

/* =====================================================================
   SCENARIO LIBRARY
   ===================================================================== */

function greenfieldSpec(userInput, addons) {
  const zones = [
    { id: "clients", label: "Clients" },
    { id: "edge", label: "Edge" },
    { id: "app", label: "Application" },
    { id: "data", label: "Data" },
    { id: "ext", label: "External / Async" },
  ];
  const nodes = [
    { id: "web", zone: "clients", label: "Web App", sub: "Next.js · SSR", kind: "client" },
    { id: "cdn", zone: "edge", label: "CDN + WAF", sub: "CloudFront", kind: "edge" },
    { id: "gw", zone: "edge", label: "API Gateway", sub: "Auth, rate limits", kind: "edge" },
    { id: "api", zone: "app", label: "Core API", sub: "Node/TS · ECS Fargate", kind: "app" },
    { id: "auth", zone: "app", label: "Identity", sub: "OIDC · Cognito/Auth0", kind: "app" },
    { id: "pg", zone: "data", label: "PostgreSQL", sub: "RDS · Multi-AZ", kind: "data" },
    { id: "s3", zone: "data", label: "Object Store", sub: "S3 · assets, exports", kind: "data" },
    { id: "queue", zone: "ext", label: "Event Bus", sub: "SQS/EventBridge", kind: "async" },
    { id: "worker", zone: "ext", label: "Workers", sub: "Async jobs, emails", kind: "async" },
    { id: "obs", zone: "ext", label: "Observability", sub: "Logs · traces · alerts", kind: "ops" },
  ];
  const edges = [
    { from: "web", to: "cdn", label: "HTTPS" },
    { from: "cdn", to: "gw" },
    { from: "gw", to: "api", label: "REST/JSON" },
    { from: "gw", to: "auth", label: "OIDC", dashed: true },
    { from: "api", to: "pg", label: "SQL" },
    { from: "api", to: "s3" },
    { from: "api", to: "queue", label: "events" },
    { from: "queue", to: "worker" },
  ];
  const decisions = [
    ["Managed-first on a single cloud", "At MVP scale, managed services (RDS, Fargate, SQS) minimise ops burden; portability can be reclaimed later via containers."],
    ["Modular monolith over microservices", "One deployable with enforced module boundaries. Split services only when team size or scaling pressure demands it."],
    ["API Gateway as the single entry point", "Centralises authN, rate limiting, and request logging from day one."],
    ["Event bus for side effects", "Emails, notifications, and integrations run async so the request path stays fast and resilient."],
  ];
  const nfrs = [
    ["Availability", "99.9% — multi-AZ data tier, stateless app tier behind a load balancer"],
    ["Latency", "p95 < 300 ms for API reads; CDN for static assets"],
    ["Scalability", "Horizontal autoscaling on the app tier; read replicas when needed"],
    ["Security", "TLS everywhere, OIDC, least-privilege IAM, secrets in a vault"],
    ["Cost", "Estimated $600–1,200/mo at launch scale (excl. egress spikes)"],
  ];
  const risks = [
    ["med", "Single-region deployment — an AWS regional outage takes the product down. Acceptable for MVP; revisit at first enterprise customer."],
    ["med", "Modular monolith requires discipline — without enforced module boundaries it degrades into a big ball of mud."],
    ["low", "Vendor lock-in to AWS managed services — mitigated by containerised app tier."],
  ];

  // keyword add-ons
  if (addons.has("payments")) {
    nodes.push({ id: "pay", zone: "app", label: "Payments Svc", sub: "Idempotent · ledger", kind: "app" });
    nodes.push({ id: "stripe", zone: "ext", label: "Stripe", sub: "PSP · webhooks", kind: "external" });
    edges.push({ from: "api", to: "pay" }, { from: "pay", to: "stripe", label: "PSP API", dashed: true }, { from: "stripe", to: "queue", label: "webhooks", dashed: true });
    decisions.push(["Payments isolated behind its own service", "PCI scope containment: card data never touches the core API; Stripe holds the sensitive surface."]);
    risks.push(["high", "Webhook-driven payment state is eventually consistent — reconcile with a nightly ledger sweep against Stripe."]);
  }
  if (addons.has("ai")) {
    nodes.push({ id: "aisvc", zone: "app", label: "AI Service", sub: "Prompting · guardrails", kind: "app" });
    nodes.push({ id: "vec", zone: "data", label: "Vector Store", sub: "pgvector / Pinecone", kind: "data" });
    nodes.push({ id: "llm", zone: "ext", label: "LLM Provider", sub: "Claude API", kind: "external" });
    edges.push({ from: "api", to: "aisvc" }, { from: "aisvc", to: "vec", label: "kNN" }, { from: "aisvc", to: "llm", label: "inference", dashed: true });
    decisions.push(["Thin AI service over the LLM provider", "Keeps prompts, evals, and guardrails in one place; provider can be swapped without touching product code."]);
    risks.push(["med", "LLM latency and cost are workload-dependent — add response caching and per-tenant budgets early."]);
  }
  if (addons.has("realtime")) {
    nodes.push({ id: "ws", zone: "edge", label: "Realtime GW", sub: "WebSocket fan-out", kind: "edge" });
    edges.push({ from: "web", to: "ws", label: "WSS", dashed: true }, { from: "queue", to: "ws", label: "push" });
    decisions.push(["Dedicated WebSocket gateway", "Long-lived connections are isolated from the request/response tier so deploys don't drop sessions."]);
  }
  if (addons.has("mobile")) {
    nodes.unshift({ id: "mob", zone: "clients", label: "Mobile App", sub: "iOS / Android", kind: "client" });
    edges.push({ from: "mob", to: "gw", label: "HTTPS" });
  }
  if (addons.has("search")) {
    nodes.push({ id: "os", zone: "data", label: "Search", sub: "OpenSearch", kind: "data" });
    edges.push({ from: "api", to: "os", label: "query" }, { from: "worker", to: "os", label: "index", dashed: true });
  }

  return {
    title: "Greenfield Solution Design",
    scenario: "greenfield",
    states: { target: { zones, nodes, edges } },
    doc: {
      overview:
        `Proposed architecture for: “${userInput.trim()}”. ` +
        "The design optimises for speed-to-market with a managed, single-cloud stack, " +
        "while keeping clean seams (gateway, event bus, module boundaries) so the system " +
        "can be decomposed as the product and team grow.",
      decisions, nfrs, risks,
      phases: [
        ["Phase 1 · Weeks 1–4", "Walking skeleton: gateway → API → Postgres, CI/CD, observability baseline, auth."],
        ["Phase 2 · Weeks 5–8", "Core product features, async pipeline (events + workers), staging environment."],
        ["Phase 3 · Weeks 9–12", "Hardening: load tests, security review, backup/restore drills, launch."],
      ],
    },
  };
}

function brownfieldSpec(userInput) {
  const current = {
    zones: [
      { id: "clients", label: "Clients" },
      { id: "app", label: "On-prem Application" },
      { id: "data", label: "Data" },
      { id: "batch", label: "Batch / Integrations" },
    ],
    nodes: [
      { id: "web", zone: "clients", label: "Web UI", sub: "JSP · server-rendered", kind: "client" },
      { id: "mono", zone: "app", label: "Java Monolith", sub: "~800k LOC · WebLogic", kind: "legacy" },
      { id: "ora", zone: "data", label: "Oracle DB", sub: "Shared schema · PL/SQL", kind: "legacy" },
      { id: "fs", zone: "data", label: "NFS Share", sub: "Documents, exports", kind: "legacy" },
      { id: "cron", zone: "batch", label: "Cron Jobs", sub: "Nightly ETL · shell", kind: "legacy" },
      { id: "edi", zone: "batch", label: "Partner EDI", sub: "SFTP drops", kind: "external" },
    ],
    edges: [
      { from: "web", to: "mono", label: "HTTP" },
      { from: "mono", to: "ora", label: "JDBC" },
      { from: "mono", to: "fs" },
      { from: "cron", to: "ora", label: "ETL" },
      { from: "edi", to: "cron", label: "SFTP", dashed: true },
    ],
  };

  const target = {
    zones: [
      { id: "clients", label: "Clients" },
      { id: "edge", label: "Edge" },
      { id: "app", label: "Services (extracted)" },
      { id: "legacy", label: "Remaining Monolith" },
      { id: "data", label: "Data" },
    ],
    nodes: [
      { id: "web", zone: "clients", label: "Web App", sub: "React SPA", kind: "client" },
      { id: "gw", zone: "edge", label: "API Gateway", sub: "Strangler routing", kind: "edge" },
      { id: "orders", zone: "app", label: "Orders Svc", sub: "First extraction", kind: "app" },
      { id: "cust", zone: "app", label: "Customer Svc", sub: "Second extraction", kind: "app" },
      { id: "bus", zone: "app", label: "Event Bus", sub: "Kafka", kind: "async" },
      { id: "mono", zone: "legacy", label: "Java Monolith", sub: "Shrinking core", kind: "legacy" },
      { id: "pg", zone: "data", label: "PostgreSQL", sub: "Per-service schemas", kind: "data" },
      { id: "ora", zone: "data", label: "Oracle DB", sub: "Legacy, CDC-tapped", kind: "legacy" },
      { id: "cdc", zone: "data", label: "CDC Pipeline", sub: "Debezium", kind: "async" },
    ],
    edges: [
      { from: "web", to: "gw", label: "HTTPS" },
      { from: "gw", to: "orders", label: "/orders/*" },
      { from: "gw", to: "cust", label: "/customers/*" },
      { from: "gw", to: "mono", label: "everything else", dashed: true },
      { from: "orders", to: "pg" },
      { from: "cust", to: "pg" },
      { from: "orders", to: "bus", label: "events" },
      { from: "mono", to: "ora", label: "JDBC" },
      { from: "ora", to: "cdc", label: "redo log", dashed: true },
      { from: "cdc", to: "bus" },
    ],
  };

  return {
    title: "Brownfield Modernisation Design",
    scenario: "brownfield",
    states: { current, target },
    doc: {
      overview:
        `Modernisation plan for: “${userInput.trim()}”. ` +
        "Strategy: strangler fig. An API gateway fronts the monolith and routes extracted " +
        "capabilities to new services one domain at a time, while CDC keeps legacy Oracle data " +
        "flowing to the new event bus. The monolith is never rewritten big-bang — it shrinks " +
        "until what remains is cheap to retire or leave in place.",
      decisions: [
        ["Strangler fig over big-bang rewrite", "Big-bang rewrites of 800k-LOC systems fail far more often than they succeed. Incremental extraction ships value every quarter and is reversible at every step."],
        ["Gateway-first", "Putting a routing layer in front of the monolith before extracting anything makes every later step a config change, not a client migration."],
        ["Orders as the first extraction", "Highest change-frequency domain with the clearest bounded context — maximum payoff for the pattern-proving slice."],
        ["CDC instead of dual writes", "Debezium tails Oracle redo logs so new services consume legacy data changes without modifying monolith code."],
        ["Per-service data ownership", "Each extracted service gets its own schema in Postgres; no shared-database coupling is carried forward."],
      ],
      nfrs: [
        ["Migration safety", "Every extraction shadow-runs against the monolith before cutover; gateway enables instant rollback per route"],
        ["Availability", "No maintenance-window cutovers; target 99.9% throughout the programme"],
        ["Data integrity", "CDC lag alarmed at > 30 s; weekly reconciliation jobs between Oracle and Postgres"],
        ["Team topology", "One extraction at a time until the platform (CI/CD, observability, bus) is proven"],
      ],
      risks: [
        ["high", "Hidden coupling inside the monolith (shared session state, PL/SQL business logic) can stall extractions — run a 2-week dependency-mapping spike first."],
        ["high", "Oracle licence renewal in-flight: confirm CDC (log mining) is permitted under the current licence terms."],
        ["med", "Team has limited Kafka experience — start with a managed offering (MSK/Confluent) and one topic."],
        ["med", "Strangler programmes lose momentum after the first win — secure exec commitment to a 6-quarter roadmap, not a one-off project."],
        ["low", "SPA rewrite of the JSP UI can trail service extractions; gateway serves both UIs during transition."],
      ],
      phases: [
        ["Phase 0 · 4 wks", "Discovery: dependency map of the monolith, domain boundaries, gateway deployed routing 100% to legacy."],
        ["Phase 1 · Q1", "Extract Orders: new service + Postgres schema, CDC from Oracle, shadow traffic, then cutover /orders/* at the gateway."],
        ["Phase 2 · Q2", "Extract Customers; stand up the event bus as the integration backbone; retire the nightly ETL it replaces."],
        ["Phase 3 · Q3–Q4", "Repeat per domain (catalogue, billing). Begin JSP → SPA migration behind the same gateway."],
        ["Endgame", "Monolith reduced to low-change admin functions: containerise and leave, or retire entirely. Decommission Oracle when last consumer moves."],
      ],
    },
  };
}

function dataPlatformSpec(userInput) {
  const target = {
    zones: [
      { id: "src", label: "Sources" },
      { id: "ingest", label: "Ingestion" },
      { id: "store", label: "Lakehouse" },
      { id: "compute", label: "Processing" },
      { id: "serve", label: "Serving" },
    ],
    nodes: [
      { id: "apps", zone: "src", label: "Product Events", sub: "Clickstream SDK", kind: "client" },
      { id: "dbs", zone: "src", label: "OLTP Databases", sub: "CDC via Debezium", kind: "data" },
      { id: "saas", zone: "src", label: "SaaS Sources", sub: "Salesforce, Stripe…", kind: "external" },
      { id: "kafka", zone: "ingest", label: "Kafka", sub: "Streaming backbone", kind: "async" },
      { id: "elt", zone: "ingest", label: "Batch ELT", sub: "Fivetran/Airbyte", kind: "async" },
      { id: "lake", zone: "store", label: "Lakehouse", sub: "S3 + Iceberg", kind: "data" },
      { id: "flink", zone: "compute", label: "Stream Proc.", sub: "Flink · sessionisation", kind: "app" },
      { id: "dbt", zone: "compute", label: "dbt Models", sub: "Bronze→Silver→Gold", kind: "app" },
      { id: "wh", zone: "serve", label: "Warehouse", sub: "Snowflake/Trino", kind: "data" },
      { id: "bi", zone: "serve", label: "BI + Metrics", sub: "Dashboards, alerts", kind: "client" },
      { id: "rtapi", zone: "serve", label: "Realtime API", sub: "Sub-second features", kind: "app" },
    ],
    edges: [
      { from: "apps", to: "kafka", label: "events" },
      { from: "dbs", to: "kafka", label: "CDC" },
      { from: "saas", to: "elt", dashed: true },
      { from: "kafka", to: "flink" },
      { from: "kafka", to: "lake", label: "raw sink" },
      { from: "elt", to: "lake" },
      { from: "flink", to: "rtapi", label: "features" },
      { from: "flink", to: "lake" },
      { from: "lake", to: "dbt" },
      { from: "dbt", to: "wh" },
      { from: "wh", to: "bi", label: "SQL" },
    ],
  };
  return {
    title: "Realtime Analytics Platform Design",
    scenario: "greenfield",
    states: { target },
    doc: {
      overview:
        `Proposed architecture for: “${userInput.trim()}”. ` +
        "A streaming-first lakehouse: Kafka is the single ingestion backbone, raw data lands in " +
        "open table formats (Iceberg on S3), and the same data serves both sub-second use cases " +
        "(via Flink) and analytical modelling (via dbt into the warehouse). Open formats keep " +
        "compute engines swappable.",
      decisions: [
        ["Streaming-first ingestion", "Batch is a special case of streaming, not vice-versa. One backbone avoids the classic lambda-architecture duplication."],
        ["Open table format (Iceberg)", "Storage decoupled from compute: Trino, Spark, Snowflake can all read the same tables — no warehouse lock-in on raw data."],
        ["dbt for transformation", "Version-controlled, testable SQL models with lineage; analytics engineering as software engineering."],
        ["Buy ingestion connectors", "Fivetran/Airbyte for SaaS sources; connector maintenance is undifferentiated heavy lifting."],
      ],
      nfrs: [
        ["Freshness", "Realtime path < 5 s end-to-end; modelled marts hourly"],
        ["Scale", "Designed for ~50k events/s sustained, 10× burst"],
        ["Governance", "Schema registry mandatory on all topics; PII tagged and masked in Silver layer"],
        ["Cost", "Storage/compute separation; warehouse auto-suspend; ~70% of queries should hit pre-aggregated Gold tables"],
      ],
      risks: [
        ["high", "Schema drift from producers silently breaks pipelines — enforce schema registry compatibility rules from day one."],
        ["med", "Flink operational complexity is real; if sub-second isn't a hard requirement, start with Kafka→lake micro-batching and add Flink later."],
        ["med", "Cost runaway on warehouse compute — set per-team resource monitors before opening access."],
      ],
      phases: [
        ["Phase 1 · Weeks 1–4", "Kafka + schema registry, clickstream SDK, raw events landing in Iceberg."],
        ["Phase 2 · Weeks 5–8", "dbt project + warehouse, first Gold marts, BI dashboards for the top 5 business questions."],
        ["Phase 3 · Weeks 9–14", "CDC from OLTP, SaaS ELT, then the Flink realtime path once batch is trusted."],
      ],
    },
  };
}

/* =====================================================================
   INPUT CLASSIFICATION (mock of the LLM step)
   ===================================================================== */

function detectAddons(text) {
  const t = text.toLowerCase();
  const addons = new Set();
  if (/(payment|checkout|billing|e-?commerce|stripe|subscript)/.test(t)) addons.add("payments");
  if (/\b(ai|ml|llm|gpt|claude|recommendation|rag|chatbot|agent)\b/.test(t)) addons.add("ai");
  if (/(real-?time|websocket|live|chat|collaborat|presence)/.test(t)) addons.add("realtime");
  if (/(mobile|ios|android|app store)/.test(t)) addons.add("mobile");
  if (/(search|elasticsearch|opensearch|full-?text)/.test(t)) addons.add("search");
  return addons;
}

function classify(text) {
  const t = text.toLowerCase();
  if (/(brownfield|legacy|monolith|migrat|moderni[sz]|strangler|mainframe|on-?prem|rewrite|oracle|weblogic|cobol)/.test(t)) return "brownfield";
  if (/(analytics|data platform|clickstream|warehouse|lakehouse|streaming|kafka|etl|pipeline|bi\b)/.test(t)) return "data";
  return "greenfield";
}

/* =====================================================================
   REFINEMENTS (mock of iterative design loop)
   ===================================================================== */

const REFINEMENTS = [
  {
    match: /(add|put|include).*(redis|cach)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "redis")) return "Redis is already in the design.";
      const dataZone = st.zones.find(z => /data/i.test(z.label)) || st.zones[st.zones.length - 2];
      st.nodes.push({ id: "redis", zone: dataZone.id, label: "Redis", sub: "ElastiCache · cache + sessions", kind: "data" });
      const api = st.nodes.find(n => /api|orders|core/i.test(n.label)) || st.nodes[0];
      st.edges.push({ from: api.id, to: "redis", label: "cache" });
      spec.doc.decisions.push(["Redis as a look-aside cache", "Hot reads and session state move off the primary database; TTL-based invalidation keeps the model simple."]);
      return "Added **Redis (ElastiCache)** to the data tier as a look-aside cache for hot reads and session state, wired from the API. I also recorded the decision and its invalidation strategy in the design doc.\n\nRule of thumb: add it when p95 read latency or DB CPU says so — it's cheap insurance here given the read-heavy profile.";
    },
  },
  {
    match: /(add|include).*(cdn|cloudfront|edge cach)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "cdn")) return "A CDN is already at the edge of this design.";
      const edgeZone = st.zones.find(z => /edge/i.test(z.label)) || st.zones[1];
      st.nodes.unshift({ id: "cdn", zone: edgeZone.id, label: "CDN + WAF", sub: "CloudFront", kind: "edge" });
      const client = st.nodes.find(n => n.kind === "client");
      if (client) st.edges.unshift({ from: client.id, to: "cdn", label: "HTTPS" });
      return "Added a **CDN with WAF** at the edge. Static assets and cacheable API responses now terminate there, which also gives you DDoS absorption and TLS at the perimeter.";
    },
  },
  {
    match: /(multi[- ]?region|disaster recovery|\bdr\b|high availability|\bha\b|failover)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "dr")) return "Multi-region posture is already in the design.";
      const dataZone = st.zones.find(z => /data/i.test(z.label)) || st.zones[st.zones.length - 1];
      st.nodes.push({ id: "dr", zone: dataZone.id, label: "Region B (warm)", sub: "Cross-region replica", kind: "ops" });
      const db = st.nodes.find(n => n.kind === "data");
      if (db) st.edges.push({ from: db.id, to: "dr", label: "async repl.", dashed: true });
      spec.doc.risks.push(["low", "Warm-standby DR adds ~30–40% to data-tier cost; failover drills must run quarterly or the runbook rots."]);
      spec.doc.decisions.push(["Warm standby over active-active", "Active-active doubles complexity (conflict resolution, global routing) for an RTO most products don't need. Warm standby gives RTO ≈ 15 min, RPO ≈ 1 min at a fraction of the effort."]);
      return "Upgraded the design to a **warm-standby multi-region** posture: async cross-region replication on the data tier, with DNS failover.\n\nI deliberately chose warm standby over active-active — RTO ≈ 15 min / RPO ≈ 1 min covers most SLAs without the conflict-resolution complexity. The trade-off is recorded in the design doc.";
    },
  },
  {
    match: /(risk|concern|worr|what could go wrong|gotcha)/i,
    apply(spec) {
      const lines = spec.doc.risks.map(([sev, txt]) => `• **${sev.toUpperCase()}** — ${txt}`).join("\n");
      return "Here are the key risks I'm tracking for this design (also in the Design Doc tab):\n\n" + lines;
    },
  },
  {
    match: /(remove|drop|delete)\s+(the\s+)?(\w[\w\s-]*)/i,
    apply(spec, m) {
      const needle = m[3].trim().toLowerCase();
      const st = spec.states.target;
      const node = st.nodes.find(n => n.label.toLowerCase().includes(needle) || n.id === needle);
      if (!node) return `I couldn't find a component matching “${m[3].trim()}” in the current design. Check the node names in the Diagram tab.`;
      st.nodes = st.nodes.filter(n => n.id !== node.id);
      st.edges = st.edges.filter(e => e.from !== node.id && e.to !== node.id);
      return `Removed **${node.label}** and its connections from the design. If anything depended on it, the diagram will show the gap — tell me what should absorb its responsibilities.`;
    },
  },
];

/* =====================================================================
   DIAGRAM RENDERER  (spec → SVG, simple layered layout)
   ===================================================================== */

const NODE_W = 168, NODE_H = 58, V_GAP = 26, ZONE_PAD = 18, ZONE_GAP = 34, ZONE_TOP = 40;

function layout(state) {
  const byZone = new Map(state.zones.map(z => [z.id, []]));
  for (const n of state.nodes) (byZone.get(n.zone) || byZone.set(n.zone, []).get(n.zone)).push(n);

  const maxCount = Math.max(1, ...[...byZone.values()].map(a => a.length));
  const zoneH = ZONE_TOP + maxCount * NODE_H + (maxCount - 1) * V_GAP + ZONE_PAD;
  const zoneW = NODE_W + ZONE_PAD * 2;

  const pos = new Map();
  const zoneBoxes = [];
  let x = 10;
  for (const z of state.zones) {
    const nodes = byZone.get(z.id) || [];
    zoneBoxes.push({ ...z, x, y: 10, w: zoneW, h: zoneH });
    const stackH = nodes.length * NODE_H + (nodes.length - 1) * V_GAP;
    let y = 10 + ZONE_TOP + (zoneH - ZONE_TOP - ZONE_PAD - stackH) / 2;
    for (const n of nodes) {
      pos.set(n.id, { x: x + ZONE_PAD, y, w: NODE_W, h: NODE_H, node: n });
      y += NODE_H + V_GAP;
    }
    x += zoneW + ZONE_GAP;
  }
  return { pos, zoneBoxes, width: x - ZONE_GAP + 10, height: zoneH + 20 };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSVG(state, { animate = true } = {}) {
  const { pos, zoneBoxes, width, height } = layout(state);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" font-family="sans-serif">`;
  out += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#5a6580"/></marker></defs>`;

  // zones
  for (const z of zoneBoxes) {
    out += `<rect class="zone-rect" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="14"/>`;
    out += `<text class="zone-label" x="${z.x + 16}" y="${z.y + 24}">${esc(z.label)}</text>`;
  }

  // edges
  let i = 0;
  for (const e of state.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const forward = b.x >= a.x + a.w;
    const backward = a.x >= b.x + b.w;
    let x1, y1, x2, y2;
    if (forward)      { x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x;       y2 = b.y + b.h / 2; }
    else if (backward){ x1 = a.x;       y1 = a.y + a.h / 2; x2 = b.x + b.w; y2 = b.y + b.h / 2; }
    else { // same column: connect vertically
      const down = b.y > a.y;
      x1 = a.x + a.w / 2; y1 = down ? a.y + a.h : a.y;
      x2 = b.x + b.w / 2; y2 = down ? b.y : b.y + b.h;
    }
    const mx = (x1 + x2) / 2;
    const path = (forward || backward)
      ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} L ${x2} ${y2}`;
    const delay = animate ? ` style="animation-delay:${0.35 + i * 0.05}s"` : "";
    out += `<g class="edge-g"${delay}>`;
    out += `<path class="edge-path${e.dashed ? " dashed" : ""}" d="${path}" marker-end="url(#arrow)"/>`;
    if (e.label) {
      const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2;
      const w = e.label.length * 5.4 + 10;
      out += `<rect class="edge-label-bg" x="${lx - w / 2}" y="${ly - 9}" width="${w}" height="15" rx="4"/>`;
      out += `<text class="edge-label" x="${lx}" y="${ly + 2.5}" text-anchor="middle">${esc(e.label)}</text>`;
    }
    out += `</g>`;
    i++;
  }

  // nodes
  let j = 0;
  for (const { x, y, w, h, node } of pos.values()) {
    const c = KIND_COLORS[node.kind] || KIND_COLORS.app;
    const delay = animate ? ` style="animation-delay:${j * 0.06}s"` : "";
    out += `<g class="node-g"${delay}>`;
    out += `<rect class="node-rect" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c.fill}" stroke="${c.stroke}"/>`;
    out += `<text class="node-label" x="${x + 13}" y="${y + 24}">${esc(node.label)}</text>`;
    out += `<text class="node-sub" x="${x + 13}" y="${y + 41}">${esc(node.sub || "")}</text>`;
    out += `<text class="node-badge" x="${x + w - 10}" y="${y + 16}" text-anchor="end" fill="${c.stroke}">${esc(c.badge)}</text>`;
    out += `</g>`;
    j++;
  }

  out += `</svg>`;
  return out;
}

/* =====================================================================
   DESIGN DOC RENDERER
   ===================================================================== */

function renderDoc(spec) {
  const d = spec.doc;
  const el = document.getElementById("doc-host");
  const sevClass = { high: "risk-high", med: "risk-med", low: "risk-low" };
  const sevLabel = { high: "HIGH", med: "MED", low: "LOW" };

  let html = `<h1>${esc(spec.title)}</h1>`;
  html += `<div class="doc-meta">Generated by ArchitectAI (mockup) · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · v${spec._version || 1}</div>`;
  html += `<h2>1. Overview</h2><p>${esc(d.overview)}</p>`;

  html += `<h2>2. Key Architecture Decisions</h2><table><tr><th>Decision</th><th>Rationale</th></tr>`;
  for (const [t, r] of d.decisions) html += `<tr><td>${esc(t)}</td><td>${esc(r)}</td></tr>`;
  html += `</table>`;

  html += `<h2>3. Components</h2><ul>`;
  for (const n of spec.states.target.nodes) {
    html += `<li><b>${esc(n.label)}</b>${n.sub ? " — " + esc(n.sub) : ""}</li>`;
  }
  html += `</ul>`;

  html += `<h2>4. Non-Functional Requirements</h2><table><tr><th>Quality</th><th>Target / Approach</th></tr>`;
  for (const [q, v] of d.nfrs) html += `<tr><td>${esc(q)}</td><td>${esc(v)}</td></tr>`;
  html += `</table>`;

  html += `<h2>5. Risks &amp; Mitigations</h2><ul style="list-style:none;margin-left:0">`;
  for (const [sev, txt] of d.risks) {
    html += `<li style="margin-bottom:9px"><span class="risk-tag ${sevClass[sev]}">${sevLabel[sev]}</span>${esc(txt)}</li>`;
  }
  html += `</ul>`;

  const phasesTitle = spec.scenario === "brownfield" ? "6. Migration Roadmap" : "6. Delivery Plan";
  html += `<h2>${phasesTitle}</h2>`;
  for (const [t, desc] of d.phases) {
    html += `<div class="phase"><div class="phase-title"><span>◆</span>${esc(t)}</div><p>${esc(desc)}</p></div>`;
  }

  el.innerHTML = html;
}

/* =====================================================================
   CHAT / APP STATE
   ===================================================================== */

const $ = id => document.getElementById(id);
const chatMessages = $("chat-messages");
const chatScroll = $("chat-scroll");

let activeSpec = null;
let activeState = "target";
let busy = false;

const STARTERS = [
  { label: "<b>Greenfield</b> · B2B SaaS e-commerce platform on AWS, ~50k users, Stripe payments", text: "Design a greenfield B2B SaaS e-commerce platform on AWS for around 50k users, with Stripe payments and a small team." },
  { label: "<b>Brownfield</b> · Migrate a legacy Java monolith on Oracle to microservices", text: "We run a legacy Java monolith (~800k LOC on WebLogic + Oracle). Plan an incremental migration to microservices without a big-bang rewrite." },
  { label: "<b>Data</b> · Realtime analytics platform for clickstream events", text: "Design a realtime analytics platform ingesting clickstream events at ~50k events/sec, with both dashboards and sub-second feature serving." },
];

const FOLLOWUPS = [
  { label: "Add a Redis cache", text: "Add a Redis cache" },
  { label: "Make it multi-region", text: "Make it multi-region with disaster recovery" },
  { label: "What are the main risks?", text: "What are the main risks of this design?" },
];

function addMsg(role, html) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  wrap.innerHTML = `
    <div class="msg-avatar">${role === "user" ? "Y" : "A"}</div>
    <div class="msg-body">
      <div class="msg-name">${role === "user" ? "You" : "ArchitectAI"}</div>
      <div class="msg-text"></div>
    </div>`;
  chatMessages.appendChild(wrap);
  const textEl = wrap.querySelector(".msg-text");
  if (html != null) textEl.innerHTML = html;
  scrollChat();
  return wrap;
}

function scrollChat() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function mdLite(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\n/g, "<br>");
}

/* typewriter */
function typeOut(el, text, speed = 9) {
  return new Promise(resolve => {
    const words = text.split(/(\s+)/);
    let i = 0;
    el.innerHTML = `<span class="t"></span><span class="cursor"></span>`;
    const t = el.querySelector(".t");
    const timer = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timer);
        el.innerHTML = mdLite(text);
        scrollChat();
        resolve();
        return;
      }
      t.innerHTML = mdLite(words.slice(0, ++i).join(""));
      scrollChat();
    }, speed);
  });
}

/* fake agent steps */
function runSteps(container, labels) {
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "steps";
    container.insertBefore(box, container.querySelector(".msg-text"));
    let i = 0;
    function next() {
      if (i > 0) {
        const prev = box.children[i - 1];
        prev.classList.remove("running");
        prev.classList.add("done");
      }
      if (i >= labels.length) { resolve(); return; }
      const s = document.createElement("div");
      s.className = "step running";
      s.innerHTML = `<span class="dot"></span><span>${esc(labels[i])}</span>`;
      box.appendChild(s);
      scrollChat();
      i++;
      setTimeout(next, 450 + Math.random() * 450);
    }
    next();
  });
}

/* =====================================================================
   RESPONSES
   ===================================================================== */

function summaryFor(spec, kind, addons) {
  const n = spec.states.target.nodes.length;
  if (kind === "brownfield") {
    return (
      "This is a **brownfield modernisation**, so I've designed it as a strangler-fig programme rather than a rewrite.\n\n" +
      "**Approach:** an API gateway goes in front of the monolith first (zero behaviour change), then domains are extracted one at a time — Orders first, since it has the clearest boundary and highest change rate. Debezium CDC taps Oracle's redo logs so new services get legacy data without touching monolith code. Every cutover is a gateway routing change, instantly reversible.\n\n" +
      "Use the **Current state / Target state** toggle above the diagram to compare. The Design Doc has the full decision log, risk register (note the Oracle licensing flag), and a 6-quarter migration roadmap.\n\n" +
      "What would you like to pressure-test — the extraction order, the data strategy, or the team topology?"
    );
  }
  if (kind === "data") {
    return (
      "I've designed a **streaming-first lakehouse** — one ingestion backbone (Kafka) feeding both the realtime path (Flink) and the analytical path (Iceberg → dbt → warehouse), so you avoid maintaining two parallel pipelines.\n\n" +
      "Key call: open table formats on S3 mean your raw data is never locked into one warehouse vendor. The Design Doc covers freshness targets, governance (schema registry is non-negotiable), and a phased rollout that ships dashboards before the harder realtime path.\n\n" +
      "Want me to adjust for a different scale, add ML feature serving, or talk through the Flink-vs-micro-batch trade-off?"
    );
  }
  const extras = [];
  if (addons.has("payments")) extras.push("a PCI-isolated payments service fronting Stripe");
  if (addons.has("ai")) extras.push("an AI service with vector search and an LLM provider behind a guardrail layer");
  if (addons.has("realtime")) extras.push("a dedicated WebSocket gateway for realtime features");
  if (addons.has("mobile")) extras.push("a mobile client sharing the same API gateway");
  if (addons.has("search")) extras.push("OpenSearch with async indexing");
  return (
    `Here's a first-pass design — **${n} components** across clients, edge, application, data, and async tiers.\n\n` +
    "**Shape:** a modular monolith on managed AWS services. At this stage, one well-structured deployable beats microservices — you get speed now and clean seams (gateway, event bus) to split along later." +
    (extras.length ? `\n\nFrom your description I also included ${extras.join("; ")}.` : "") +
    "\n\nThe **Design Doc** tab has the decision log with rationale, NFR targets, risks, and a 12-week delivery plan; the **Spec** tab has the machine-readable version.\n\nRefine it in plain language — e.g. *“add a Redis cache”*, *“make it multi-region”*, or *“remove the workers”*."
  );
}

async function handleInput(text) {
  if (busy) return;
  busy = true;
  $("btn-send").disabled = true;
  $("chat-empty").style.display = "none";
  $("followup-chips").innerHTML = "";

  addMsg("user", esc(text));
  const aiMsg = addMsg("ai", "");
  const body = aiMsg.querySelector(".msg-body");
  const textEl = aiMsg.querySelector(".msg-text");

  // refinement of an existing design?
  if (activeSpec) {
    for (const r of REFINEMENTS) {
      const m = text.match(r.match);
      if (m) {
        await runSteps(body, ["Reviewing current design", "Applying change", "Updating diagram & doc"]);
        const reply = r.apply(activeSpec, m);
        activeSpec._version = (activeSpec._version || 1) + 1;
        renderAll();
        await typeOut(textEl, reply);
        showFollowups();
        done();
        return;
      }
    }
  }

  // new design
  const kind = classify(text);
  const addons = detectAddons(text);
  const steps =
    kind === "brownfield"
      ? ["Parsing constraints & legacy estate", "Mapping current-state architecture", "Selecting modernisation strategy", "Drafting target state & migration plan"]
      : ["Parsing requirements", "Identifying components & tiers", "Selecting reference architecture", "Drafting diagram & design doc"];

  await runSteps(body, steps);

  activeSpec =
    kind === "brownfield" ? brownfieldSpec(text)
    : kind === "data" ? dataPlatformSpec(text)
    : greenfieldSpec(text, addons);
  activeSpec._version = 1;
  activeState = "target";

  renderAll();
  await typeOut(textEl, summaryFor(activeSpec, kind, addons));
  showFollowups();
  done();
}

function showFollowups() {
  const host = $("followup-chips");
  host.innerHTML = "";
  for (const f of FOLLOWUPS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.innerHTML = f.label;
    b.onclick = () => { submitText(f.text); };
    host.appendChild(b);
  }
}

function done() {
  busy = false;
  $("btn-send").disabled = false;
  $("chat-text").focus();
}

/* =====================================================================
   WORKSPACE RENDERING
   ===================================================================== */

function renderAll() {
  if (!activeSpec) return;
  $("ws-placeholder").style.display = "none";

  // state toggle for brownfield
  const toggle = $("state-toggle");
  if (activeSpec.states.current) {
    toggle.hidden = false;
    toggle.querySelectorAll(".state-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.state === activeState));
  } else {
    toggle.hidden = true;
    activeState = "target";
  }

  const state = activeSpec.states[activeState] || activeSpec.states.target;
  $("diagram-host").innerHTML = renderSVG(state);
  renderDoc(activeSpec);
  $("spec-host").textContent = JSON.stringify(
    { title: activeSpec.title, scenario: activeSpec.scenario, version: activeSpec._version, states: activeSpec.states },
    null, 2);
}

/* =====================================================================
   WIRING
   ===================================================================== */

function submitText(text) {
  if (!text.trim() || busy) return;
  $("chat-text").value = "";
  autosize();
  handleInput(text.trim());
}

$("chat-form").addEventListener("submit", e => {
  e.preventDefault();
  submitText($("chat-text").value);
});

$("chat-text").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitText($("chat-text").value);
  }
});

function autosize() {
  const t = $("chat-text");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}
$("chat-text").addEventListener("input", autosize);

// starter chips
for (const s of STARTERS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.innerHTML = s.label;
  b.onclick = () => submitText(s.text);
  $("starter-chips").appendChild(b);
}

// tabs
$("ws-tabs").addEventListener("click", e => {
  const btn = e.target.closest(".ws-tab");
  if (!btn) return;
  document.querySelectorAll(".ws-tab").forEach(t => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".ws-pane").forEach(p =>
    p.classList.toggle("active", p.id === "pane-" + btn.dataset.tab));
});

// state toggle
$("state-toggle").addEventListener("click", e => {
  const btn = e.target.closest(".state-btn");
  if (!btn || !activeSpec) return;
  activeState = btn.dataset.state;
  renderAll();
});

// new design
$("btn-new").addEventListener("click", () => {
  activeSpec = null;
  chatMessages.innerHTML = "";
  $("chat-empty").style.display = "";
  $("followup-chips").innerHTML = "";
  $("ws-placeholder").style.display = "";
  $("diagram-host").innerHTML = "";
  $("doc-host").innerHTML = "";
  $("spec-host").textContent = "";
  $("state-toggle").hidden = true;
});

// exports
$("btn-svg").addEventListener("click", () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  const state = activeSpec.states[activeState] || activeSpec.states.target;
  // inline the styles so the standalone SVG renders correctly
  const css = `
    .zone-rect{fill:rgba(0,0,0,0.02);stroke:#cbd2e0;}
    .zone-label{fill:#6b7385;font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;}
    .node-label{fill:#1d2333;font-size:12.5px;font-weight:600;}
    .node-sub{fill:#6b7385;font-size:10.5px;}
    .node-badge{font-size:9px;font-weight:700;letter-spacing:.8px;}
    .edge-path{fill:none;stroke:#8a93a8;stroke-width:1.5;}
    .edge-path.dashed{stroke-dasharray:5 4;}
    .edge-label-bg{fill:#ffffff;opacity:.92;}
    .edge-label{fill:#6b7385;font-size:10px;}
    .node-g,.edge-g{opacity:1;}`;
  let svg = renderSVG(state, { animate: false });
  svg = svg.replace("<defs>", `<style>${css}</style><rect width="100%" height="100%" fill="#ffffff"/><defs>`);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "architectai-design.svg";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("btn-json").addEventListener("click", async () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  try {
    await navigator.clipboard.writeText($("spec-host").textContent);
    toast("Spec JSON copied to clipboard");
  } catch {
    toast("Clipboard unavailable — use the Spec tab to copy manually.");
  }
});

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}
