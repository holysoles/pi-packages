# Pi Handoff

A standalone Pi extension that summarizes the current session and opens a new session with that summary in context.

<!-- toc -->

- [Install](#install)
- [Usage](#usage)
- [Verify](#verify)

<!-- tocstop -->

## Install

Install the pinned npm release:

```sh
pi install npm:@holysoles/pi-handoff@0.1.2
```

Remove the same release with:

```sh
pi remove npm:@holysoles/pi-handoff@0.1.2
```

## Usage

Run `/handoff` to continue with the current model, or `/handoff provider/model-id` to choose another enabled model for the new session. Review the generated summary and edit it before continuing.

Ordinary handoffs work without the optional `@holysoles/pi-gatewayhelper` dependency. For a `fallback/<key>` virtual model, the helper reads the gateway's global `privateLlmGateway` settings, resolves the configured fallback, and honors `publicModelFailover`; fallback handoffs require `@holysoles/pi-gatewayhelper` to be available. See the [gateway configuration](../gatewayhelper/README.md#configuration) for details.

## Verify

After installation, run `/handoff` and confirm the new session opens with the summary in context. To verify fallback handling, select a configured `fallback/<key>` model before running `/handoff` and confirm routing follows `publicModelFailover`.
