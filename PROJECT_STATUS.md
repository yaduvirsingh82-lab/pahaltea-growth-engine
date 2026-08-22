# Project Status

**Current phase:** 4 — Read-only data integrations (live connection blocked pending account authorisation)

## Completed

- Phase 1 repository audit, architecture, integration inventory, risk register and agent instructions.
- Phase 1 documents committed and synchronized to GitHub as `24c734e`.
- Phase 2 foundation scaffold: Node/TypeScript workspace, governance policy engine, immutable audit/outbox interfaces, initial PostgreSQL migration, CI validation, and offline-safe configuration.
- Phase 2 foundation committed and synchronized to GitHub as `e9204af` after policy tests passed.
- Phase 3 claim/evidence lifecycle, content-claim citation validation, and non-publishing content control-plane schema implemented and validated locally.
- Phase 4 offline integration foundation implemented: provider contracts, read-only/sandbox mode enforcement, raw-body Shopify/Meta webhook HMAC verification, and replay-safe idempotent webhook admission.

## Current work

- Await sandbox/read-only Shopify and Meta credentials, account ownership confirmation, scopes, and approved connection records to activate live ingestion.

## Next work

- Implement read-only Shopify and Meta/Instagram adapters, webhook verification, reconciliation, and contract tests after accounts are authorised.
- Then proceed to Phase 5 reporting and recommendation workflows using only ingested/sandbox data.

## Blockers

- GitHub synchronization is working through Git Credential Manager. `origin` is `https://github.com/yaduvirsingh82-lab/pahaltea-growth-engine.git`; the existing history through `7c76395` was fast-forwarded to `origin/main` without force-pushing and verified remotely.
- A database connection is not configured. Migrations are present but no database is provisioned or contacted.
- A public, read-only storefront check confirms that PahalTea.com is Shopify-powered. This does not establish store ownership, API access, approved scopes, or permission to ingest production data.
- Phase 4 live ingestion cannot start safely: no owner-authorised Shopify/Meta sandbox or read-only accounts/credentials exist. The offline adapter foundation is complete; no authenticated production system has been contacted.

## Approval required

- Before production use: all owner decisions in `docs/ARCHITECTURE.md`, especially claim-evidence standards, legal/privacy retention, named approvers, platform ownership, and execution thresholds.
- Before any external integration: the applicable account, credentials, scopes, sandbox/production authorisation, and signed approval policy.
