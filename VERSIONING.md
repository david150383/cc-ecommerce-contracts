# Versioning policy

Two things are versioned: **each contract** (a message type, an HTTP API) and **this repository's
releases** (git tags `vMAJOR.MINOR.PATCH`, which consumers pin).

## What is a breaking change?

Judged from the side of whoever did **not** make the change (`lib/compat.mjs` implements exactly this):

| Contract part | Who writes / who reads | Breaking (needs a new contract version) | Safe |
|---|---|---|---|
| Event payload, API response | owner writes, others read | remove a field; make a required field optional; widen a type (`string` → `string \| null`, `integer` → `number`); change a `const`; loosen limits (warning) or add an enum value (warning) | add an optional or required field; tighten limits |
| Command payload, API request, query/path parameter | others write, owner reads | add a required field or parameter; remove a field the owner rejects as unknown; narrow a type; remove an enum value; add/tighten `format`, `pattern`, length limits | add an optional field; loosen limits; accept new enum values |
| Envelope | everyone both ways | any change other than documentation | documentation |
| Message type / API operation | | remove it; change its channel or kind | add one |

Adding optional fields is safe because **every consumer is a tolerant reader**: it validates the fields it
uses and ignores the rest (platform convention). A consumer that is not is a bug in that consumer.

## How to make a breaking change (expand → migrate → contract)

Never in place. For a message:

1. **Expand**: add `OrderConfirmed` **v2** (`order-confirmed.v2.schema.json`, `messageVersion: 2`) next to v1.
   Release as a **minor** version (a new message is an addition).
2. **Migrate**: the producer publishes **both** v1 and v2 (or v2 only once every consumer reads v2).
   Consumers move to v2 at their own pace, each pinning the release that has it.
3. **Contract**: when the ownership matrix shows no consumer of v1 is left, remove v1 in a **major** release.

For an HTTP API the same with paths: `/api/v2/...` next to `/api/v1/...` (conventions.md), with a
deprecation window, then remove v1 in a major release.

## Releases

| Bump | When | Examples |
|---|---|---|
| MAJOR | anything breaking (normally: retiring a version that nobody uses any more) | remove `OrderConfirmed` v1; remove `/api/v1/orders` |
| MINOR | additions | a new message or message version; a new optional field; a new operation |
| PATCH | no contract change | documentation, examples, tooling |

`npm run compat` compares the working tree with the latest tag, lists every change with its severity, and
fails when the version in `package.json` is not bumped enough. CI runs it on every pull request. Then:

```bash
npm version minor        # or major / patch: bumps package.json and creates the tag
git push --follow-tags   # (once the repository has a remote)
```

## Pinning (consumers)

Services never read this repository at runtime or build time. Each one **vendors** the files it needs from a
**tag** into its own repository and commits them with `contracts.lock.json` (version, commit, SHA-256 of each
file). `npm run contracts:verify` in the service fails if a vendored file was edited by hand. Upgrading is a
deliberate, reviewed change in the consumer:

```bash
# in ecommerce-contracts
node scripts/vendor.mjs --service order-service --into ../ecommerce-order-service --version v1.1.0
```
