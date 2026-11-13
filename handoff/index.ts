/**
 * Seamless Handoff Extension
 *
 * Generates a context summary from the current session, then seamlessly opens
 * a new session with that context pre-loaded and the LLM auto-started.
 *
 * Usage:
 *   /handoff                                  — handoff using current model
 *   /handoff anthropic-vertex/claude-haiku-4-5 — handoff and switch model
 *
 * Tab-completes model names from the enabled models list.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	convertToLlm,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { resolveHandoffModel } from "./routing.mjs";

const SUMMARY_REQUEST = `Summarize this session for handoff to a new session. Output only the summary, no preamble. Use exactly this format:

## Project Goal
What we are currently trying to achieve.

## Current Status
What was just completed and what is still in progress.

## Key Decisions
Important architectural or logic choices made in this session (bullet list).

## Active Files
Paths to files that were recently read or modified (bullet list).

## Immediate Next Steps
Exactly what the next task should be, in priority order (bullet list).`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
}

function getHandoffMessages(branch: SessionEntry[]) {
	const compactionIndex = branch.findLastIndex(
		(entry) => entry.type === "compaction",
	);
	if (compactionIndex < 0)
		return branch.map(entryToMessage).filter((message) => message !== undefined);

	const compaction = branch[compactionIndex];
	if (!compaction) return [];
	const firstKeptIndex =
		compaction.type === "compaction"
			? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
			: -1;
	return [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	]
		.map(entryToMessage)
		.filter((message) => message !== undefined);
}

async function editInExternalEditor(
	tui: TUI,
	command: string,
	content: string,
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "handoff.md");
	try {
		writeFileSync(filePath, content, "utf8");
		const [editor, ...args] = command.split(" ");
		tui.stop();
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...args, filePath], {
				stdio: "inherit",
				shell: false,
			});
			child.on("error", () => resolve(null));
			child.on("close", resolve);
		});
		return exitCode === 0
			? readFileSync(filePath, "utf8")
					.replace(/^\uFEFF/, "")
					.replace(/\n$/, "")
			: undefined;
	} finally {
		tui.start();
		tui.requestRender(true);
		rmSync(directory, { recursive: true, force: true });
	}
}

export default function (pi: ExtensionAPI) {
	let cachedModels: string[] = [];

	pi.on("session_start", async (_event, ctx) => {
		const scoped = ctx.scopedModels;
		if (scoped && scoped.length > 0) {
			cachedModels = scoped.map(({ model }) => `${model.provider}/${model.id}`);
		} else {
			cachedModels = ctx.modelRegistry
				.getAvailable()
				.map((m) => `${m.provider}/${m.id}`);
		}
	});

	pi.registerCommand("handoff", {
		description: "Save context and continue seamlessly in a new session",
		argumentHint: "[provider/model]",

		getArgumentCompletions: (prefix: string) => {
			const items = cachedModels.map((id) => ({ value: id, label: id }));
			return prefix ? items.filter((i) => i.value.includes(prefix)) : items;
		},

		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			let completionModel = model;
			try {
				completionModel = await resolveHandoffModel(model, ctx, () =>
					SettingsManager.create(ctx.cwd, getAgentDir(), {
						projectTrusted: ctx.isProjectTrusted(),
					}).getGlobalSettings(),
				);
			} catch (err) {
				ctx.ui.notify(`Handoff failed: ${String(err)}`, "error");
				return;
			}

			// --- Step 1: Parse and validate optional model arg ---
			const modelArg = args.trim();
			let targetProvider: string | undefined;
			let targetModelId: string | undefined;

			if (modelArg) {
				const slashIdx = modelArg.indexOf("/");
				if (slashIdx < 1) {
					ctx.ui.notify("Invalid model format. Use: provider/model-id", "error");
					return;
				}
				targetProvider = modelArg.slice(0, slashIdx);
				targetModelId = modelArg.slice(slashIdx + 1);

				const found = ctx.modelRegistry.find(targetProvider, targetModelId);
				if (!found) {
					ctx.ui.notify(`Model not found: ${modelArg}`, "error");
					return;
				}
			}

			// --- Step 2: Check session has content ---
			const branch = ctx.sessionManager.getBranch();
			if (!branch.some((e) => e.type === "message")) {
				ctx.ui.notify("Nothing to hand off — session is empty", "info");
				return;
			}
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// --- Step 3: Generate a hidden summary with only a spinner in the TUI ---
			let generationError: string | undefined;
			const summary = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						"Generating handoff summary...",
					);
					loader.onAbort = () => done(null);
					const summaryRequest: Message = {
						role: "user",
						content: [{ type: "text", text: SUMMARY_REQUEST }],
						timestamp: Date.now(),
					};
					void ctx.modelRegistry
						.complete(
							completionModel,
							{
								systemPrompt: ctx.getSystemPrompt(),
								messages: [...convertToLlm(getHandoffMessages(branch)), summaryRequest],
							},
							{ signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
						)
						.then((response) => {
							if (response.stopReason === "aborted") {
								done(null);
								return;
							}
							if (response.stopReason === "error") {
								generationError = response.errorMessage ?? "Model request failed";
								done(null);
								return;
							}
							const text = response.content
								.flatMap((content) => (content.type === "text" ? [content.text] : []))
								.join("\n")
								.trim();
							done(text || null);
						})
						.catch((err) => {
							generationError = String(err);
							done(null);
						});
					return loader;
				},
			);

			// --- Step 4: Handle cancellation or empty summary ---
			if (!summary?.trim()) {
				ctx.ui.notify(
					generationError
						? `Handoff failed: ${generationError}`
						: summary === null
							? "Handoff cancelled"
							: "Handoff failed: empty summary",
					generationError || summary !== null ? "error" : "info",
				);
				return;
			}

			const summaryLines = summary.split("\n");
			const preview = summaryLines.slice(0, 25).join("\n");
			const choice = await ctx.ui.select(
				`Handoff summary preview\n\n${preview}${summaryLines.length > 25 ? "\n…" : ""}`,
				["Continue with this summary", "Edit summary"],
			);
			if (!choice) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			const handoffSummary =
				choice === "Edit summary"
					? await ctx.ui.custom<string | undefined>(
							(tui, _theme, _keybindings, done) => {
								const command = SettingsManager.create(ctx.cwd, getAgentDir(), {
									projectTrusted: ctx.isProjectTrusted(),
								}).getExternalEditorCommand();
								void editInExternalEditor(tui, command, summary).then(done);
								return new Text("Opening external editor…", 1, 0);
							},
						)
					: summary;
			if (!handoffSummary?.trim()) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			// --- Step 6: Create new session, inject context, optionally switch model ---
			let newSessionResult: Awaited<ReturnType<typeof ctx.newSession>>;
			try {
				newSessionResult = await ctx.newSession({
					parentSession: currentSessionFile,
					setup: async (sm) => {
						sm.appendCustomMessageEntry(
							"handoff",
							`# Context from previous session\n\n${handoffSummary}`,
							false, // hidden from TUI, present in LLM context
						);
						if (targetProvider && targetModelId) {
							sm.appendModelChange(targetProvider, targetModelId);
						}
					},
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify("Handoff complete. Enter the next step.", "info");
					},
				});
			} catch (err) {
				ctx.ui.notify(`Failed to open new session: ${String(err)}`, "error");
				return;
			}

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
