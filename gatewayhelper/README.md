# Pi Gateway Helper

A Pi extension for routing virtual models through a private LLM gateway, with optional public-model failover and price synchronization.

<!-- toc -->

- [Install](#install)
- [Configuration](#configuration)
- [Verify](#verify)

<!-- tocstop -->

## Install

Install the pinned npm release:

```sh
pi install npm:@holysoles/pi-gatewayhelper@0.1.0
```

Remove the same release with:

```sh
pi remove npm:@holysoles/pi-gatewayhelper@0.1.0
```

For a local checkout, run `pi install ./gatewayhelper` from the repository root; remove it with `pi remove ./gatewayhelper`.

## Configuration

Add a `privateLlmGateway` section to your global `settings.json` (normally `~/.pi/agent/settings.json`). The extension reads this file at startup; it does not read project settings or apply project overrides. Set `PI_CODING_AGENT_DIR` to use a different agent directory. Replace the example provider and model IDs with providers configured in Pi and IDs appropriate to your setup:

```json
{
  "privateLlmGateway": {
    "models": {
      "gateway-chat": {
        "private": { "provider": "my-private-gateway", "id": "internal-chat-v2" },
        "public": { "provider": "public-provider", "id": "public-chat-latest" }
      }
    }
  }
}
```

Each key under `models` registers a selectable virtual model named `fallback/<key>`; in this example, select `/model fallback/gateway-chat`. The mapped private model must be defined in `~/.pi/agent/models.json`. For price synchronization, the mapped public chat model must have pricing in `~/.pi/agent/models-store.json`.

`publicModelFailover` and `priceSync` both default to `true`. With failover enabled, the extension selects the mapped public model if the private model is unavailable or has no configured authentication, and can switch to the public model after a private-model retry failure. Set `publicModelFailover` to `false` to disable this; if the private model is unavailable, there is no fallback route. Set `priceSync` to `false` to disable synchronization. When enabled, at session startup the extension copies the mapped public chat model's prices into the matching private model entries in `models.json`.

Foreground children launched by `pi-subagents` do not inherit the parent's virtual model registrations. Load this extension in those children with `subagents.defaultSubagentOnlyExtensions`, and configure each child model as a mapped `fallback/<key>`. For example, with a checkout at `/home/you/code/pi-packages`:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": [
      "/home/you/code/pi-packages/gatewayhelper/index.ts"
    ],
    "agentOverrides": {
      "worker": { "model": "fallback/gpt-6-luna" },
      "reviewer": { "model": "fallback/gpt-6-sol" }
    }
  }
}
```

Use the absolute entry-point path for your checkout. Both fallback IDs must also be keys in `privateLlmGateway.models`.

Extensions that make direct model calls can import `parsePrivateLlmGatewaySettings` and `resolveFallbackModel` from the package's `./routing` export. Read the same global settings to use the identical mappings and failover policy:

```ts
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  parsePrivateLlmGatewaySettings,
  resolveFallbackModel,
} from "@holysoles/pi-gatewayhelper/routing";

const globalSettings = SettingsManager.create(ctx.cwd, getAgentDir()).getGlobalSettings();
const gateway = parsePrivateLlmGatewaySettings(globalSettings);
if (!gateway) throw new Error("privateLlmGateway settings are missing or invalid");
const model = resolveFallbackModel(id, ctx, gateway.models, gateway.publicModelFailover);
return ctx.modelRegistry.complete(model, context, options);
```

Pass the mapping key as `id`. A registered `fallback/<key>` is a routing alias, not a physical provider model for a direct `modelRegistry.complete()` call; resolve it first and pass `publicModelFailover` so a disabled policy is respected.

## Verify

After installation, select one of your mapped fallback models and confirm its provider/model IDs. Check the session notifications for routing or price-sync results. Run the package's isolated tests on Node 24+ with `npm test` from `gatewayhelper`; this does not start Pi or change your Pi configuration.
