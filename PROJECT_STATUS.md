# Project Status

**Current phase:** 5b — content generation complete; no publishing capability exists

## Completed

- Phase 1 repository audit, architecture, integration inventory, risk register and agent instructions.
- Phase 1 documents committed and synchronized to GitHub as `24c734e`.
- Phase 2 foundation scaffold: Node/TypeScript workspace, governance policy engine, immutable audit/outbox interfaces, initial PostgreSQL migration, CI validation, and offline-safe configuration.
- Phase 2 foundation committed and synchronized to GitHub as `e9204af` after policy tests passed.
- Phase 3 claim/evidence lifecycle, content-claim citation validation, and non-publishing content control-plane schema implemented and validated locally.
- Phase 4 offline integration foundation implemented: provider contracts, read-only/sandbox mode enforcement, raw-body Shopify/Meta webhook HMAC verification, replay-safe idempotent webhook admission, and privacy-minimised connection/webhook persistence migrations.
- **Action 1 runtime data layer (this change).** The repository now runs against a real database instead of in-memory fixtures:
  - `pg` dependency, connection pool, and a `withTransaction` helper so a domain mutation commits atomically with its audit and outbox rows.
  - Checksum-verified migration runner with an advisory lock, per-migration transactions, and refusal to re-run an edited migration. Applied versions are tracked in `schema_migrations`.
  - Docker Compose PostgreSQL 16 for local development, published on port 5433.
  - Real `PostgresAuditRepository`, `PostgresOutboxRepository` and `PostgresIdempotencyRepository` implementing the existing domain ports.
  - Idempotent seed of the `AGENTS.md` approved claim catalogue for Masala Tea, with deterministic UUIDv5 keys, evidence links, and audit events written only for values that changed.
  - 46 tests pass, including integration tests executed against a real PostgreSQL instance. CI now runs a PostgreSQL service with `REQUIRE_DB_TESTS=true` so a missing database fails the build rather than skipping coverage.
  - Runbook added at `docs/runbooks/database.md`.

- **Action 2 content generation (this change).** `packages/ai` generates, validates and routes Instagram concepts for human review:
  - `GenerationProvider` interface so the AI provider is configuration, not code. Three implementations: Ollama (local, open source, free), Anthropic (highest quality, strict tool use for structured output), and a deterministic offline generator for tests and offline development.
  - Approved-claim retrieval that can only see claims that are `approved` with evidence, hashed into `retrieval_snapshots` for provenance.
  - Structured concept schema: hook, caption, visual brief, CTA, trial offer, social-proof angle, hashtags, cited claim IDs, rationale, format and objective.
  - Four recorded validation checks per concept: claim citation, prohibited terms, channel limits, and a trial lever.
  - Persistence into `content_drafts` with per-check results, citations, generation-run provenance and audit events. Failing drafts are kept as `failed` rather than discarded.
  - CLI review and approval workflow enforcing segregation of duties through the existing approval engine.
  - Runbook at `docs/runbooks/content-generation.md`. 90 tests pass, including 14 integration tests against real PostgreSQL.

## Current work

- Action 3 (not started): Instagram publishing adapter and Cloudflare R2 media hosting.

## Next work

- Action 3: Instagram publishing adapter and Cloudflare R2 media hosting, after Meta developer app and long-lived token provisioning. This requires the narrow, approval-bound replacement of the blanket production-write block described under Blockers.
- Link the repository to the released Shopify Dev Dashboard app and verify read-only product/order/content access after supported Shopify account authentication is available.
- Implement the real Shopify read-only adapter and add reconciliation/contract tests.

## Content generation status

- Generation, validation, persistence and human approval work end to end against a real database.
- No Instagram, Meta, or creative-image capability exists. Approving a draft records a human release decision bound to a payload hash; it sends nothing.
- On Git Bash for Windows, `npm run <script> -- ...` silently drops the invocation when an argument contains a space. Use PowerShell or call node directly. Documented in the runbook.

## Data and claim status

- 11 claims are seeded for the hero SKU (Masala Tea): **10 approved**, **1 withheld**.
- The withheld claim is "Ethically Grown: farming best practices as per Tea Board of India or trustee certification requirements". It is seeded as `compliance_review`, not `approved`, because owner decision 1 in `docs/ARCHITECTURE.md` §17 records its meaning, evidence and public usability as unresolved. The content validator therefore refuses to let generated copy cite it. **Owner action is required to release it.**
- Evidence is limited to two honest sources: the owner-authored catalogue in `AGENTS.md` and the printed 200g retail packet. No certification evidence is recorded, and the test suite fails if any is introduced.
- `claims.approved_by` holds a deterministic placeholder actor ID because there is no users table yet. It must be reconciled with a real owner account when identity is implemented.

## Blockers

- **`packages/domain/src/policy.ts` structurally prevents publishing.** `canExecute` returns false for every external write in `production` before approvals are evaluated, and `assertReadOnlyConnection` rejects `write` mode outright. Going live requires replacing the blanket block with a narrow, per-connection, approval-bound write allowance, as its own reviewed commit. This is not yet done and is intentionally not part of Action 1.
- Meta: an Instagram Business/Creator account and a linked Facebook Page exist. A Meta developer app, `instagram_content_publish` scope, and a long-lived token do not yet exist. This is the critical path for the first live post.
- Instagram's Content Publishing API accepts only a public HTTPS media URL, so Cloudflare R2 (selected) must be provisioned before any creative can be published.
- Higgsfield is the selected creative layer, but it is currently reachable only as an interactive MCP server. A documented HTTP API and key must be confirmed before unattended automation depends on it; the creative layer will be built behind an interface so the provider can be swapped.
- No model provider is currently configured. Content generation runs today only on the deterministic offline generator, which produces placeholder copy, not publishable marketing. Configuring Ollama or an Anthropic credential is required before any generated copy is worth reviewing on its merits.
- Ollama support is implemented against its documented `/api/chat` structured-output contract but has **not been verified against a live model**: pulling the image exhausted the host disk and crashed Docker Desktop, so the run was abandoned. Treat the Ollama path as unverified until a pull succeeds.
- No staging or production database is provisioned. Local development and CI both run PostgreSQL 16.
- GitHub synchronization works through Git Credential Manager. `origin` is `https://github.com/yaduvirsingh82-lab/pahaltea-growth-engine.git`.
- A public, read-only storefront check confirms that PahalTea.com is Shopify-powered. This does not establish store ownership, API access, approved scopes, or permission to ingest production data.
- The Shopify Dev Dashboard app "Pahal Tea Growth Engine" has been created, version 2 released, and installed on the development store. Shopify CLI 4.7.0 is installed locally. Its standard login/link commands require an interactive terminal or an existing session alias in this environment. No Shopify API request has been sent.

## Approval required

- **Owner decision 1 in `docs/ARCHITECTURE.md`** — resolve the "Ethically Grown" claim so it can move from `compliance_review` to `approved`, or confirm it stays withheld.
- Before production use: all remaining owner decisions in `docs/ARCHITECTURE.md`, especially claim-evidence standards, legal/privacy retention, named approvers, platform ownership, and execution thresholds.
- Before any external integration: the applicable account, credentials, scopes, sandbox/production authorisation, and signed approval policy.
- Before publishing: the reviewed policy change that narrows the production-write block, plus a recorded approval bound to the exact payload.
- For Shopify: authenticate the CLI to the Dev Dashboard app-owner account via `shopify auth login`, then `shopify app config link`. Confirm the released app version has only the required read scopes (`read_products`, `read_orders`, and the approved content scope, if applicable) before API verification.
