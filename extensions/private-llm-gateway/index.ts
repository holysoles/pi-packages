import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseFallbackRoute, parsePrivateLlmGatewaySettings } from "./fallback-model-routing.mjs";

function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), ".pi", "agent");
}

type JsonRecord = Record<string, unknown>;
type ModelMapping = {
  private: { provider: string; id: string };
  public: { provider: string; id: string };
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPricedCost(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  return Object.values(value).some((price) => typeof price === "number" && Number.isFinite(price))
    ? value
    : undefined;
}

function updateMappedCosts(
  configuration: unknown,
  catalog: unknown,
  models: Record<string, ModelMapping>,
) {
  const warnings: string[] = [];
  const changedModels = new Set<string>();
  if (!isRecord(configuration) || !isRecord(configuration.providers)) {
    return { changed: false, changedModels: [], warnings: ["models.json has no providers object; pricing was not synchronized."] };
  }
  if (!isRecord(catalog)) {
    return { changed: false, changedModels: [], warnings: ["models-store.json is not a provider catalog; pricing was not synchronized."] };
  }

  for (const mapping of Object.values(models)) {
    const privateProvider = configuration.providers[mapping.private.provider];
    const privateModels = isRecord(privateProvider) && Array.isArray(privateProvider.models)
      ? privateProvider.models.filter(
          (model): model is JsonRecord => isRecord(model) && model.id === mapping.private.id,
        )
      : [];
    if (privateModels.length === 0) {
      warnings.push(`No configured private model found for ${mapping.private.provider}/${mapping.private.id}; its cost was left unchanged.`);
    }

    const publicProvider = catalog[mapping.public.provider];
    const publicModels = isRecord(publicProvider) && Array.isArray(publicProvider.models)
      ? publicProvider.models
      : [];
    const publicModel = publicModels.find((model): model is JsonRecord => {
      return isRecord(model) && model.id === mapping.public.id &&
        model.type === "chat" && getPricedCost(model.cost) !== undefined;
    });
    const publicCost = publicModel && getPricedCost(publicModel.cost);
    if (!publicCost) {
      warnings.push(`No priced public chat model found for ${mapping.public.provider}/${mapping.public.id}; ${mapping.private.provider}/${mapping.private.id} was left unchanged.`);
      continue;
    }

    for (const privateModel of privateModels) {
      if (isDeepStrictEqual(privateModel.cost, publicCost)) continue;
      privateModel.cost = { ...publicCost };
      changedModels.add(`${mapping.private.provider}/${mapping.private.id}`);
    }
  }

  return { changed: changedModels.size > 0, changedModels: [...changedModels], warnings };
}

function notifyWarnings(ctx: any, warnings: string[]) {
  for (const warning of warnings) ctx.ui.notify(`Private model price sync: ${warning}`, "warning");
}

async function acquireModelLock(lockPath: string) {
  const token = `${process.pid}:${randomUUID()}`;
  const ownerPath = join(lockPath, "owner");
  const deadline = Date.now() + 90_000;
  while (true) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let stale = false;
      try {
        const [owner, lockStats] = await Promise.all([
          readFile(ownerPath, "utf8").catch((readError: NodeJS.ErrnoException) => {
            if (readError.code !== "ENOENT") throw readError;
            return undefined;
          }),
          stat(lockPath),
        ]);
        if (owner !== undefined) {
          const match = /^(\d+):/.exec(owner);
          if (match) {
            const pid = Number(match[1]);
            let processAlive = true;
            try {
              process.kill(pid, 0);
            } catch (processError) {
              if ((processError as NodeJS.ErrnoException).code === "ESRCH") processAlive = false;
            }
            stale = !processAlive;
          } else {
            stale = Date.now() - lockStats.mtimeMs > 30_000;
          }
        } else {
          stale = Date.now() - lockStats.mtimeMs > 30_000;
        }
      } catch (inspectError) {
        if ((inspectError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectError;
      }
      if (stale) {
        const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the models.json price-sync lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }

    try {
      await writeFile(ownerPath, token, { flag: "wx" });
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }

    return async () => {
      try {
        if ((await readFile(ownerPath, "utf8")) === token) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }
}

async function readJsonText(path: string) {
  const text = await readFile(path, "utf8");
  return { text, value: JSON.parse(text) as unknown };
}

async function replaceModelsFile(resolvedPath: string, configuration: unknown, expectedSource: string) {
  // Replacing the resolved target preserves models.json symlinks and its file permissions.
  const fileStats = await stat(resolvedPath);
  const mode = fileStats.mode & 0o7777;
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, "utf8");
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if ((await readFile(resolvedPath, "utf8")) !== expectedSource) return false;
    await rename(temporaryPath, resolvedPath);
    renamed = true;
    return true;
  } finally {
    if (!renamed) await rm(temporaryPath, { force: true });
  }
}

async function synchronizeMappedPrices(models: Record<string, ModelMapping>, ctx: any) {
  const agentDir = getAgentDir();
  const modelsPath = join(agentDir, "models.json");
  const catalogPath = join(agentDir, "models-store.json");
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const resolvedModelsPath = await realpath(modelsPath);
    let source = await readJsonText(resolvedModelsPath);
    let catalog = await readJsonText(catalogPath);
    let result = updateMappedCosts(source.value, catalog.value, models);
    if (!result.changed) {
      notifyWarnings(ctx, result.warnings);
      return;
    }

    // Lock the physical target so all symlink aliases coordinate on the same file.
    releaseLock = await acquireModelLock(`${resolvedModelsPath}.lock`);
    for (let attempt = 0; attempt < 3; attempt++) {
      // Re-read under the lock and again immediately before rename to preserve external edits.
      source = await readJsonText(resolvedModelsPath);
      catalog = await readJsonText(catalogPath);
      result = updateMappedCosts(source.value, catalog.value, models);
      if (!result.changed) {
        notifyWarnings(ctx, result.warnings);
        return;
      }
      if (await replaceModelsFile(resolvedModelsPath, source.value, source.text)) {
        notifyWarnings(ctx, result.warnings);
        if (releaseLock) {
          const release = releaseLock;
          releaseLock = undefined;
          try {
            await release();
          } catch (error) {
            ctx.ui.notify(`Private model price sync could not release its lock: ${String(error)}`, "warning");
          }
        }
        try {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
        } catch (error) {
          ctx.ui.notify(`Private model price sync: model registry refresh failed: ${String(error)}`, "warning");
        }
        ctx.ui.notify(`Synchronized private model pricing for ${result.changedModels.join(", ")}.`, "info");
        return;
      }
    }
    throw new Error("models.json changed repeatedly during price sync; pricing was not synchronized");
  } catch (error) {
    ctx.ui.notify(`Private model price sync failed: ${String(error)}`, "warning");
  } finally {
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        ctx.ui.notify(`Private model price sync could not release its lock: ${String(error)}`, "warning");
      }
    }
  }
}

function readGlobalSettings() {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const settings = parsePrivateLlmGatewaySettings(readGlobalSettings());
  if (!settings) return;

  for (const id of Object.keys(settings.models)) {
    pi.registerVirtualModel<boolean>({
      provider: "fallback",
      id,
      name: id,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      route(request, ctx) {
        const mapping = settings.models[id];
        const failedPrivate = request.reason === "retry" &&
          request.failed?.model.provider === mapping.private.provider &&
          request.failed?.model.id === mapping.private.id;
        const preferPublic = request.state === true || failedPrivate;
        const route = chooseFallbackRoute(
          id,
          ctx,
          preferPublic,
          settings.models,
          settings.publicModelFailover,
        );
        return { ...route, thinkingLevel: request.thinkingLevel };
      },
    });
  }

  if (settings.priceSync && Object.keys(settings.models).length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      await synchronizeMappedPrices(settings.models, ctx);
    });
  }
}
