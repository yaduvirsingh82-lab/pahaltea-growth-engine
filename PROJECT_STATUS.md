# Project Status

**Current phase:** 4 — Read-only data integrations (blocked pending account/platform authorisation)

## Completed

- Phase 1 repository audit, architecture, integration inventory, risk register and agent instructions.
- Phase 1 documents committed locally as `24c734e`.
- Phase 2 foundation scaffold: Node/TypeScript workspace, governance policy engine, immutable audit/outbox interfaces, initial PostgreSQL migration, CI validation, and offline-safe configuration.
- Phase 2 foundation committed locally as `e9204af` after policy tests passed.
- Phase 3 claim/evidence lifecycle, content-claim citation validation, and non-publishing content control-plane schema implemented and validated locally.

## Current work

- Await the platform confirmation and sandbox/read-only credentials needed for the first integration adapters.

## Next work

- Implement read-only Shopify and Meta/Instagram adapters, webhook verification, reconciliation, and contract tests after accounts are authorised.
- Then proceed to Phase 5 reporting and recommendation workflows using only ingested/sandbox data.

## Blockers

- GitHub push is blocked because this environment has no GitHub credentials (`SEC_E_NO_CREDENTIALS`). Local commits are being created; no remote changes can be made until authenticated Git credentials are available.
- A database connection is not configured. Migrations are present but no database is provisioned or contacted.
- A public, read-only storefront check confirms that PahalTea.com is Shopify-powered. This does not establish store ownership, API access, approved scopes, or permission to ingest production data.
- Phase 4 cannot start safely: no owner-authorised Shopify/Meta sandbox or read-only accounts/credentials exist. Per policy, no authenticated production systems will be contacted.

## Approval required

- Before production use: all owner decisions in `docs/ARCHITECTURE.md`, especially claim-evidence standards, legal/privacy retention, named approvers, platform ownership, and execution thresholds.
- Before any external integration: the applicable account, credentials, scopes, sandbox/production authorisation, and signed approval policy.
