import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHandoffModel } from "../routing.mjs";

test("ordinary models do not load gateway routing or settings", async () => {
  const model = { api: "openai-completions", provider: "openai", id: "chat-model" };
  let settingsRead = false;
  assert.equal(
    await resolveHandoffModel(model, {}, () => {
      settingsRead = true;
      return {};
    }),
    model,
  );
  assert.equal(settingsRead, false);
});
