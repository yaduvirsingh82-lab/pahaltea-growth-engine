# Pahal Tea Growth Engine — Agent Instructions

## Mission and scope

Build an approval-first, auditable growth-operations platform for Pahal Tea. The platform may analyse data and draft recommendations autonomously, but it must never autonomously take regulated, customer-facing, spend-changing, destructive, or production actions.

## Source of truth for product claims

Use only approved records in the application's claim catalogue. Until business owners approve a richer catalogue, the permitted facts for Masala Tea are:

- Origin/garden: Assam
- Tea grade/type: Amchong
- Ingredients: Tea & Spices
- Exact spice composition: refer to product packet
- Spice sourcing: reliable sources
- No added flavours, colours, preservatives, or additives
- Garden Fresh: directly from where the tea is grown
- Ethically Grown: farming best practices as per Tea Board of India or trustee certification requirements
- Blended with Expertise: composition of spices, grades of tea, and best flush of production
- Tea/blending experience: founder's experience in tea
- Hero SKU: Masala Tea; current pack: 200g (not a permanent commercial fact)

Never invent or imply certifications, awards, health or wellness benefits, exact spice compositions, provenance beyond the approved wording, comparative claims, or sustainability claims. Claims need evidence, owner, jurisdiction/channel, status, version, and an explicit approval before use.

## Non-negotiable approval gates

Require recorded human approval before:

- increasing advertising spend above configured limits;
- material campaign/audience/bid/creative changes;
- any public response to a complaint or crisis;
- creating or publishing a new claim, or using a claim without approved supporting evidence;
- production deployment;
- deletion, irreversible mutation, credential rotation, or other destructive action.

Drafting, analysis, simulation, staging, and dry-run work may proceed only when clearly labelled as such. Never bypass a gate because an integration token permits the action.

## Safety and integrations

- Default every external integration to read-only, sandbox, draft, or dry-run mode.
- Do not contact customers or publish content/ads without an approved execution record.
- Do not place orders, spend money, alter the storefront, or connect to production systems unless the task explicitly authorises it and the required approval exists.
- Keep secrets only in a managed secret store. Never commit `.env` files, API tokens, customer data, exports, webhook payloads, or private keys.
- Verify webhook signatures, enforce idempotency, use least-privilege OAuth scopes, and retain an immutable audit event for all attempted side effects.

## Engineering conventions

- Prefer a modular monolith with a typed API and PostgreSQL first; do not introduce microservices without a demonstrated operational need.
- Treat integrations as adapters behind interfaces. Queue all external writes through an outbox/job system.
- Make tenant/brand boundaries explicit even while Pahal Tea is the only brand.
- Add migrations, tests, structured logs, observability, and rollback notes with each production-capable change.
- Never put business facts in prompts or source code when they belong in versioned approved data.

## Required checks before delivery

- Inspect existing changes first; preserve user work.
- Run the relevant formatter, type checker, unit tests, and migration validation when code changes.
- Verify that a change cannot bypass approval policy or publish in a non-production environment.
- Report changed files, validation run, unresolved risks, and any required owner decision.

## Documentation

Keep architecture, integration scopes, data handling, approval policy, runbooks, and decision records current. Mark assumptions as assumptions and route material commercial/legal decisions to the owner.
