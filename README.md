# Pi Packages

A collection of Pi extensions.

<!-- toc -->

- [Install](#install)
- [Packages](#packages)
    * [private-llm-gateway](#private-llm-gateway)
        + [Configuration](#configuration)
        + [Extending](#extending)
- [Verify](#verify)

<!-- tocstop -->

## Install

For local development, run `pi install ./` from this repository's root. The package manifest declares the extension entry point; no build step or bundled dependencies are required.

After a Git release has been created, install its pinned tag (not a moving branch):

```sh
pi install git:github.com/holysoles/pi-packages@v0.1.0
```

Remove the same source you installed. For the tagged source above:

```sh
pi remove git:github.com/holysoles/pi-packages@v0.1.0
```

## Packages

### private-llm-gateway

A helper extension for using a private LLM gateway, such as [Praxis](https://github.com/praxis-proxy/ai).

It exposes fallback models that use your upstream private LLM gateway by default. If the private gateway provider is unavailable, it can route the request to a fallback provider. This can be useful for high availability and for sharing model defaults across environments where the private gateway may not be available.

At session startup, it can also synchronize mapped private model prices from Pi's local model catalog.

#### Configuration

Add a `privateLlmGateway` section to your personal/global `settings.json` (normally `~/.pi/agent/settings.json`). The extension reads this file synchronously during startup so virtual models are registered before initial model selection. It does not read project settings or apply project overrides. `PI_CODING_AGENT_DIR` selects the agent directory when set. Replace the example provider and model IDs with providers configured in Pi and model IDs appropriate to your setup:

```json
{
  "privateLlmGateway": {
    "models": {
      "gateway-chat": {
        "private": { "provider": "my-private-gateway", "id": "internal-chat-v2" },
        "public": { "provider": "public-provider", "id": "public-chat-latest" }
      }
    },
  }
}
```

Each `models` key defines a selectable virtual model named `fallback/<key>`; here, select `/model fallback/gateway-chat`. The private and public provider IDs and model IDs may differ. The mapped private model must be defined in `~/.pi/agent/models.json`. For price sync, the paired public chat model must have pricing in `~/.pi/agent/models-store.json`.

Both `publicModelFailover` and `priceSync` default to `true` when omitted. Set either one to `false` to disable that behavior.

Foreground children launched by `pi-subagents` do not inherit the parent's virtual model registrations. Load this extension in those children with `subagents.defaultSubagentOnlyExtensions`; the configured agent model must be a mapped `fallback/<key>`. For example, with a checkout at `/home/you/code/pi-packages`:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": [
      "/home/you/code/pi-packages/extensions/private-llm-gateway/index.ts"
    ],
    "agentOverrides": {
      "worker": { "model": "fallback/gpt-6-luna" },
      "reviewer": { "model": "fallback/gpt-6-sol" }
    }
  }
}
```

Use the absolute entry-point path for your checkout. The two fallback IDs above must also be present as keys in `privateLlmGateway.models`.

#### Extending

Other extensions that make direct model calls (for example, a handoff extension) can share `parsePrivateLlmGatewaySettings` and `resolveFallbackModel` from `fallback-model-routing.mjs`. Read the same global settings source so direct calls use the identical mapping and flags. In this example, the consumer is `~/.pi/agent/extensions/handoff.ts`; adjust the relative import if your files are elsewhere:

```ts
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  parsePrivateLlmGatewaySettings,
  resolveFallbackModel,
} from "../../../code/pi-packages/extensions/private-llm-gateway/fallback-model-routing.mjs";

const globalSettings = SettingsManager.create(ctx.cwd, getAgentDir()).getGlobalSettings();
const gateway = parsePrivateLlmGatewaySettings(globalSettings);
if (!gateway) throw new Error("privateLlmGateway settings are missing or invalid");
const model = resolveFallbackModel(id, ctx, gateway.models, gateway.publicModelFailover);
return ctx.modelRegistry.complete(model, context, options);
```

Pass the mapping key as `id`. A Pi-registered virtual `fallback/<key>` model is a routing alias, not a physical provider model for a direct `modelRegistry.complete()` call; resolve it first. Pass `publicModelFailover` through to the resolver so a disabled policy is respected: if the private model/auth is unavailable, resolution fails instead of selecting the public model.

## Verify

Run the isolated tests on Node 24+ without starting Pi or changing your Pi configuration:

```sh
npm test
```

After installation, select one of your mapped fallback models and verify your provider/model IDs and the session notifications for routing or price-sync results.
