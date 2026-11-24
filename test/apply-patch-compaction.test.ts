import type {
	FileOperations,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
	collectApplyPatchFileOps,
	extractPatchHeaderFileOps,
	registerApplyPatchCompaction,
} from "../src/apply-patch/compaction.js";
// Pi does not export its compaction utils from the package root; the integration check runs
// against the real functions so fileOps semantics cannot drift from Pi's own reader.
import {
	computeFileLists,
	formatFileOperations,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js";

type Preparation = SessionBeforeCompactEvent["preparation"];
type Message = Preparation["messagesToSummarize"][number];

function createFileOps(): FileOperations {
	return { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
}

function toolResult(options: {
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly details?: unknown;
	readonly nestedCalls?: unknown;
}): Message {
	return {
		role: "toolResult",
		toolCallId: options.toolCallId ?? "call-1",
		toolName: options.toolName ?? "apply_patch",
		content: [],
		isError: false,
		timestamp: 0,
		...("details" in options ? { details: options.details } : {}),
		...("nestedCalls" in options ? { nestedCalls: options.nestedCalls } : {}),
	} as unknown as Message;
}

function assistantCall(callId: string, patch: string, name = "apply_patch"): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: { patch } }],
		api: "fake",
		provider: "fake",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
		timestamp: 0,
	} as unknown as Message;
}

function collect(
	messagesToSummarize: readonly Message[],
	turnPrefixMessages: readonly Message[] = [],
	fileOps: FileOperations = createFileOps(),
): FileOperations {
	collectApplyPatchFileOps({
		messagesToSummarize: [...messagesToSummarize],
		turnPrefixMessages: [...turnPrefixMessages],
		fileOps,
	});
	return fileOps;
}

function details(overrides: Record<string, unknown>): Record<string, unknown> {
	return { status: "success", addedLines: 0, removedLines: 0, changedPaths: [], ...overrides };
}

describe("extractPatchHeaderFileOps", () => {
	test("reads add, update, move and delete headers across CRLF and LF", () => {
		const ops = extractPatchHeaderFileOps(
			"*** Begin Patch\r\n" +
				"*** Add File: added.txt\r\n" +
				"+one\r\n" +
				"*** Update File: updated.txt\r\n" +
				"*** Move to: moved.txt\r\n" +
				"-old\r\n" +
				"+new\r\n" +
				"*** Delete File: deleted.txt\r\n" +
				"*** End Patch",
		);
		expect(ops.written).toEqual(["added.txt"]);
		expect(ops.edited).toEqual(["updated.txt", "moved.txt", "deleted.txt"]);
	});

	test("ignores malformed headers, empty paths and repeated paths without throwing", () => {
		const ops = extractPatchHeaderFileOps(
			"*** Add File:\n" +
				"*** Update File:   \n" +
				"*** Move to: target.txt\n" +
				"*** Add File: same.txt\n" +
				"*** Add File: same.txt\n" +
				"*** Update File: tail.txt",
		);
		expect(ops.written).toEqual(["same.txt"]);
		expect(ops.edited).toEqual(["target.txt", "tail.txt"]);
	});

	test("does not read context lines that merely contain a header", () => {
		const ops = extractPatchHeaderFileOps(
			"*** Begin Patch\n" +
				"*** Update File: real.txt\n" +
				" *** Add File: context.txt\n" +
				"+inserted\n" +
				"*** End Patch",
		);
		expect(ops.written).toEqual([]);
		expect(ops.edited).toEqual(["real.txt"]);
	});
});

describe("collectApplyPatchFileOps", () => {
	test("records applied add, update, rename and delete details", () => {
		const fileOps = collect([
			toolResult({
				details: details({
					applied: [
						{ kind: "add", paths: ["new.txt"], outcomes: [], snapshots: [] },
						{ kind: "update", paths: ["old.txt", "moved.txt"], outcomes: [], snapshots: [] },
						{ kind: "delete", paths: ["gone.txt"], outcomes: [], snapshots: [] },
					],
					changedPaths: ["new.txt", "moved.txt"],
				}),
			}),
		]);
		expect([...fileOps.written]).toEqual(["new.txt"]);
		expect([...fileOps.edited]).toEqual(["old.txt", "moved.txt", "gone.txt"]);
	});

	test("partial apply records only confirmed operations and excludes rejected ones", () => {
		const fileOps = collect([
			toolResult({
				details: details({
					status: "partial",
					applied: [],
					operations: [
						{ operationIndex: 0, kind: "add", path: "kept.txt", status: "applied" },
						{ operationIndex: 1, kind: "update", path: "fuzzy.txt", status: "fuzzy" },
						{ operationIndex: 2, kind: "update", path: "rejected.txt", status: "rejected" },
						{ operationIndex: 3, kind: "delete", path: "unconfirmed.txt", status: "unconfirmed" },
					],
					changedPaths: ["kept.txt", "unknown-confirmed.txt"],
				}),
			}),
		]);
		expect([...fileOps.written]).toEqual(["kept.txt"]);
		expect([...fileOps.edited]).toEqual(["fuzzy.txt", "unknown-confirmed.txt"]);
		expect(fileOps.written.has("rejected.txt")).toBe(false);
		expect(fileOps.edited.has("rejected.txt")).toBe(false);
		expect(fileOps.edited.has("unconfirmed.txt")).toBe(false);
	});

	test("a fully failed patch records nothing and does not fall back to its call args", () => {
		const patch = "*** Begin Patch\n*** Add File: wanted.txt\n+nope\n*** End Patch";
		const fileOps = collect([
			assistantCall("failed-call", patch),
			toolResult({
				toolCallId: "failed-call",
				details: details({
					status: "failed",
					applied: [],
					operations: [{ operationIndex: 0, kind: "add", path: "wanted.txt", status: "rejected" }],
					changedPaths: [],
				}),
			}),
		]);
		expect(fileOps.written.size).toBe(0);
		expect(fileOps.edited.size).toBe(0);
	});

	test("falls back to assistant call args when the result has no structured details", () => {
		const patch =
			"*** Begin Patch\n*** Add File: created.txt\n+one\n*** Delete File: removed.txt\n*** End Patch";
		const fileOps = collect([
			assistantCall("unstructured-call", patch),
			toolResult({ toolCallId: "unstructured-call", details: { message: "no structured outcome" } }),
		]);
		expect([...fileOps.written]).toEqual(["created.txt"]);
		expect([...fileOps.edited]).toEqual(["removed.txt"]);
	});

	test("a structured result suppresses the call-arg fallback for the same call", () => {
		const patch = "*** Begin Patch\n*** Add File: from-args.txt\n+x\n*** End Patch";
		const fileOps = collect([
			assistantCall("handled-call", patch),
			toolResult({
				toolCallId: "handled-call",
				details: details({
					applied: [{ kind: "add", paths: ["from-details.txt"], outcomes: [], snapshots: [] }],
					changedPaths: ["from-details.txt"],
				}),
			}),
		]);
		expect([...fileOps.written]).toEqual(["from-details.txt"]);
	});

	test("records codemode nested apply_patch calls", () => {
		const fileOps = collect([
			toolResult({
				toolName: "codemode",
				details: { ok: true },
				nestedCalls: {
					complete: true,
					calls: [
						{
							id: "nested-1",
							name: "apply_patch",
							status: "ok",
							arguments: {
								patch:
									"*** Begin Patch\n*** Update File: nested.txt\n*** Move to: nested-moved.txt\n*** End Patch",
							},
						},
						{ id: "nested-2", name: "read", status: "ok", arguments: { path: "ignored.txt" } },
					],
				},
			}),
		]);
		expect([...fileOps.edited]).toEqual(["nested.txt", "nested-moved.txt"]);
		expect(fileOps.read.size).toBe(0);
		expect(fileOps.written.size).toBe(0);
	});

	test("scans split-turn turnPrefixMessages as well as summarized messages", () => {
		const fileOps = collect(
			[
				toolResult({
					toolCallId: "summarized",
					details: details({
						applied: [{ kind: "add", paths: ["summarized.txt"], outcomes: [], snapshots: [] }],
						changedPaths: ["summarized.txt"],
					}),
				}),
			],
			[
				assistantCall(
					"prefix",
					"*** Begin Patch\n*** Delete File: prefix.txt\n*** End Patch",
				),
			],
		);
		expect([...fileOps.written]).toEqual(["summarized.txt"]);
		expect([...fileOps.edited]).toEqual(["prefix.txt"]);
	});

	test("feeds Pi's computeFileLists and formatFileOperations", () => {
		const fileOps = createFileOps();
		fileOps.read.add("read-only.txt");
		collect(
			[
				toolResult({
					details: details({
						applied: [
							{ kind: "add", paths: ["created.txt"], outcomes: [], snapshots: [] },
							{ kind: "update", paths: ["edited.txt", "renamed.txt"], outcomes: [], snapshots: [] },
						],
						changedPaths: ["created.txt", "edited.txt", "renamed.txt"],
					}),
				}),
			],
			[],
			fileOps,
		);
		fileOps.read.add("edited.txt");

		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["read-only.txt"]);
		expect(modifiedFiles).toEqual(["created.txt", "edited.txt", "renamed.txt"]);
		expect(formatFileOperations(readFiles, modifiedFiles)).toBe(
			"\n\n<read-files>\nread-only.txt\n</read-files>\n\n" +
				"<modified-files>\ncreated.txt\nedited.txt\nrenamed.txt\n</modified-files>",
		);
	});

	test("registers a session_before_compact collector that mutates preparation.fileOps", () => {
		const handlers = new Map<string, (event: unknown) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown) => void): (() => void) => {
				handlers.set(event, handler);
				return () => undefined;
			},
		};
		registerApplyPatchCompaction(pi as unknown as Parameters<typeof registerApplyPatchCompaction>[0]);
		const handler = handlers.get("session_before_compact");
		if (handler === undefined) throw new Error("expected a session_before_compact handler");
		const fileOps = createFileOps();
		handler({
			preparation: {
				messagesToSummarize: [
					toolResult({
						details: details({
							applied: [{ kind: "add", paths: ["registered.txt"], outcomes: [], snapshots: [] }],
							changedPaths: ["registered.txt"],
						}),
					}),
				],
				turnPrefixMessages: [],
				fileOps,
			},
		});
		expect([...fileOps.written]).toEqual(["registered.txt"]);
	});
});
