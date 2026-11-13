function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEndpoint(value) {
  return isRecord(value) &&
    typeof value.provider === "string" && value.provider.trim().length > 0 &&
    typeof value.id === "string" && value.id.trim().length > 0;
}

export function parsePrivateLlmGatewaySettings(settings) {
  if (!isRecord(settings) || !Object.hasOwn(settings, "privateLlmGateway")) return undefined;

  const section = settings.privateLlmGateway;
  if (!isRecord(section) || !Object.hasOwn(section, "models")) return undefined;
  if (!isRecord(section.models)) return undefined;
  if (section.publicModelFailover !== undefined && typeof section.publicModelFailover !== "boolean") {
    return undefined;
  }
  if (section.priceSync !== undefined && typeof section.priceSync !== "boolean") return undefined;

  const modelEntries = [];
  for (const [id, mapping] of Object.entries(section.models)) {
    if (id.trim().length === 0 || !isRecord(mapping) ||
      !isEndpoint(mapping.private) || !isEndpoint(mapping.public)) {
      return undefined;
    }
    modelEntries.push([id, {
      private: { provider: mapping.private.provider, id: mapping.private.id },
      public: { provider: mapping.public.provider, id: mapping.public.id },
    }]);
  }

  return {
    models: Object.fromEntries(modelEntries),
    publicModelFailover: section.publicModelFailover ?? true,
    priceSync: section.priceSync ?? true,
  };
}

export function chooseFallbackRoute(id, ctx, preferPublic, models, publicModelFailover = true) {
  const mapping = models?.[id];
  if (!mapping) throw new Error(`No mapping configured for ${id}`);
  if (preferPublic && !publicModelFailover) {
    throw new Error(`Public model failover is disabled for ${id}`);
  }

  const privateModel = ctx.modelRegistry.find(mapping.private.provider, mapping.private.id);
  if (!publicModelFailover) {
    if (!privateModel || !ctx.modelRegistry.hasConfiguredAuth(privateModel)) {
      throw new Error(`No available model for ${id}`);
    }
    return { model: privateModel, state: undefined };
  }

  const usePublic = preferPublic || !privateModel || !ctx.modelRegistry.hasConfiguredAuth(privateModel);
  const model = usePublic
    ? ctx.modelRegistry.find(mapping.public.provider, mapping.public.id)
    : privateModel;
  if (!model) throw new Error(`No available model for ${id}`);
  return { model, state: usePublic || undefined };
}

export function resolveFallbackModel(id, ctx, models, publicModelFailover = true) {
  return chooseFallbackRoute(id, ctx, false, models, publicModelFailover).model;
}
