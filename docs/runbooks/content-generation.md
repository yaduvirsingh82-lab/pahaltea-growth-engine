# Runbook — Instagram content generation and review

Generates Instagram concepts from approved product claims, validates them, and
routes them through human review. **Nothing here publishes.** The furthest a
draft can travel is `approved`, which records that a human released that exact
payload; no Instagram or Meta call exists yet.

## Quick start

```bash
npm run db:up && npm run db:migrate && npm run db:seed
npm run content:generate -- --count 5
npm run content:review
npm run content:review -- --show <draft-id>
```

> **Git Bash on Windows:** `npm run <script> -- ...` silently drops the entire
> invocation when any argument contains a space (npm 11 quoting). Use PowerShell,
> which handles it correctly, or call node directly from Git Bash:
> `node --experimental-strip-types packages/ai/bin/generate.ts --brief "winter mornings"`.

## Provider selection

Business logic never imports a provider. `GenerationProvider` in
`packages/ai/src/provider.ts` is the only surface the pipeline knows, so
swapping providers is configuration.

| Provider | id | Cost | Notes |
| --- | --- | --- | --- |
| Ollama | `ollama` | Free, local | Open source. Structured output via Ollama's `format` field. Preferred by default. |
| Anthropic | `anthropic` | Per token | Highest quality. Structured output via strict tool use. |
| Offline generator | `offline-template` | Free | Deterministic templates. **Not a model.** Development and tests only. |

Resolution order when `--provider` is not given: Ollama if reachable with the
configured model, then Anthropic if a credential exists, then the offline
generator — and the offline generator is refused outright when `APP_ENV` is
production, so a production run fails loudly rather than emitting placeholder
copy.

### Ollama

```bash
npm run ollama:up      # docker compose --profile ollama up -d ollama
npm run ollama:pull    # pulls qwen2.5:3b-instruct
npm run content:generate -- --provider ollama
```

Override with `OLLAMA_BASE_URL`, `OLLAMA_MODEL` and `OLLAMA_TIMEOUT_MS`.

**Measured on this machine (CPU only, no GPU), 2026-08-23:**

| Observation | Value |
| --- | --- |
| Disk: `ollama/ollama` image + `qwen2.5:3b-instruct` | ~7 GB |
| Generation throughput | **1.23 tokens/second** |
| One concept batch (`--count 1`) | exceeded 30 minutes without completing |

Two real defects were found and fixed by running this for real:

- A non-streaming request sends no headers until generation completes, and Node's
  `fetch` aborts after five minutes of silence. The provider now streams NDJSON.
- The default request timeout was raised to 30 minutes (`OLLAMA_TIMEOUT_MS`).

**Conclusion: CPU-only Ollama is not viable for unattended generation at this
speed.** It is genuinely free and private, and the integration is correct, but it
needs a GPU to be practical. Budget roughly 7 GB of disk before pulling.

To remove the Ollama artifacts entirely:

```bash
docker compose --profile ollama down
docker rmi ollama/ollama:latest
docker volume rm pahaltea-growth-engine_pahaltea-ollama-models
```

### Anthropic

No key is stored in this repository. The SDK resolves credentials from
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.
Override the model with `ANTHROPIC_MODEL` (default `claude-opus-5`).

### The offline generator is not a mock of success

It composes concepts from fixed copy skeletons and the claim IDs it reads out of
the prompt. It exists so the whole pipeline can be exercised with no network,
credential, or cost. Every run it produces sets `is_offline_stub = true` on
`generation_runs`, the CLI prints a warning, and `content:review` labels those
drafts `OFFLINE PLACEHOLDER`. Its copy is placeholder text, never publishable.

## The pipeline

1. **Retrieve** — `retrieval.ts` selects only claims that are `approved` with an
   evidence link. A claim in `compliance_review`, such as "Ethically Grown", is
   invisible here, so the model cannot cite what an owner has not released. The
   exact claim set and versions are hashed into `retrieval_snapshots`.
2. **Prompt** — `prompt.ts` builds a system prompt containing the brand strategy
   and prohibitions but **no product facts**; facts arrive only as the retrieved
   claim list. A test asserts the template leaks no fact.
3. **Generate** — the provider returns a batch matching `conceptBatchJsonSchema`:
   concept name, format, objective, hook, caption, visual brief, CTA, trial
   offer, social proof angle, hashtags, cited claim IDs, rationale.
4. **Validate** — four recorded checks per concept:
   - `claim_citation` — every cited ID resolves to an approved, evidenced claim.
   - `prohibited_terms` — deterministic scan for health/wellness, certification,
     award, comparative, sustainability, named-spice, unapproved-provenance and
     fabricated-social-proof language. A term is exempt only when it appears in
     the wording of a claim this concept actually cites.
   - `channel_limits` — hook ≤ 120, caption ≤ 2200, hashtags ≤ 30.
   - `trial_lever` — has both a CTA and a trial offer, per the trial-first strategy.
5. **Persist** — drafts land in `content_drafts` at `claim_validation` when they
   pass and `failed` when they do not. Failing drafts are kept, not discarded,
   so the failure is auditable. Every check result is written to
   `content_validation_results`, and each draft emits an audit event.

## Review and approval

```bash
npm run content:review                                  # list
npm run content:review -- --show <id>                   # full draft + checks
npm run content:review -- --approve <id> --reviewer <uuid> --role marketing_approver
npm run content:review -- --reject  <id> --reviewer <uuid> --role owner
```

Approval is not a status flip. It writes an `approval_requests` row for the
`content.publish` action and an `approval_decisions` row bound to a SHA-256 hash
of the exact copy reviewed, then re-checks `canExecute` from
`packages/domain/src/policy.ts` before the draft moves.

Enforced by the domain, with tests:

- The actor that created a draft can never review it.
- Only `marketing_approver` or `owner` may review.
- A draft with any failing validation check cannot be approved.
- Rejection archives; it never deletes.

## What this does not do

- No Instagram or Meta API call exists.
- No creative image or video is generated.
- No paid advertising exists.
- `policy.ts` still blocks every production external write, and
  `assertReadOnlyConnection` still rejects `write` mode.

Approving a draft records a human release decision. It does not send anything.
