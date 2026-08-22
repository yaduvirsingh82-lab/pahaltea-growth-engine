# Integration adapters

This package intentionally contains no provider credentials, account IDs, live API clients, or production payloads.

Phase 4 enables only these offline/read-only foundations:

- a provider adapter contract;
- connection-mode enforcement (`offline`, `sandbox`, `read_only`, `write`);
- raw-body HMAC verification for Shopify and Meta webhooks;
- test fixtures generated locally.

Before any live adapter is enabled, an owner must supply the account owner, a managed secret reference, allowed scopes, data-retention approval, environment, and an approved read-only execution record. `write` mode remains prohibited by Phase 2 policy.
