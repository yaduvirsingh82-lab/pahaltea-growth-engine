# Project Status

**Current phase:** 4 — Shopify read-only integration (blocked pending Shopify account authentication)

## Completed

- Phase 1 repository audit, architecture, integration inventory, risk register and agent instructions.
- Phase 1 documents committed and synchronized to GitHub as `24c734e`.
- Phase 2 foundation scaffold: Node/TypeScript workspace, governance policy engine, immutable audit/outbox interfaces, initial PostgreSQL migration, CI validation, and offline-safe configuration.
- Phase 2 foundation committed and synchronized to GitHub as `e9204af` after policy tests passed.
- Phase 3 claim/evidence lifecycle, content-claim citation validation, and non-publishing content control-plane schema implemented and validated locally.
- Phase 4 offline integration foundation implemented: provider contracts, read-only/sandbox mode enforcement, raw-body Shopify/Meta webhook HMAC verification, replay-safe idempotent webhook admission, and privacy-minimised connection/webhook persistence migrations.

## Current work

- Link the repository to the released Shopify Dev Dashboard app and verify read-only product/order/content access after supported Shopify account authentication is available.

## Next work

- Implement the real Shopify read-only adapter, verify products/orders/content access, and add reconciliation/contract tests after Shopify Dev Dashboard authentication completes.
- Implement Meta/Instagram adapters only after their separately authorised account access is available.
- Then proceed to Phase 5 reporting and recommendation workflows using only ingested/sandbox data.

## Blockers

- GitHub synchronization is working through Git Credential Manager. `origin` is `https://github.com/yaduvirsingh82-lab/pahaltea-growth-engine.git`; the existing history through `7c76395` was fast-forwarded to `origin/main` without force-pushing and verified remotely.
- A database connection is not configured. Migrations are present but no database is provisioned or contacted.
- A public, read-only storefront check confirms that PahalTea.com is Shopify-powered. This does not establish store ownership, API access, approved scopes, or permission to ingest production data.
- The Shopify Dev Dashboard app "Pahal Tea Growth Engine" has been created, version 2 released, and installed on the development store. Shopify CLI 4.7.0 is installed locally, but the non-interactive CLI requires the app client ID and the Dev Dashboard browser is not authenticated. The available login flow requires a Shopify account credential/passkey; no credential or authenticated session is accessible in this environment.
- Phase 4 Shopify live read-only verification cannot start until the browser/CLI is authenticated to the Shopify Dev Dashboard account that owns the app. The offline adapter foundation is complete; no Shopify API request has been sent.
- Meta/Instagram remains separately blocked by account ownership, sandbox/read-only scopes, and managed credentials.

## Approval required

- Before production use: all owner decisions in `docs/ARCHITECTURE.md`, especially claim-evidence standards, legal/privacy retention, named approvers, platform ownership, and execution thresholds.
- Before any external integration: the applicable account, credentials, scopes, sandbox/production authorisation, and signed approval policy.
- For Shopify now: authenticate this environment to the Dev Dashboard app-owner account (via Shopify's login/passkey flow), then the CLI can link the app without exposing a token. Confirm that the released app version has only the required read scopes (`read_products`, `read_orders`, and the approved content scope, if applicable) before API verification.
