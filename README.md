# ecommerce-contracts

The **published contracts** of the e-commerce platform: what each service promises to others. No
implementation code.

| Path | What | Source of truth |
|---|---|---|
| `schemas/<owner>/*.schema.json` | Events and commands (JSON Schema 2020-12) | **this repo** (contract-first) |
| `schemas/common/envelope.v1.schema.json` | The envelope every message shares | this repo |
| `examples/<owner>/*.json` | One valid example per message (validated by the tests) | this repo |
| `openapi/<service>.openapi.json` | HTTP APIs | the service's code (code-first; `npm run sync:openapi` republishes) |
| `asyncapi/asyncapi.json` | Channels, messages, who sends and who receives | generated (`npm run build`) |
| [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) | Ownership matrix | generated |
| [`VERSIONING.md`](VERSIONING.md) | What is breaking, how to evolve, releases, pinning | |

**Ownership.** An event belongs to its producer; a command belongs to its consumer. The folder a schema
lives in is its owner; the tests enforce the rule, the naming, the `$id` and the channel.

## Commands

| Command | |
|---|---|
| `npm test` | Schemas compile, examples validate, ownership/naming/channel rules, AsyncAPI valid, generated files current, compatibility rules |
| `npm run build` / `npm run check` | Regenerate / verify `asyncapi/asyncapi.json` and `docs/OWNERSHIP.md` |
| `npm run compat [-- --base v1.0.0]` | Breaking-change report against the latest (or given) release, and the version bump it requires |
| `npm run sync:openapi` | Copy the services' generated OpenAPI documents in |
| `node scripts/vendor.mjs --service X --into ../repo --version vN` | Pin a service to a release (see VERSIONING.md) |

A worked breaking-change example, with real output: [docs/breaking-change-demo.md](docs/breaking-change-demo.md).
