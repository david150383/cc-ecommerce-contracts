# Breaking-change demo (real output)

Scenario: the Order team wants to rename `OrderConfirmed.payload.total` to `grandTotal`. Both attempts below
were run on throwaway branches of this repository (kept for inspection: `demo/rename-in-place`,
`demo/expand-v2`; never released). The output is copied verbatim.

## 1. The wrong way: change v1 in place (branch `demo/rename-in-place`)

The schema and example are edited in place and `package.json` is bumped to 1.2.0 (minor), as one might
for "a small rename".

`npm run compat`:

```text
Compared with v1.1.0: 2 change(s)
  ✗ BREAKING  OrderConfirmed v1  .payload.total: property removed
  · safe      OrderConfirmed v1  .payload.grandTotal: new required property

Version 1.1.0 → 1.2.0 (minor); these changes need at least: major.
✗ Breaking change without a major version. Prefer a NEW version of the message (v2 next to v1) or /api/v2; see VERSIONING.md.
exit 1
```

CI fails. Even with a **major** bump, the change would still break every consumer still reading `total`,
which is why VERSIONING.md says breaking changes are never made in place.

**What the consumers would see.** Pinning two consumers to that branch
(`node scripts/vendor.mjs --service <s> --into ../ecommerce-<s> --version demo/rename-in-place`) and running
their own tests:

| Consumer | Relies on | Result |
|---|---|---|
| notification-service | `total` (order confirmation email shows it) | ✗ `OrderConfirmed: the producer's example is handled` fails: `OrderConfirmed payload: Invalid input: expected object, received undefined → at total` |
| saga-orchestrator | `orderId` only | ✓ all 51 schema/consumer tests pass: the change does not affect it |

The failure appears in the consumer's build, at the moment it **upgrades its pin**, not in production.
Consumers that did not upgrade (the normal case) are untouched: their vendored files are still v1.x.
Both repositories were restored to their real pin afterwards (`npm run contracts:verify` ✓).

## 2. The right way: expand (branch `demo/expand-v2`)

`OrderConfirmed` **v2** (`schemas/order-service/order-confirmed.v2.schema.json`, `messageVersion: 2`,
`grandTotal`) is added **next to** v1, with an example. Version 1.2.0 (minor).

`npm run compat`:

```text
Compared with v1.1.0: 1 change(s)
  · safe      OrderConfirmed v2  (message): added (event owned by order-service)

Version 1.1.0 → 1.2.0 (minor); these changes need at least: minor.
✓ OK
exit 0
```

The generic tests pick v2 up automatically (it compiles, its example validates, naming/`$id`/channel
rules hold), and the AsyncAPI document lists both versions on `order-events`.

Then, per VERSIONING.md:

1. **Release** v1.2.0. The Order Service publishes both versions (or v2 only once nobody reads v1).
2. **Migrate**: each consumer pins v1.2.0 when it is ready, reads v2, and the ownership matrix
   (`docs/OWNERSHIP.md`) shows who still consumes v1.
3. **Contract**: when no consumer of v1 is left, remove it in **v2.0.0**. `npm run compat` reports
   `OrderConfirmed v1 (message): removed … BREAKING` and accepts it only with the major bump.

## What made the difference

- The compatibility checker judges a change from the side that did not make it (events: readers;
  commands: writers) and enforces the version bump.
- Consumers pin a release and carry contract tests: the saga declares the fields it relies on and checks the
  producer **requires** them; the Notification Service runs every producer example through its real handler;
  the frontend's typecheck asserts that every API response type it reads is still provided.
