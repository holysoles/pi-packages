export async function resolveHandoffModel(model, ctx, getGlobalSettings) {
  if (model.api !== "pi-virtual" || model.provider !== "fallback") return model;

  const { parsePrivateLlmGatewaySettings, resolveFallbackModel } = await import(
    "@holysoles/pi-gatewayhelper/routing"
  );
  const gatewaySettings = parsePrivateLlmGatewaySettings(getGlobalSettings());
  if (!gatewaySettings) {
    throw new Error("Private LLM gateway settings are missing or invalid");
  }
  return resolveFallbackModel(
    model.id,
    ctx,
    gatewaySettings.models,
    gatewaySettings.publicModelFailover,
  );
}
