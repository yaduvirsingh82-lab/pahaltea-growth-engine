# First Instagram post — Masala Tea

The copy and creative for Pahal Tea's first Instagram feed post, held here as a
reviewable artefact. Nothing in this directory publishes anything: a post only
goes live when a human runs `npm run meta:publish -- --live`, and only once the
gates in `docs/runbooks/instagram-publishing.md` are all satisfied.

## Provenance

This copy was written by hand, not produced by `npm run content:generate`. No
model provider was reachable when it was drafted (no Ollama, no Anthropic
credential), and the offline template generator emits placeholder copy that is
flagged `is_offline_stub` and must never be published. The copy was instead
checked against the same gates the pipeline applies:

| Gate | Result |
| --- | --- |
| `parseConceptBatch` (structural schema) | PASS |
| `claim_citation` | PASS — cites 10 approved claims |
| `prohibited_terms` | PASS — no prohibited language |
| `channel_limits` | PASS — hook 63/120, caption 792/2200, hashtags 12/30 |
| `trial_lever` | PASS — has a call to action and a trial offer |
| `assertPublishableImage` on `creative.jpg` | PASS — real JPEG, 1080x1080 |

Re-run those checks after any edit to `caption.txt`: an edit invalidates the
compliance reasoning above, exactly as it would invalidate an approval hash.

## Approved claims cited

Every factual assertion in the caption traces to an approved row of the seeded
claim catalogue (`packages/db/src/seed/catalogue.ts`):

| Claim key | Wording |
| --- | --- |
| `origin-assam` | Origin/garden: Assam |
| `grade-amchong` | Tea grade/type: Amchong |
| `ingredients` | Ingredients: Tea & Spices |
| `spice-composition-packet` | Exact spice composition: refer to product packet |
| `spice-sourcing` | Spice sourcing: reliable sources |
| `no-additives` | No added flavours, colours, preservatives, or additives |
| `garden-fresh` | Garden Fresh: directly from where the tea is grown |
| `blended-with-expertise` | Blended with Expertise: composition of spices, grades of tea, and best flush of production |
| `founder-experience` | Tea/blending experience: founder's experience in tea |
| `hero-sku-pack` | Hero SKU: Masala Tea; current pack: 200g |

`ethically-grown` is deliberately **not** used. It is seeded as
`compliance_review` pending owner decision 1 in `docs/ARCHITECTURE.md`, so it
may not appear in public copy yet.

## Files

- `caption.txt` — the caption exactly as it should be posted, hashtags included.
- `creative.jpg` — 1080x1080 JPEG, the format `assertPublishableImage` requires.
- `creative.html` — source of the creative. Re-render with:

  ```bash
  chromium --headless --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1080,1167 \
    --screenshot=raw.png file://$PWD/content/first-post/creative.html
  # crop the 87px of window chrome off the bottom, then encode JPEG
  python3 -c "from PIL import Image; Image.open('raw.png').convert('RGB').crop((0,0,1080,1080)).save('creative.jpg','JPEG',quality=92,subsampling=0,optimize=True)"
  ```

The creative is typographic on purpose. Owner-supplied photography of the actual
200g packet would be a stronger asset, but generating a product image would
fabricate a product shot, which the claim rules do not permit.

## Publishing it

Live publishing is still blocked on account setup, not on code — see
`docs/runbooks/instagram-publishing.md`. Once `META_*` and `R2_*` are in `.env`:

```bash
npm run meta:verify
npm run meta:connect -- --owner <owner-uuid> --mode write
WRITE_ACTIONS_ENABLED=true npm run meta:publish -- --draft <draft-id> --live \
  --image content/first-post/creative.jpg
```

That path needs an approved draft row, which needs a real generation run. Until
a model provider is configured, the caption here can be posted manually from the
Instagram app using `creative.jpg` — a human posting by hand is outside the
engine and needs no gate, but also produces no audit record.
