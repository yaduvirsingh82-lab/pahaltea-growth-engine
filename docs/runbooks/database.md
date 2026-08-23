# Runbook — database, migrations and the claim catalogue seed

Scope: local development and CI. No staging or production database is provisioned.

## Start a local database

```bash
cp .env.example .env          # non-secret local values only
npm run db:up                 # docker compose, waits for a healthy container
npm run db:migrate
npm run db:seed
```

The container publishes port **5433** by default, not 5432, because 5432 is
frequently already bound by another local stack. Override with `PAHALTEA_DB_PORT`.

| Command | Effect |
| --- | --- |
| `npm run db:up` / `db:down` | Start / stop the local Postgres container |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Write the approved claim catalogue (idempotent) |
| `npm run db:reset` | Destroy the volume and rebuild from scratch |
| `npm run validate` | Syntax check plus the full test suite |

## How migrations behave

- Files must be named `NNNN_snake_case.sql` in `packages/db/migrations/`.
- Applied versions are recorded in `schema_migrations` with a SHA-256 checksum
  of the file, normalised for line endings so Windows and CI agree.
- Each migration runs in its own transaction with its ledger row. A failure
  rolls back and is **not** recorded, so the database stays on the last fully
  applied version rather than half-migrated.
- A `pg_advisory_lock` prevents two runners migrating at once.
- **Editing an applied migration is refused.** The runner compares checksums and
  fails with an instruction to add a new migration instead.

### Rollback

There are no down-migrations by design; a reversal is a new forward migration.
Locally, `npm run db:reset` rebuilds from an empty volume. Any production schema
change is an approval-gated release action, and both `db:migrate` and `db:seed`
refuse to run against `APP_ENV=production` without `--allow-production` and a
recorded approval.

## The claim catalogue seed

`packages/db/src/seed/catalogue.ts` is a transcription of the "Source of truth
for product claims" section of `AGENTS.md`. It is not editorial copy and must
not be broadened, rephrased, or extended without an owner decision.

- Rows use deterministic UUIDv5 keys, so re-seeding updates the same records.
- Audit events are appended only for values that actually changed; a no-op
  re-seed writes nothing.
- A changed claim bumps its `version` and is re-audited.
- `packages/db/test/catalogue.test.ts` parses `AGENTS.md` directly and fails if
  the seed drifts from it or invents a fact it does not permit.

### One claim is deliberately withheld

**"Ethically Grown: farming best practices as per Tea Board of India or trustee
certification requirements"** is seeded as `compliance_review`, not `approved`,
because owner decision 1 in `docs/ARCHITECTURE.md` §17 records its meaning,
evidence, and public usability as unresolved. The domain validator therefore
refuses to let generated content cite it. To release it, the owner must resolve
that decision; the seed then only needs its `status` changed to `approved`.

`approved_by` currently holds a deterministic placeholder actor ID
(`BRAND_OWNER_ACTOR_ID`) because there is no users table yet. When identity
lands, reconcile it with the real owner account rather than leaving it orphaned.

## Repositories

`PostgresAuditRepository`, `PostgresOutboxRepository`, and
`PostgresIdempotencyRepository` all accept a `Queryable`, so a caller can pass an
in-transaction client and commit a domain mutation together with its audit and
outbox rows. Use `withTransaction(pool, ...)` for that.

- Audit writes are append-only in the database, not only in application code: a
  trigger rejects `UPDATE` and `DELETE` on `audit_events`.
- Outbox enqueue is idempotent on `idempotency_key`; a retry cannot create a
  second external side effect. Nothing dispatches from the outbox yet.
- `IdempotencyRepository.reserve` is a single atomic statement. Concurrent
  callers produce exactly one winner; an expired reservation is reclaimable.

## Tests

Integration tests each build an isolated, migrated schema and drop it
afterwards, so they never touch a developer's seeded data. They skip when
`DATABASE_URL` is unset. CI sets `REQUIRE_DB_TESTS=true`, which turns a missing
database into a build failure so coverage cannot silently disappear.
