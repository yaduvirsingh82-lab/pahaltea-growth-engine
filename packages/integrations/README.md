# Integration adapters

## Meta / Instagram

Publishing an approved content draft to Instagram, and the preflight that proves
the account is reachable first.

| Command | Purpose |
| --- | --- |
| `npm run meta:verify` | Real Graph calls: token validity and scopes, Instagram account reachability, granted-vs-required permissions, publishing quota. Prints the exact remaining gate. |
| `npm run meta:publish -- --draft <id>` | Dry run. Records the plan, contacts nobody. |
| `npm run meta:publish -- --draft <id> --live --image <file.jpg>` | Live publish. Every gate below must hold. |

Credentials live only in the environment. `integration_connections` stores a
credential *reference*, never a token, and tokens are redacted before any error
message is logged.

### Gates on a live publish

All of these must hold, and each is enforced in code with a test:

1. The draft is `approved`.
2. An `approval_decisions` row is bound to a hash of the copy **as it stands now** —
   editing the caption after approval invalidates it.
3. An `integration_connections` row for `instagram` exists, is `enabled`, is
   approved by an owner, and is in `write` mode.
4. `WRITE_ACTIONS_ENABLED=true`.
5. The image is a real JPEG (magic number checked, not just the extension).
6. The uploaded media URL is confirmed publicly reachable before Meta is asked
   to fetch it.
7. The draft and copy have not already been submitted — enforced by an
   idempotency reservation and by a unique index allowing one live publication
   per draft.

`assertReadOnlyConnection` is unchanged and still governs every read path;
`admitWrite` is a separate, additive gate, so enabling publishing cannot loosen
ingestion.

### Contract notes

Verified against Meta's current documentation rather than recollection:

- Publishing is three steps: `POST /{ig-user-id}/media` → poll
  `GET /{container-id}?fields=status_code` until `FINISHED` → `POST
  /{ig-user-id}/media_publish`. Skipping the poll fails on a container that is
  still `IN_PROGRESS`.
- **JPEG only** for feed images.
- Media must be at a **publicly reachable URL**; there is no upload endpoint.
- **100** API-published posts per rolling 24 hours, queryable at
  `GET /{ig-user-id}/content_publishing_limit`.
- Containers expire after 24 hours.
- Two login paths, not interchangeable: Facebook Login (`graph.facebook.com`,
  `instagram_basic` + `instagram_content_publish` + `pages_read_engagement` +
  `pages_show_list`) and Instagram Login (`graph.instagram.com`,
  `instagram_business_basic` + `instagram_business_content_publish`). Facebook
  Login is the default here because Meta Ads later needs it.

## Cloudflare R2

S3-compatible, so `@aws-sdk/client-s3` is reused rather than hand-rolling SigV4.
Objects are content-addressed per draft and stored immutable — a changed image
would invalidate the approval bound to the post.

## What does not exist yet

No paid advertising, no scheduling, no automatic publishing. A publish happens
only when a human runs the command with `--live`.
