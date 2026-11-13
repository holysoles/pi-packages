# Pi Packages

A monorepo of independently published Pi packages in top-level package directories.

<!-- toc -->

- [Install](#install)
- [Packages](#packages)
    * [gatewayhelper](#gatewayhelper)
    * [handoff](#handoff)
- [Verify](#verify)

<!-- tocstop -->

## Install

Install the pinned npm releases:

```sh
pi install npm:@holysoles/pi-gatewayhelper@0.1.0
pi install npm:@holysoles/pi-handoff@0.1.2
```

Remove the same releases with:

```sh
pi remove npm:@holysoles/pi-gatewayhelper@0.1.0
pi remove npm:@holysoles/pi-handoff@0.1.2
```

For local development, install the workspace dependencies first, then run these commands from the repository root:

```sh
npm install
pi install ./gatewayhelper
pi install ./handoff
```

Remove local packages with:

```sh
pi remove ./gatewayhelper
pi remove ./handoff
```

The previously published `@holysoles/pi-packages` package is a frozen legacy release, not one of the packages in this monorepo.

## Packages

### gatewayhelper

`@holysoles/pi-gatewayhelper` provides virtual fallback models for private LLM gateways, public-model failover, and optional mapped price synchronization. See [gatewayhelper/README.md](gatewayhelper/README.md) for configuration and the exported routing helper.

### handoff

`@holysoles/pi-handoff` summarizes the current session and opens a new session with that context pre-loaded. See [handoff/README.md](handoff/README.md) for usage. Its optional dependency on `@holysoles/pi-gatewayhelper` is used for handoffs from `fallback/<key>` virtual models; ordinary model handoffs do not require gatewayhelper.

## Verify

Run the isolated package tests on Node 24+ without starting Pi or changing your Pi configuration:

```sh
npm test
```
