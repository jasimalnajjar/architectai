# ArchitectAI — MVP Mockup

**Describe it. Design it. Build it.** An AI-native alternative to diagrams.net
for solution architects: you describe a system in natural language (greenfield
or brownfield), and get back a structured solution design — an architecture
diagram, a written design doc with decisions/risks/costs/roadmap, and the
**engineering hand-off pack**: Terraform/CloudFormation, ADRs, and a
Jira-ready backlog. The output isn't a picture; it's a head start on the build.

This repo is a **clickable MVP mockup**, not the product. The "AI" is simulated
with scripted scenarios and keyword heuristics so the full product experience can
be evaluated — and shown to potential users — before building any backend.

## Run it

No build, no dependencies — it's a static page:

```bash
# open directly
open index.html            # macOS
xdg-open index.html        # Linux

# or serve it
python3 -m http.server 8000   # then visit http://localhost:8000
```

## What the mockup demonstrates

The core product loop:

```
natural language ──→ structured spec (JSON) ──→ diagram + design doc
        ↑                                              │
        └────────────── iterative refinement ──────────┘
```

1. **ChatGPT-style interface.** Describe a system in the chat. The "agent" shows
   working steps, streams its answer, and populates the workspace.
2. **Three deep scenarios** (use the starter chips):
   - **Greenfield** — SaaS platform; keyword-aware (mentions of payments, AI/ML,
     realtime, mobile, search each add the right components and decisions).
   - **Brownfield** — legacy Java/Oracle monolith migration with a
     **Current state / Target state** diagram toggle, strangler-fig strategy,
     and a 6-quarter migration roadmap.
   - **Data platform** — streaming-first lakehouse design.
3. **Four synchronized views** of every design:
   - **Diagram** — auto-laid-out, zoned architecture diagram (SVG). **Every
     component is clickable**: a spec drawer shows its purpose, sizing, HA
     posture, security notes, indicative monthly cost, and a per-service
     Terraform/CloudFormation snippet (copy or download).
   - **Design Doc** — overview, decision log with rationale, component + run
     cost table with total, NFRs, risk register with severity, phased
     delivery/migration plan.
   - **Build** — the hand-off pack, generated from the spec:
     - *Terraform* — full skeleton for the target state, with TODOs where org
       standards (state backend, VPC module, tagging) plug in; clients, SaaS
       and legacy estate are listed but deliberately excluded
     - *CloudFormation* — same design for CFN shops, gaps flagged
     - *ADRs* — one Architecture Decision Record per design decision
       (Context / Decision / Consequences)
     - *Backlog* — epics mapped to delivery phases + provisioning and
       implementation stories, downloadable as CSV for Jira import
   - **Spec (JSON)** — the structured intermediate representation. This is the
     key architectural idea: the LLM emits a spec, and diagram + doc + IaC are
     deterministic renderings of it. Diffable, versionable, reviewable.
4. **Iterative refinement in plain language.** With a design open, try:
   - *"Add a Redis cache"* · *"Add a CDN"* — diagram, decision log, cost table,
     and Terraform all update together
   - *"Make it multi-region"* — adds DR posture **and** records the
     warm-standby-vs-active-active trade-off in the doc
   - *"Remove the workers"* — deletes a component and its edges
   - *"What are the main risks?"* — answers from the design's risk register
   - *"Generate the build pack"* — opens the Build tab with a guided summary
5. **Exports** — diagram as standalone SVG, spec JSON, `main.tf`,
   `template.yaml`, `adrs.md`, `backlog.csv`, plus per-component IaC snippets.

## What's real vs. mocked

| Layer | In this mockup | In the real product |
|---|---|---|
| Intent understanding | Keyword classifier | LLM (e.g. Claude) with a system prompt encoding architecture practice |
| Design generation | 3 hand-written scenario specs | LLM emits the same spec JSON, grounded in reference architectures |
| Refinement | ~6 regex-matched mutations | LLM edits the spec; renderer is unchanged |
| Diagram rendering | Deterministic SVG layout engine | Same (this code is reusable) |
| Design doc | Template over the spec | LLM-written, structured by the same template |
| Service catalog & IaC | ~30 hand-curated entries with HCL/CFN snippets | A governed catalog (org-approved modules, golden paths); the LLM selects and parameterises — it never freestyles HCL |
| Cost estimates | Static per-component numbers | Live pricing APIs + usage assumptions from the conversation |
| Backlog | Template stories per component/phase | LLM-drafted, pushed to Jira/ADO via API |
| Persistence/sharing | None | Projects, versions, share links, export to Confluence/Markdown |

## Why the spec-as-intermediate-representation matters

The mockup deliberately routes everything through a JSON spec rather than having
the AI "draw". That's the moat-shaped decision to validate:

- **Determinism** — the same spec always renders the same diagram; no LLM
  hallucination in the visual layer.
- **Diffability** — design reviews become spec diffs; v1 → v2 of an
  architecture is a readable changeset.
- **Round-tripping** — future: import existing estates (Terraform state, AWS
  Config, drawio XML) into the spec, making brownfield current-state capture
  automatic instead of manual.
- **Multi-rendering** — one spec → C4 views, sequence diagrams, cost models,
  Terraform skeletons.

## Suggested path from mockup → product

1. **Validate** — put this mockup in front of 5–10 solution architects; watch
   which tab they live in (diagram vs. doc) and what refinements they attempt.
2. **Thin slice with a real LLM** — replace `classify()`/scenario functions in
   `app.js` with a single Claude API call that emits the existing spec format
   (the renderer already works). One endpoint, no DB.
3. **Brownfield ingestion** — the differentiator vs. "ChatGPT + Mermaid":
   import Terraform/cloud inventory to auto-build current state.
4. **Collaboration layer** — projects, versioning, review comments, exports.

## Repo layout

```
index.html   app shell (chat panel + workspace)
styles.css   dark theme, diagram styling
app.js       scenario library, spec format, SVG layout engine, mock agent
```
