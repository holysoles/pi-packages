const PROVIDER_AUTH_ERROR =
  "Daily spend is not configured: set privateLlmGateway.spend.provider to a provider with an API key.";
const ORIGIN_ERROR =
  "Daily spend is not configured: dashboardOrigin must be an HTTPS origin without credentials, path, query, or fragment.";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_MINUTES = 15;
const STATUS_KEY = "gatewayhelper-spend";
const SETUP_MESSAGE =
  "Daily spend is not configured: add privateLlmGateway.spend.provider and dashboardOrigin to global settings.";
const LOGIN_LANDING_PATHS = new Set(["/account", "/dashboard", "/manager"]);

class SpendClientError extends Error {}

export async function resolveSpendApiKey(providerId, ctx) {
  if (typeof providerId !== "string" || providerId.trim().length === 0) {
    throw new Error(PROVIDER_AUTH_ERROR);
  }

  let result;
  try {
    result = await ctx.modelRegistry.getProviderAuth(providerId);
  } catch {
    throw new Error(PROVIDER_AUTH_ERROR);
  }

  const apiKey = result?.auth?.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(PROVIDER_AUTH_ERROR);
  }
  return apiKey;
}

function getDashboardOrigin(value) {
  if (typeof value !== "string" || value.trim() !== value) throw new Error(ORIGIN_ERROR);
  const match = /^https:\/\/([^/?#]*)(.*)$/i.exec(value);
  if (!match || match[1].includes("@") || !["", "/"].includes(match[2])) {
    throw new Error(ORIGIN_ERROR);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(ORIGIN_ERROR);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname ||
    url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new Error(ORIGIN_ERROR);
  }
  return url.origin;
}

function isSameOriginUrl(location, origin, basePath) {
  if (typeof location !== "string" || location.length === 0) return undefined;
  try {
    const url = new URL(location, `${origin}${basePath}`);
    if (url.origin !== origin || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function isLoginLanding(location, origin) {
  const url = isSameOriginUrl(location, origin, "/login");
  return Boolean(url && LOGIN_LANDING_PATHS.has(url.pathname) && !url.search && !url.hash);
}

function isLoginRedirect(location, origin) {
  const url = isSameOriginUrl(location, origin, "/api/v1/me/usage/summary");
  return Boolean(url && url.pathname === "/login" && !url.search && !url.hash);
}

function getSessionCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const header of values) {
    const pair = header.split(";", 1)[0].trim();
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== "metering_session") continue;
    const value = pair.slice(separator + 1).trim();
    if (value) return `metering_session=${value}`;
  }
  return undefined;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // A response being closed cannot affect the request result.
  }
}

function localDate(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function nextLocalMidnight(day) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}

function summaryRange(date, useLocalDay) {
  const start = new Date(`${date}T00:00:00${useLocalDay ? "" : "Z"}`);
  const parsedDate = Number.isFinite(start.getTime()) &&
    (useLocalDay ? localDate(start) : start.toISOString().slice(0, 10));
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || parsedDate !== date) {
    throw new SpendClientError("Daily spend date must be a valid calendar date.");
  }
  return useLocalDay
    ? { range: "exact", from: start.toISOString(), to: nextLocalMidnight(start).toISOString() }
    : { range: "custom", from: date, to: date };
}

async function request(fetchImpl, url, init, signal, consume) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const response = await fetchImpl(url, {
      ...init,
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    return await consume(response);
  } catch (error) {
    if (error instanceof SpendClientError) throw error;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (timedOut) throw new SpendClientError("Daily spend request timed out.");
    throw new SpendClientError("Daily spend request failed.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createSpendClient(config, ctx, fetchImpl = globalThis.fetch) {
  const origin = getDashboardOrigin(config?.dashboardOrigin);
  const providerId = config?.provider;
  const useLocalDay = config?.useLocalDay === true;
  const { refreshIntervalMinutes = DEFAULT_REFRESH_MINUTES } = config;
  if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 1 || refreshIntervalMinutes > 1440) {
    throw new SpendClientError("Daily spend refreshIntervalMinutes must be a whole number from 1 to 1440.");
  }
  let sessionCookie;

  async function login(signal) {
    const apiKey = await resolveSpendApiKey(providerId, ctx);
    const body = new URLSearchParams({ api_key: apiKey }).toString();
    const cookie = await request(fetchImpl, `${origin}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: origin,
      },
      body,
    }, signal, async (response) => {
      const location = response.headers.get("location");
      const cookie = getSessionCookie(response.headers);
      await cancelBody(response);
      if (response.status !== 302 || !isLoginLanding(location, origin) || !cookie) {
        throw new SpendClientError(`Daily spend login failed (HTTP ${response.status}).`);
      }
      return cookie;
    });
    sessionCookie = cookie;
  }

  async function fetchSummary(window, signal) {
    const query = new URLSearchParams(window);
    return request(fetchImpl, `${origin}/api/v1/me/usage/summary?${query}`, {
      method: "GET",
      headers: { Cookie: sessionCookie, Accept: "application/json" },
    }, signal, async (response) => {
      const location = response.headers.get("location");
      if (response.status === 302) {
        await cancelBody(response);
        if (isLoginRedirect(location, origin)) return { expired: true };
        throw new SpendClientError("Daily spend summary returned an unexpected redirect.");
      }
      if (response.status !== 200) {
        await cancelBody(response);
        throw new SpendClientError(`Daily spend summary failed (HTTP ${response.status}).`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        await cancelBody(response);
        throw new SpendClientError("Daily spend summary returned invalid JSON.");
      }
      if (useLocalDay && (Date.parse(payload?.window?.from) !== Date.parse(window.from) ||
          Date.parse(payload?.window?.to) !== Date.parse(window.to))) {
        throw new SpendClientError("PriceTag did not confirm the requested window. The server may need an upgrade.");
      }
      const total = payload?.overview?.total_cost_usd;
      if (typeof total !== "number" || !Number.isFinite(total)) {
        throw new SpendClientError("Daily spend summary returned an invalid total.");
      }
      return { total };
    });
  }

  return {
    useLocalDay,
    refreshIntervalMinutes,
    async getDailyTotal(date, { signal } = {}) {
      const window = summaryRange(date, useLocalDay);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!sessionCookie) await login(signal);
        const result = await fetchSummary(window, signal);
        if (!result.expired) return result.total;
        sessionCookie = undefined;
        if (attempt === 1) {
          throw new SpendClientError("Daily spend session expired after one retry.");
        }
      }
      throw new SpendClientError("Daily spend request failed.");
    },
  };
}

export function createSpendLifecycle(client, showFooter, ctx, setupError) {
  let disposed = false;
  let interval;
  let midnightTimeout;
  const requests = new Map();
  const dayLabel = client?.useLocalDay ? "local" : "UTC";
  const currentDate = client?.useLocalDay ? localDate : () => new Date().toISOString().slice(0, 10);
  const footerEnabled = showFooter && ctx.mode === "tui" && typeof ctx.ui.setStatus === "function";

  function setStatus(value) {
    if (!disposed && footerEnabled) ctx.ui.setStatus(STATUS_KEY, value);
  }

  function getTotal(date) {
    let request = requests.get(date);
    if (!request) {
      const controller = new AbortController();
      const promise = setupError
        ? Promise.reject(new Error(setupError))
        : client.getDailyTotal(date, { signal: controller.signal });
      request = { controller, promise };
      requests.set(date, request);
      promise.finally(() => {
        if (requests.get(date) === request) requests.delete(date);
      }).catch(() => {});
    }
    return request.promise;
  }

  async function refreshFooter() {
    if (disposed || !footerEnabled) return;
    const date = currentDate();
    try {
      const total = await getTotal(date);
      if (!disposed && currentDate() === date) {
        setStatus(`Daily spend: $${total.toFixed(2)}`);
      }
    } catch {
      if (!disposed && currentDate() === date) setStatus("Daily spend: unavailable");
    }
  }

  function scheduleMidnight() {
    const now = new Date();
    const next = client?.useLocalDay ? nextLocalMidnight(now).getTime()
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    midnightTimeout = setTimeout(() => {
      if (disposed) return;
      setStatus(undefined);
      void refreshFooter();
      scheduleMidnight();
    }, next - now.getTime());
  }

  async function command() {
    if (disposed) return;
    const date = currentDate();
    try {
      const total = await getTotal(date);
      if (disposed) return;
      if (currentDate() !== date) {
        ctx.ui.notify(`The ${dayLabel} date changed while fetching daily spend; rerun /spend.`, "warning");
        return;
      }
      ctx.ui.notify(`Daily spend (${date} ${dayLabel}): $${total.toFixed(2)}`, "info");
      if (footerEnabled) setStatus(`Daily spend: $${total.toFixed(2)}`);
    } catch (error) {
      if (disposed) return;
      if (currentDate() !== date) {
        ctx.ui.notify(`The ${dayLabel} date changed while fetching daily spend; rerun /spend.`, "warning");
        return;
      }
      if (footerEnabled) setStatus("Daily spend: unavailable");
      ctx.ui.notify(error instanceof Error ? error.message : "Daily spend request failed.", "error");
    }
  }

  return {
    start() {
      if (disposed || !footerEnabled) return;
      setStatus("Daily spend: loading…");
      void refreshFooter();
      const refreshMinutes = client?.refreshIntervalMinutes ?? DEFAULT_REFRESH_MINUTES;
      interval = setInterval(() => { void refreshFooter(); }, refreshMinutes * 60 * 1000);
      scheduleMidnight();
    },
    command,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) clearInterval(interval);
      if (midnightTimeout !== undefined) clearTimeout(midnightTimeout);
      for (const { controller } of requests.values()) controller.abort();
    },
  };
}

export { SETUP_MESSAGE };
