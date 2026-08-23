# Runbook — publishing the first Instagram post

Goal: get one approved Pahal Tea creative live on Instagram.

Everything in the repository is built and tested. What remains is a Meta
developer app and a Cloudflare R2 bucket — both are account setup, not code.

## Where we are

| Step | State |
| --- | --- |
| Generate and approve a draft | Working (`npm run content:generate`, `npm run content:review`) |
| Dry-run publish | Working (`npm run meta:publish -- --draft <id>`) |
| Meta preflight | Working, reports the exact gate (`npm run meta:verify`) |
| Live publish | Implemented and tested; **blocked on credentials** |

## Part 1 — Meta setup (do this yourself; roughly 30 minutes)

You already have the Instagram professional account and a linked Facebook Page,
so this is only the app and token.

**1. Confirm the Instagram account is Business or Creator.**
Instagram app → Settings → Account type and tools. A personal account cannot be
published to by the API.

**2. Confirm the Page link.**
Meta Business Suite → Settings → Accounts → Instagram accounts. The Instagram
account must be connected to the Pahal Tea Facebook Page.

**3. Create the app.**
[developers.facebook.com](https://developers.facebook.com) → My Apps → Create App
→ use case **Other** → type **Business** → name it "Pahal Tea Growth Engine".
Create only one app; do not duplicate it if one already exists.

**4. Add the Instagram product.**
In the app dashboard, add **Instagram** → *Instagram API setup with Facebook
Login*. Keep the app in Development mode: your own assets can be published to
without App Review while you are an admin of the app.

**5. Note the app credentials.**
App settings → Basic. Copy the **App ID** and **App Secret**.

**6. Generate a token with the right scopes.**
Tools → **Graph API Explorer**. Select your app, then "Get User Access Token",
and tick exactly:

```
instagram_basic
instagram_content_publish
pages_read_engagement
pages_show_list
```

Generate, and accept the dialog for the Pahal Tea Page.

**7. Exchange it for a long-lived token.**
The Explorer token lasts about an hour. In Tools → **Access Token Debugger**,
paste the token and click **Extend Access Token** to get a ~60-day token. Copy
that one.

**8. Find the Instagram account id.**
You can skip this — set `META_PAGE_ID` instead and `npm run meta:verify` will
discover the Instagram id from the Page and print it.

## Part 2 — Cloudflare R2 (roughly 10 minutes)

Instagram fetches the image from a URL; there is no upload endpoint. The bucket
must therefore be publicly readable.

1. Cloudflare dashboard → **R2** → Create bucket, e.g. `pahaltea-creatives`.
2. Bucket → Settings → **Public access** → either connect a custom domain
   (`media.pahaltea.com`) or enable the managed `r2.dev` subdomain. Copy that
   public base URL.
3. R2 → **Manage API tokens** → Create token with **Object Read & Write** scoped
   to that bucket. Copy the Access Key ID and Secret Access Key.
4. Note your Cloudflare **Account ID** from the R2 overview page.

## Part 3 — configure and verify

Put these in `.env` (gitignored; never commit it):

```bash
META_APP_ID=...
META_APP_SECRET=...
META_ACCESS_TOKEN=...        # the long-lived one
META_PAGE_ID=...             # or META_IG_USER_ID if you have it

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=pahaltea-creatives
R2_PUBLIC_BASE_URL=https://media.pahaltea.com
```

Then:

```bash
npm run meta:verify
```

It makes real Graph calls and prints a pass/fail line per check: token validity
and scopes, Instagram account reachability, the granted-versus-required
permission diff, and your publishing quota. Fix whatever it marks FAIL and re-run.

## Part 4 — publish one post

```bash
# 1. Generate concepts and approve one (creator cannot approve their own draft)
npm run content:generate -- --count 5
npm run content:review
npm run content:review -- --show <draft-id>
npm run content:review -- --approve <draft-id> --reviewer <your-uuid> --role marketing_approver

# 2. Dry run — contacts nobody, prints the exact requests a live run would send
npm run meta:publish -- --draft <draft-id>

# 3. Record the owner-approved write connection
npm run meta:connect -- --owner <your-uuid> --mode write

# 4. Publish for real
WRITE_ACTIONS_ENABLED=true npm run meta:publish -- --draft <draft-id> --live --image creative.jpg
```

The creative must be a **JPEG**. A renamed PNG is rejected by a magic-number
check before anything is uploaded.

> On Git Bash, `npm run <script> -- ...` drops the invocation when an argument
> contains a space. Use PowerShell, or call node directly.

## Gates on a live publish

Each is enforced in code and covered by a test:

1. The draft is `approved`.
2. The approval is bound to a hash of the copy **as it stands now**. Editing the
   caption after approval invalidates it and it must be re-approved.
3. An enabled, owner-approved `instagram` connection in `write` mode exists.
4. `WRITE_ACTIONS_ENABLED=true`.
5. The file is a real JPEG.
6. The uploaded URL is confirmed publicly reachable before Meta is called.
7. The same draft and copy have not already been submitted — an idempotency
   reservation plus a unique index allowing one live publication per draft.

## When something fails

| Symptom | Cause |
| --- | --- |
| `meta:verify` says a scope is missing | Regenerate the token in Graph API Explorer with all four scopes ticked. |
| Container status `ERROR` | Meta could not fetch or decode the image. Check the URL is public and the file is JPEG. |
| `HTTP 403` from the media URL | The R2 bucket is not publicly readable. |
| `The user is not an admin of the page` | The token was issued for an account without a Page admin role. |
| Token stops working after ~60 days | Long-lived tokens expire. Re-extend it in the Access Token Debugger. |

## What still does not exist

No paid advertising, no scheduling, no automatic publishing. A post happens only
when a human runs the command with `--live`. `policy.ts` still blocks every
external write when `APP_ENV=production`; the first post is published from a
development or staging environment against the real account, and lifting the
production block is a separate owner decision.
