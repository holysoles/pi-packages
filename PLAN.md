# Prepare pi-packages for publication

## Context

This repo has no commits yet and currently contains one installable Pi extension, `private-llm-gateway`. The Git remote is `holysoles/pi-packages`; `package.json` is marked private. The README now describes a generic private gateway (such as Praxis) and a fallback provider rather than EnMaaS/OpenAI specifically; its prerequisites and warnings still need updating. Goal: a pinned public Git release under MIT, with npm deferred.

## Approach

- Keep one repo-level Pi package and explicitly list extension entry points in `package.json` as new extensions arrive.
- Read a `privateLlmGateway` section of Pi's `settings.json` through `pi.getSettings()`. Pi's settings manager retains unknown keys and merges user/project settings, though this custom section is not in Pi's published settings schema. Require an explicit `models` mapping: virtual model ID → `{ private: { provider, id }, public: { provider, id } }`. Example: `"models": { "gpt-6-luna": { "private": { "provider": "enmaas", "id": "gpt-6-luna" }, "public": { "provider": "openai", "id": "gpt-6-luna" } } }`. Configure different provider IDs and model IDs per pair; register only these mapped virtual models. With no mapping, register none and touch no model files.
- Settings `publicModelFailover` and `priceSync` default to `true` when omitted and can independently be set to `false`. When failover is off, never select the mapped public model, including when private credentials/model are missing; instead surface an error. Sync only explicitly mapped private model entries in `models.json` from their paired public chat-model prices in the local catalog, and leave missing/unpriced pairs unchanged with a useful warning. Validate mapping and flags before registering or writing; malformed configuration must fail closed.
- Document that enabled failover can send conversation history outside the gateway and price sync rewrites local model costs. Add an MIT license and a small CI check; tag a reviewed first Git release. Keep npm publication out of scope.

## Files to modify

- `extensions/private-llm-gateway/index.ts` and `fallback-model-routing.mjs`: read/validate the new settings mapping, register mapped virtual models, and apply optional public-model failover and paired price synchronization.
- `tests/private-llm-gateway.mjs`: cover changed defaults and failure cases.
- `README.md`: preserve the new generic/Praxis description; replace the TODO-marked prerequisites and warnings with the settings/mapping example, privacy/cost disclosure, pinned Git install and removal instructions; remove obsolete local-extension migration note.
- `package.json`: release metadata as needed; retain `private: true` for Git-only distribution.
- `LICENSE` and `.github/workflows/test.yml`: MIT license and minimal Node 22 CI.
- Outside this repo, `~/.pi/agent/settings.json`: add explicit mappings for the four existing `fallback/*` models before removing hardcoded defaults; keep personal provider configuration and credentials out of the published repo.
- Outside this repo, `~/.pi/agent/extensions/handoff.ts` imports `resolveFallbackModel`; adapt it to the configured mapping and disabled-failover policy so it cannot bypass user settings.

## Reuse

- Existing `pi.extensions` manifest in `package.json` explicitly exposes only `extensions/private-llm-gateway/index.ts`.
- `chooseFallbackRoute` in `extensions/private-llm-gateway/fallback-model-routing.mjs` remains the shared routing helper (also used by the local handoff extension).
- `tests/private-llm-gateway.mjs` already exercises cost sync, locking and fallback routing via temporary `PI_CODING_AGENT_DIR`.

## Steps

- [x] Add the four current EnMaaS → OpenAI mappings to personal `settings.json` first, preserving `fallback/gpt-6-luna` as the default; do not commit this file.
- [x] Implement the `privateLlmGateway` settings section with required model mappings, independent boolean flags defaulting to `true`, validation, and no hardcoded provider/model IDs. No mapping means no virtual models and no price sync.
- [x] Limit cost sync to mapped pairs; update the local handoff consumer to respect the same mapping and failover flag.
- [x] Extend tests for absent/invalid mappings, different private/public IDs, both flags off, unavailable models, mapped price sync, and unchanged files when sync is off.
- [x] Update README with safe setup, example model config without credentials, install/uninstall, and exact data/pricing implications.
- [x] Add a small Node 22 test workflow; scan commit contents for personal paths, secrets, and accidental files.
- [ ] After separate release approval, commit/push/tag `v0.1.0` and document the pinned install URL. Do not publish during implementation; npm publication remains a later decision.

## Verification

- `npm test`; CI on Node 22.
- Isolated Pi agent-directory smoke test: missing mapping produces no models/no writes; mapped pair loads one virtual model; disabled failover never selects the public model; disabled sync leaves `models.json` untouched. Check the real personal default and handoff import after updating local settings, without sending a live model request or changing the live model file.
- Review the staged diff, confirm Git package install from a tag in a clean environment, and confirm `pi remove` instructions before release.

## Confirmed decisions

- GitHub/Git distribution first; npm deferred; MIT license.
- Both `publicModelFailover` and `priceSync` are configurable and default to `true`.
- Selectable virtual models are `fallback/<mapping-key>`. No mapping means no fallback models and no price sync.
- Add the four existing mappings to personal settings during implementation to preserve current defaults; do not publish that settings file.
