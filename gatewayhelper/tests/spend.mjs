import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpendClient, createSpendLifecycle, resolveSpendApiKey } from "../spend.mjs";

const setupError =
  "Daily spend is not configured: set privateLlmGateway.spend.provider to a provider with an API key.";

test("spend login key comes from the configured provider auth", async () => {
  const calls = [];
  const ctx = {
    modelRegistry: {
      async getProviderAuth(providerId) {
        calls.push(providerId);
        return { auth: { apiKey: "provider-secret" } };
      },
    },
  };

  assert.equal(await resolveSpendApiKey("configured-provider", ctx), "provider-secret");
  assert.deepEqual(calls, ["configured-provider"]);
});

test("missing provider is rejected without resolving auth", async () => {
  let calls = 0;
  const ctx = { modelRegistry: { getProviderAuth: () => { calls++; } } };

  for (const providerId of [undefined, "", "  "]) {
    await assert.rejects(resolveSpendApiKey(providerId, ctx), { message: setupError });
  }
  assert.equal(calls, 0);
});

test("unresolvable or missing provider auth produces only a sanitized setup error", async () => {
  for (const getProviderAuth of [
    async () => { throw new Error("provider details and secret"); },
    () => undefined,
    () => ({ auth: {} }),
    () => ({ auth: { apiKey: "" } }),
  ]) {
    await assert.rejects(
      resolveSpendApiKey("configured-provider", { modelRegistry: { getProviderAuth } }),
      { message: setupError },
    );
  }
});

const spendConfig = { provider: "configured-provider", dashboardOrigin: "https://dashboard.example/", useLocalDay: true };

function authContext(apiKey = "secret & form=value") {
  const providers = [];
  return {
    providers,
    modelRegistry: {
      async getProviderAuth(providerId) {
        providers.push(providerId);
        return { auth: { apiKey } };
      },
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function summaryResponse(total) {
  const start = new Date("2025-04-03T00:00:00");
  const end = new Date(2025, 3, 4);
  return jsonResponse({ window: { from: start, to: end }, overview: { total_cost_usd: total } });
}

function loginResponse(cookie = "metering_session=session-secret", location = "/account") {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append("Set-Cookie", `${cookie}; Path=/; HttpOnly`);
  headers.append("Set-Cookie", "other_cookie=must-not-be-sent; Path=/");
  return new Response(null, { status: 302, headers });
}

function mockClient(responses, ctx = authContext()) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    assert.ok(next, "unexpected HTTP request");
    return next;
  };
  return { client: createSpendClient(spendConfig, ctx, fetch), calls, ctx };
}

test("spend client posts the configured key, retains only its session cookie, and reads the local-day total", async () => {
  const mock = mockClient([
    loginResponse(),
    summaryResponse(0),
  ]);
  assert.equal(await mock.client.getDailyTotal("2025-04-03"), 0);
  assert.deepEqual(mock.ctx.providers, ["configured-provider"]);
  assert.equal(mock.calls.length, 2);

  const [login, summary] = mock.calls;
  assert.equal(login.url, "https://dashboard.example/login");
  assert.equal(login.init.method, "POST");
  assert.equal(login.init.redirect, "manual");
  assert.equal(login.init.credentials, "omit");
  assert.equal(login.init.headers.Origin, "https://dashboard.example");
  assert.match(login.init.headers["Content-Type"], /^application\/x-www-form-urlencoded/);
  assert.deepEqual([...new URLSearchParams(login.init.body)], [["api_key", "secret & form=value"]]);

  const summaryUrl = new URL(summary.url);
  assert.equal(summaryUrl.origin, "https://dashboard.example");
  assert.equal(summaryUrl.pathname, "/api/v1/me/usage/summary");
  assert.deepEqual([...summaryUrl.searchParams], [
    ["range", "exact"], ["from", new Date(2025, 3, 3).toISOString()], ["to", new Date(2025, 3, 4).toISOString()],
  ]);
  assert.equal(summary.init.method, "GET");
  assert.equal(summary.init.redirect, "manual");
  assert.equal(summary.init.credentials, "omit");
  assert.deepEqual(summary.init.headers, {
    Cookie: "metering_session=session-secret",
    Accept: "application/json",
  });
});

test("spend client rejects unsafe origins before making HTTP requests", () => {
  for (const dashboardOrigin of [
    "http://dashboard.example",
    "https://user@dashboard.example",
    "https://@dashboard.example",
    "https://dashboard.example/path",
    "https://dashboard.example?token=secret",
    "https://dashboard.example#fragment",
  ]) {
    assert.throws(
      () => createSpendClient({ ...spendConfig, dashboardOrigin }, authContext(), () => assert.fail("HTTP request")),
      /dashboardOrigin must be an HTTPS origin/,
    );
  }
});

test("spend login rejects invalid keys and cross-origin redirects without following them", async () => {
  for (const response of [
    loginResponse("", "/login?error=invalid"),
    loginResponse("metering_session=session-secret", "https://attacker.example/account"),
  ]) {
    const mock = mockClient([response]);
    await assert.rejects(mock.client.getDailyTotal("2025-04-03"), /Daily spend login failed/);
    assert.equal(mock.calls.length, 1);
  }
});

test("spend client retries login exactly once after a same-origin session-expiry redirect", async () => {
  const mock = mockClient([
    loginResponse("metering_session=old-session"),
    new Response(null, { status: 302, headers: { Location: "/login" } }),
    loginResponse("metering_session=new-session", "/dashboard"),
    summaryResponse(1.25),
  ]);
  assert.equal(await mock.client.getDailyTotal("2025-04-03"), 1.25);
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls[1].init.headers.Cookie, "metering_session=old-session");
  assert.equal(mock.calls[3].init.headers.Cookie, "metering_session=new-session");
});

test("spend client reports HTTP denial, service failure, and unexpected redirects without retry", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 302, headers: { Location: "/login?next=/account" } }),
    new Response(null, { status: 302, headers: { Location: "https://attacker.example/login" } }),
  ]) {
    const mock = mockClient([loginResponse(), response]);
    await assert.rejects(mock.client.getDailyTotal("2025-04-03"), /Daily spend summary/);
    assert.equal(mock.calls.length, 2);
  }
});

test("spend client accepts zero and rejects malformed or non-finite summary totals", async () => {
  for (const [body, valid, message] of [
    [0, true],
    ["0", false, /invalid total/],
    [null, false, /invalid total/],
    [1e400, false, /invalid total/],
  ]) {
    const mock = mockClient([loginResponse(), summaryResponse(body)]);
    if (valid) assert.equal(await mock.client.getDailyTotal("2025-04-03"), 0);
    else await assert.rejects(mock.client.getDailyTotal("2025-04-03"), message);
  }

  const mock = mockClient([loginResponse(), new Response("not-json", { status: 200 })]);
  await assert.rejects(mock.client.getDailyTotal("2025-04-03"), /invalid JSON/);

  const oldServer = mockClient([loginResponse(), jsonResponse({ overview: { total_cost_usd: 42 } })]);
  await assert.rejects(oldServer.client.getDailyTotal("2025-04-03"), /server may need an upgrade/);
});

test("local midnight bounds are sent as UTC even on DST transitions and half-hour offsets", async () => {
  const oldTimezone = process.env.TZ;
  try {
    for (const [zone, date, from, to] of [
      ["America/New_York", "2025-03-09", "2025-03-09T05:00:00.000Z", "2025-03-10T04:00:00.000Z"],
      ["America/New_York", "2025-11-02", "2025-11-02T04:00:00.000Z", "2025-11-03T05:00:00.000Z"],
      ["Asia/Kolkata", "2025-04-03", "2025-04-02T18:30:00.000Z", "2025-04-03T18:30:00.000Z"],
    ]) {
      process.env.TZ = zone;
      const mock = mockClient([loginResponse(), jsonResponse({ window: { from, to }, overview: { total_cost_usd: 1 } })]);
      assert.equal(await mock.client.getDailyTotal(date), 1);
      assert.deepEqual(Object.fromEntries(new URL(mock.calls[1].url).searchParams), { range: "exact", from, to });
    }
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  }
});

test("spend client validates the date before resolving auth or making requests", async () => {
  const mock = mockClient([]);
  for (const date of ["2025-02-30", "04-03-2025", "2025-04-03T00:00:00Z"]) {
    await assert.rejects(mock.client.getDailyTotal(date), /valid calendar date/);
  }
  assert.equal(mock.ctx.providers.length, 0);
  assert.equal(mock.calls.length, 0);
});

function withFakeClock(start, run) {
  const NativeDate = globalThis.Date;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  let now = NativeDate.parse(start);
  let nextId = 0;
  const timeouts = new Map();
  const intervals = new Map();

  class FakeDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  globalThis.Date = FakeDate;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timeouts.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timeouts.delete(id);
  globalThis.setInterval = (callback, delay) => {
    const id = ++nextId;
    intervals.set(id, { callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);

  return Promise.resolve().then(() => run({
    setTime(value) { now = NativeDate.parse(value); },
    timeouts,
    intervals,
  })).finally(() => {
    globalThis.Date = NativeDate;
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    globalThis.setInterval = nativeSetInterval;
    globalThis.clearInterval = nativeClearInterval;
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function lifecycleContext(mode = "tui") {
  const status = [];
  const notifications = [];
  return {
    status,
    notifications,
    ctx: {
      mode,
      ui: {
        setStatus: (...args) => status.push(args),
        notify: (message, type) => notifications.push({ message, type }),
      },
    },
  };
}

test("footer-off and non-TUI sessions never start automatic requests", async () => {
  for (const [showFooter, mode] of [[false, "tui"], [true, "rpc"]]) {
    await withFakeClock("2025-04-03T12:00:00Z", async ({ timeouts, intervals }) => {
      let calls = 0;
      const ui = lifecycleContext(mode);
      const lifecycle = createSpendLifecycle({ getDailyTotal: async () => { calls++; return 2; } }, showFooter, ui.ctx);
      lifecycle.start();
      await flushPromises();
      assert.equal(calls, 0);
      assert.equal(timeouts.size, 0);
      assert.equal(intervals.size, 0);
      assert.deepEqual(ui.status, []);
      lifecycle.dispose();
    });
  }
});

test("footer uses the configured refresh interval and rejects invalid intervals", async () => {
  for (const value of [0, -1, 1.5, "30", null, 1441]) {
    assert.throws(() => createSpendClient({ ...spendConfig, refreshIntervalMinutes: value }, authContext()),
      /refreshIntervalMinutes must be a whole number/);
  }
  await withFakeClock("2025-04-03T12:00:00Z", async ({ intervals }) => {
    const client = createSpendClient({ ...spendConfig, refreshIntervalMinutes: 30 }, authContext());
    client.getDailyTotal = async () => 2;
    const lifecycle = createSpendLifecycle(client, true, lifecycleContext().ctx);
    try {
      lifecycle.start();
      assert.equal([...intervals.values()][0].delay, 30 * 60 * 1000);
    } finally {
      lifecycle.dispose();
    }
  });
});

test("startup refresh does not block, and command shares the same-day request and refreshes the footer", async () => {
  await withFakeClock("2025-04-04T01:30:00Z", async ({ timeouts, intervals }) => {
    const oldTimezone = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    try {
      assert.notEqual(new Date().getDate(), new Date().getUTCDate());
      const pending = deferred();
      const dates = [];
      const ui = lifecycleContext();
      const lifecycle = createSpendLifecycle({
        useLocalDay: true,
        getDailyTotal(date) { dates.push(date); return pending.promise; },
      }, true, ui.ctx);
      assert.equal(lifecycle.start(), undefined);
      const command = lifecycle.command();
      assert.deepEqual(dates, ["2025-04-03"]);
      assert.equal(timeouts.size, 1);
      assert.equal([...intervals.values()][0].delay, 15 * 60 * 1000);
      pending.resolve(3.5);
      await command;
      await flushPromises();
      assert.deepEqual(ui.notifications, [{ message: "Daily spend (2025-04-03 local): $3.50", type: "info" }]);
      assert.ok(ui.status.some(([, value]) => value === "Daily spend: $3.50"));
      lifecycle.dispose();
      assert.equal(timeouts.size, 0);
      assert.equal(intervals.size, 0);
    } finally {
      if (oldTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = oldTimezone;
    }
  });
});

test("midnight clears stale status, rejects the prior local-day result, and tells a crossed-midnight command to rerun", async (t) => {
  const oldTimezone = process.env.TZ;
  t.after(() => {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  });
  process.env.TZ = "Pacific/Honolulu";
  await withFakeClock("2025-04-04T09:59:59Z", async ({ setTime, timeouts }) => {
    const pending = new Map();
    const dates = [];
    const ui = lifecycleContext();
    const lifecycle = createSpendLifecycle({
      useLocalDay: true,
      getDailyTotal(date) {
        dates.push(date);
        const result = deferred();
        pending.set(date, result);
        return result.promise;
      },
    }, true, ui.ctx);
    lifecycle.start();
    const command = lifecycle.command();
    const rollover = [...timeouts.values()][0];
    assert.equal(rollover.delay, 1000);
    setTime("2025-04-04T10:00:00Z");
    timeouts.clear();
    rollover.callback();
    assert.deepEqual(dates, ["2025-04-03", "2025-04-04"]);

    pending.get("2025-04-03").resolve(99);
    await command;
    await flushPromises();
    assert.deepEqual(ui.notifications, [{
      message: "The local date changed while fetching daily spend; rerun /spend.",
      type: "warning",
    }]);
    assert.equal(ui.status.some(([, value]) => value === "Daily spend: $99.00"), false);
    assert.ok(ui.status.some(([, value]) => value === undefined));

    pending.get("2025-04-04").resolve(1.25);
    await flushPromises();
    assert.ok(ui.status.some(([, value]) => value === "Daily spend: $1.25"));
    lifecycle.dispose();
  });
});

test("shutdown disposes before late fetch and timer completions can touch the old UI", async () => {
  await withFakeClock("2025-04-03T12:00:00Z", async ({ timeouts, intervals }) => {
    const pending = deferred();
    let signal;
    let calls = 0;
    const ui = lifecycleContext();
    const lifecycle = createSpendLifecycle({
      getDailyTotal(_date, options) {
        calls++;
        signal = options.signal;
        return pending.promise;
      },
    }, true, ui.ctx);
    lifecycle.start();
    const command = lifecycle.command();
    const oldTimeout = [...timeouts.values()][0];
    const oldInterval = [...intervals.values()][0];
    const statusCount = ui.status.length;
    lifecycle.dispose();
    assert.equal(signal.aborted, true);
    oldTimeout.callback();
    oldInterval.callback();
    pending.resolve(4);
    await command;
    await flushPromises();
    assert.equal(calls, 1);
    assert.equal(ui.notifications.length, 0);
    assert.equal(ui.status.length, statusCount);
    assert.equal(timeouts.size, 0);
    assert.equal(intervals.size, 0);
  });
});
