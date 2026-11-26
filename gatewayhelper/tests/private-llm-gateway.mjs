import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import factory from "../index.ts";
import {
  chooseFallbackRoute,
  parsePrivateLlmGatewaySettings,
  resolveFallbackModel,
} from "../routing.mjs";

const mapping = {
  "gateway-key": {
    private: { provider: "private-gateway", id: "private-runtime-model" },
    public: { provider: "public-catalog", id: "public-catalog-model" },
  },
};

function settings(overrides = {}) {
  return { privateLlmGateway: { models: mapping, ...overrides } };
}

function makeExtension() {
  const models = [];
  const handlers = new Map();
  const commands = new Map();
  factory({
    getSettings: () => { throw new Error("extension must not use pi.getSettings()"); },
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, command) => commands.set(name, command),
    registerVirtualModel: (model) => models.push(model),
  });
  return {
    models,
    handlers,
    commands,
    async fire(event, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

async function withAgentDir(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withGatewaySettings(prefix, value, run) {
  await withAgentDir(prefix, async (dir) => {
    await writeFile(join(dir, "settings.json"), JSON.stringify(value));
    await run(makeExtension(), dir);
  });
}

function routingContext({ privateAvailable = true, privateAuth = true, publicAvailable = true } = {}) {
  const privateModel = { provider: mapping["gateway-key"].private.provider, id: mapping["gateway-key"].private.id };
  const publicModel = { provider: mapping["gateway-key"].public.provider, id: mapping["gateway-key"].public.id };
  const findCalls = [];
  const ctx = {
    modelRegistry: {
      find(provider, id) {
        findCalls.push(`${provider}/${id}`);
        if (provider === privateModel.provider && id === privateModel.id) return privateAvailable ? privateModel : undefined;
        if (provider === publicModel.provider && id === publicModel.id) return publicAvailable ? publicModel : undefined;
        return undefined;
      },
      hasConfiguredAuth(model) {
        return model.provider !== privateModel.provider || model.id !== privateModel.id || privateAuth;
      },
    },
  };
  return { ctx, privateModel, publicModel, findCalls };
}

async function withTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("missing mapping registers no virtual models, adds no sync handler, and touches no model files", async () => {
  await withAgentDir("pi-gateway-no-mapping-", async (dir) => {
    const modelsPath = join(dir, "models.json");
    const original = '{"providers":{"keep":{"models":[{"id":"untouched"}]}}}\n';
    await writeFile(modelsPath, original);

    await writeFile(join(dir, "settings.json"), JSON.stringify({}));
    const extension = makeExtension();
    assert.deepEqual(extension.models, []);
    assert.equal(extension.handlers.has("session_start"), false);
    assert.equal(extension.commands.has("spend"), true);
    const notifications = [];
    await extension.commands.get("spend").handler("", {
      ui: { notify: (message, type) => notifications.push({ message, type }) },
    });
    assert.match(notifications[0].message, /privateLlmGateway\.spend\.provider/);
    assert.equal(await readFile(modelsPath, "utf8"), original);
  });
});

test("spend-only settings work without model mappings and fetch only when commanded", async () => {
  await withAgentDir("pi-gateway-spend-only-", async (dir) => {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ privateLlmGateway: {
      spend: { provider: "metered-provider", dashboardOrigin: "https://dashboard.example" },
    } }));
    const extension = makeExtension();
    assert.deepEqual(extension.models, []);
    assert.equal(extension.handlers.get("session_start").length, 1);
    const requests = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return requests.at(-1).endsWith("/login")
        ? new Response(null, { status: 302, headers: {
          Location: "/dashboard", "Set-Cookie": "metering_session=spend-only; Path=/",
        } })
        : Response.json({ overview: { total_cost_usd: 0 } });
    };
    const notifications = [];
    const ctx = {
      mode: "rpc",
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }) },
    };
    try {
      await extension.fire("session_start", ctx);
      assert.deepEqual(requests, []);
      await extension.commands.get("spend").handler("", ctx);
      assert.equal(requests.length, 2);
      const date = new Date().toISOString().slice(0, 10);
      assert.deepEqual(Object.fromEntries(new URL(requests[1]).searchParams), { range: "custom", from: date, to: date });
      assert.equal(notifications[0].message, `Daily spend (${date} UTC): $0.00`);
    } finally {
      globalThis.fetch = previousFetch;
      await extension.fire("session_shutdown", ctx);
    }
  });
});

test("malformed settings fail closed before registering models or sync handlers", async () => {
  const invalidSettings = [
    { privateLlmGateway: {} },
    { privateLlmGateway: { models: [] } },
    { privateLlmGateway: { models: { "gateway-key": { private: mapping["gateway-key"].private } } } },
    { privateLlmGateway: { models: { " ": mapping["gateway-key"] } } },
    { privateLlmGateway: { models: mapping, publicModelFailover: "false" } },
    { privateLlmGateway: { models: mapping, priceSync: 0 } },
  ];

  await withAgentDir("pi-gateway-invalid-settings-", async (dir) => {
    for (const value of invalidSettings) {
      assert.equal(parsePrivateLlmGatewaySettings(value), undefined);
      await writeFile(join(dir, "settings.json"), JSON.stringify(value));
      const extension = makeExtension();
      assert.deepEqual(extension.models, []);
      assert.equal(extension.handlers.size, 0);
    }
    await writeFile(join(dir, "settings.json"), "{ malformed JSON");
    const extension = makeExtension();
    assert.deepEqual(extension.models, []);
    assert.equal(extension.handlers.size, 0);
  });
});

test("settings parser requires a mapping and defaults both policies to enabled", () => {
  assert.equal(parsePrivateLlmGatewaySettings({}), undefined);
  assert.deepEqual(parsePrivateLlmGatewaySettings(settings()), {
    models: mapping,
    publicModelFailover: true,
    priceSync: true,
  });
  assert.deepEqual(parsePrivateLlmGatewaySettings(settings({ publicModelFailover: false, priceSync: false })), {
    models: mapping,
    publicModelFailover: false,
    priceSync: false,
  });
});

test("mapped virtual routing uses different private/public provider and model IDs with failover enabled by default", async () => {
  await withGatewaySettings("pi-gateway-routing-", settings({ priceSync: false }), async (extension) => {
    assert.equal(extension.models.length, 1);
    assert.equal(extension.models[0].provider, "fallback");
    assert.equal(extension.models[0].id, "gateway-key");
    const route = extension.models[0].route;
    const { ctx, privateModel, publicModel } = routingContext();
    const request = { reason: "user", thinkingLevel: "high" };

    assert.deepEqual(route(request, ctx), { model: privateModel, thinkingLevel: "high", state: undefined });
    const retry = route({
      ...request,
      reason: "retry",
      failed: { model: privateModel, message: { stopReason: "error", errorMessage: "failed" } },
    }, ctx);
    assert.deepEqual(retry, { model: publicModel, thinkingLevel: "high", state: true });
    assert.deepEqual(route({ ...request, reason: "continuation", state: retry.state }, ctx), {
      model: publicModel,
      thinkingLevel: "high",
      state: true,
    });

    const missingAuth = routingContext({ privateAuth: false });
    assert.deepEqual(route(request, missingAuth.ctx), { model: missingAuth.publicModel, thinkingLevel: "high", state: true });
    const noPublic = routingContext({ publicAvailable: false });
    assert.throws(() => route({ ...request, reason: "retry", failed: { model: noPublic.privateModel } }, noPublic.ctx),
      /No available model/);
  });
});

test("daily spend footer clears when a fallback model routes to its public backup", async () => {
  await withGatewaySettings("pi-gateway-spend-fallback-", settings({
    priceSync: false,
    spend: { provider: "metered-provider", dashboardOrigin: "https://dashboard.example", showFooter: true },
  }), async (extension) => {
    const status = [];
    const ctx = {
      mode: "tui",
      ui: { setStatus: (...args) => status.push(args), notify() {} },
      modelRegistry: {
        find(provider, id) {
          if (provider === mapping["gateway-key"].public.provider && id === mapping["gateway-key"].public.id) {
            return { provider, id };
          }
        },
        hasConfiguredAuth: () => false,
      },
    };
    await extension.fire("session_start", ctx);
    const route = extension.models[0].route({ reason: "user", thinkingLevel: "low" }, ctx);
    assert.equal(route.model.provider, mapping["gateway-key"].public.provider);
    assert.deepEqual(status.at(-1), ["gatewayhelper-spend", undefined]);
    await extension.fire("session_shutdown", ctx);
  });
});

test("disabled public failover never selects public models, including when private auth or model is missing", async () => {
  await withGatewaySettings("pi-gateway-disabled-failover-", settings({ publicModelFailover: false, priceSync: false }), async (extension) => {
    const route = extension.models[0].route;
    const request = { reason: "user", thinkingLevel: "medium" };
    const available = routingContext();
    assert.deepEqual(route(request, available.ctx), {
      model: available.privateModel,
      thinkingLevel: "medium",
      state: undefined,
    });
    assert.throws(() => route({
      ...request,
      reason: "retry",
      failed: { model: available.privateModel },
    }, available.ctx), /Public model failover is disabled/);

    for (const unavailable of [
      routingContext({ privateAuth: false }),
      routingContext({ privateAvailable: false }),
    ]) {
      assert.throws(() => route(request, unavailable.ctx), /No available model/);
      assert.equal(unavailable.findCalls.some((candidate) => candidate === "public-catalog/public-catalog-model"), false);
    }
  });
});

test("shared resolver applies the handoff policy and respects disabled failover", () => {
  const models = mapping;
  const available = routingContext();
  assert.equal(resolveFallbackModel("gateway-key", available.ctx, models), available.privateModel);

  const missingAuth = routingContext({ privateAuth: false });
  assert.equal(resolveFallbackModel("gateway-key", missingAuth.ctx, models), missingAuth.publicModel);

  const disabled = routingContext({ privateAuth: false });
  assert.throws(() => resolveFallbackModel("gateway-key", disabled.ctx, models, false), /No available model/);
  assert.equal(disabled.findCalls.some((candidate) => candidate === "public-catalog/public-catalog-model"), false);
  assert.throws(() => chooseFallbackRoute("gateway-key", available.ctx, true, models, false), /failover is disabled/);
});

test("priceSync false registers no handler and leaves models.json unchanged", async () => {
  await withAgentDir("pi-gateway-sync-off-", async (dir) => {
    const modelsPath = join(dir, "models.json");
    const original = '{"providers":{"private-gateway":{"models":[{"id":"private-runtime-model","cost":{"input":99}}]}}}\n';
    await writeFile(modelsPath, original);
    await writeFile(join(dir, "models-store.json"), JSON.stringify({
      "public-catalog": { models: [{ id: "public-catalog-model", type: "chat", cost: { input: 0.1 } }] },
    }));
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings({ priceSync: false })));

    const extension = makeExtension();
    assert.equal(extension.handlers.has("session_start"), false);
    assert.equal(await readFile(modelsPath, "utf8"), original);
  });
});

test("mapped price sync copies only the paired public chat cost to its configured private model", async () => {
  await withAgentDir("pi-gateway-price-sync-", async (dir) => {
    const config = {
      providers: {
        "private-gateway": { models: [
          { id: "private-runtime-model", cost: { input: 99, output: 99 } },
          { id: "unrelated-private-model", cost: { input: 7 } },
        ] },
        unrelated: { models: [{ id: "keep-this-model", cost: { input: 5 } }] },
      },
    };
    const catalog = {
      "public-catalog": { models: [
        { id: "public-catalog-model", type: "classifier", cost: { input: 88 } },
        { id: "public-catalog-model", type: "chat", cost: { input: 0.12, output: 0.34, cacheRead: 0.01 } },
      ] },
    };
    await writeFile(join(dir, "models.json"), JSON.stringify(config, null, 2));
    await writeFile(join(dir, "models-store.json"), JSON.stringify(catalog));
    const spend = { provider: "metered-provider", dashboardOrigin: "https://dashboard.example" };
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings({ spend })));

    const extension = makeExtension();
    assert.equal(extension.handlers.get("session_start").length, 2);
    assert.equal(extension.commands.has("spend"), true);
    const notifications = [];
    let refreshes = 0;
    const ctx = {
      mode: "rpc",
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      modelRegistry: {
        refresh: async (options) => {
          refreshes++;
          assert.deepEqual(options, { allowNetwork: false });
        },
        getProviderAuth: async (provider) => {
          assert.equal(provider, "metered-provider");
          return { auth: { apiKey: "provider-secret" } };
        },
      },
    };
    const previousFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith("/login")) {
        return new Response(null, { status: 302, headers: {
          Location: "/account",
          "Set-Cookie": "metering_session=active-session; Path=/; HttpOnly",
        } });
      }
      return Response.json({ overview: { total_cost_usd: 2.75 } });
    };
    try {
      await extension.fire("session_start", ctx);
      assert.deepEqual(fetchCalls, []);

      const result = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
      assert.deepEqual(result.providers["private-gateway"].models, [
        { id: "private-runtime-model", cost: { input: 0.12, output: 0.34, cacheRead: 0.01 } },
        { id: "unrelated-private-model", cost: { input: 7 } },
      ]);
      assert.deepEqual(result.providers.unrelated, config.providers.unrelated);
      assert.equal(refreshes, 1);
      assert.equal(notifications.filter(({ type }) => type === "info").length, 1);
      assert.match(notifications[0].message, /private-gateway\/private-runtime-model/);

      await extension.commands.get("spend").handler("", ctx);
      assert.equal(fetchCalls.length, 2);
      assert.equal(fetchCalls[1].init.headers.Cookie, "metering_session=active-session");
      assert.match(notifications[1].message, /Daily spend \(.* UTC\): \$2\.75/);
    } finally {
      globalThis.fetch = previousFetch;
      await extension.fire("session_shutdown", ctx);
    }
  });
});

test("missing public catalog pricing leaves the private cost unchanged", async () => {
  await withAgentDir("pi-gateway-no-price-", async (dir) => {
    const modelsPath = join(dir, "models.json");
    const original = JSON.stringify({ providers: { "private-gateway": { models: [
      { id: "private-runtime-model", cost: { input: 99 } },
    ] } } });
    await writeFile(modelsPath, original);
    await writeFile(join(dir, "models-store.json"), JSON.stringify({ "public-catalog": { models: [
      { id: "public-catalog-model", type: "chat" },
    ] } }));
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings()));
    const extension = makeExtension();
    const messages = [];
    await extension.fire("session_start", {
      ui: { notify: (message, type) => messages.push({ message, type }) },
      modelRegistry: { refresh: async () => assert.fail("nothing to refresh") },
    });
    assert.equal(await readFile(modelsPath, "utf8"), original);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "warning");
  });
});

test("price sync is a no-op when mapped prices already match", async () => {
  await withAgentDir("pi-gateway-noop-", async (dir) => {
    const modelsPath = join(dir, "models.json");
    const original = JSON.stringify({ providers: {
      "private-gateway": { models: [{ id: "private-runtime-model", cost: { input: 0.12 } }] },
      unrelated: { models: [{ id: "keep", cost: { input: 5 } }] },
    } }, null, 2) + "\n";
    await writeFile(modelsPath, original);
    await writeFile(join(dir, "models-store.json"), JSON.stringify({
      "public-catalog": { models: [{ id: "public-catalog-model", type: "chat", cost: { input: 0.12 } }] },
    }));
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings()));
    const extension = makeExtension();
    const notifications = [];
    let refreshes = 0;
    await extension.fire("session_start", {
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      modelRegistry: { refresh: async () => { refreshes++; } },
    });
    assert.equal(await readFile(modelsPath, "utf8"), original);
    assert.deepEqual(notifications, []);
    assert.equal(refreshes, 0);
  });
});

test("price sync preserves edits made while another session holds the model config lock", async () => {
  await withAgentDir("pi-gateway-sync-lock-", async (dir) => {
    const config = { providers: { "private-gateway": { models: [
      { id: "private-runtime-model", cost: { input: 99 } },
    ] } } };
    const modelsPath = join(dir, "models.json");
    const lock = join(dir, "models.json.lock");
    await writeFile(modelsPath, JSON.stringify(config));
    await writeFile(join(dir, "models-store.json"), JSON.stringify({ "public-catalog": { models: [
      { id: "public-catalog-model", type: "chat", cost: { input: 1 } },
    ] } }));
    await mkdir(lock);
    await writeFile(join(lock, "owner"), `${process.pid}:another-session`);
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings()));
    const extension = makeExtension();
    let completed = false;
    const syncing = extension.fire("session_start", {
      ui: { notify: (_message, type) => { if (type === "info") completed = true; } },
      modelRegistry: { refresh: async () => {} },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(completed, false);
      config.providers["private-gateway"].models.push({ id: "user-added", cost: { input: 7 } });
      await writeFile(modelsPath, JSON.stringify(config));
      await rm(lock, { recursive: true });
      await withTimeout(syncing, "price sync timed out while waiting for the lock");
      const result = JSON.parse(await readFile(modelsPath, "utf8"));
      assert.deepEqual(result.providers["private-gateway"].models, [
        { id: "private-runtime-model", cost: { input: 1 } },
        { id: "user-added", cost: { input: 7 } },
      ]);
      await assert.rejects(readFile(lock), { code: "ENOENT" });
      assert.equal(completed, true);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  });
});
