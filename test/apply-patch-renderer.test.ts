import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { applyPatchRenderers, formatSnapshotDiff } from "../src/apply-patch/renderer.js";
import { renderContextFor, type RenderContextInput } from "./fixtures/harness.js";

/** A theme that adds no styling, so rendered rows can be asserted as plain text. */
const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
	inverse: (text: string): string => text,
} as Theme;

function renderCall(args: unknown, overrides: Partial<RenderContextInput> = {}): string {
	const context = renderContextFor({
		args,
		toolCallId: "patch-call",
		cwd: "/repo",
		...overrides,
	});
	const component = applyPatchRenderers.renderCall!(args, plainTheme, context);
	return component
		.render(300)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

function renderResult(
	details: unknown,
	options: {
		readonly expanded?: boolean;
		readonly isPartial?: boolean;
		readonly isError?: boolean;
		readonly content?: string;
	} = {},
): string {
	const expanded = options.expanded ?? false;
	const isPartial = options.isPartial ?? false;
	const isError = options.isError ?? false;
	const content = options.content ?? "";
	const context = renderContextFor({
		args: { patch: "*** Begin Patch" },
		toolCallId: "patch-call",
		cwd: "/repo",
		expanded,
		isPartial,
		isError,
	});
	const result = {
		content: content === "" ? [] : [{ type: "text" as const, text: content }],
		details,
	};
	const component = applyPatchRenderers.renderResult!(
		result,
		{ expanded, isPartial },
		plainTheme,
		context,
	);
	return component
		.render(300)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

function snapshot(
	path: string,
	before: readonly string[],
	after: readonly string[],
	startLine = 1,
): {
	path: string;
	hunkIndex: number;
	startLine: number;
	afterStartLine: number;
	before: readonly string[];
	after: readonly string[];
} {
	return { path, hunkIndex: 1, startLine, afterStartLine: startLine, before, after };
}

function successDetails(operations: readonly unknown[], applied: readonly unknown[]): unknown {
	return {
		status: "success",
		changedPaths: operations.map((operation) => (operation as { path: string }).path),
		addedLines: 0,
		removedLines: 0,
		operations,
		applied,
		rejected: [],
		unconfirmed: [],
		notApplied: [],
	};
}

describe("formatSnapshotDiff", () => {
	test("numbers context, removed and added lines from the snapshot's own start lines", () => {
		expect(
			formatSnapshotDiff(snapshot("value.txt", ["a", "b", "c"], ["a", "B", "c"], 10)),
		).toBe([" 10 a", "-11 b", "+11 B", " 12 c"].join("\n"));
	});

	test("an added file numbers every line from afterStartLine", () => {
		expect(formatSnapshotDiff(snapshot("new.txt", [], ["x", "y"], 5))).toBe(
			["+5 x", "+6 y"].join("\n"),
		);
	});

	test("a deleted file keeps the old file's numbering", () => {
		expect(formatSnapshotDiff(snapshot("gone.txt", ["x", "y"], [], 3))).toBe(
			["-3 x", "-4 y"].join("\n"),
		);
	});

	test("an empty window produces no diff rows", () => {
		expect(formatSnapshotDiff(snapshot("empty.txt", [], []))).toBe("");
	});
});

describe("apply_patch native renderers", () => {
	test("draws the default Pi shell instead of its own framing", () => {
		expect(applyPatchRenderers.renderShell).toBe("default");
	});

	test("single file: header, collapsed preview and expanded diff", () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line${String(index + 1)}`);
		const patch =
			"*** Begin Patch\n*** Add File: src/new.ts\n" +
			lines.map((line) => `+${line}\n`).join("") +
			"*** End Patch";
		const details = successDetails(
			[{ operationIndex: 0, kind: "add", path: "src/new.ts", status: "applied", addedLines: 30, removedLines: 0 }],
			[{ operationIndex: 0, kind: "add", paths: ["src/new.ts"], outcomes: [], snapshots: [snapshot("src/new.ts", [], lines)] }],
		);

		expect(renderCall({ patch })).toBe("apply_patch src/new.ts (+30 -0)");
		expect(
			renderCall({
				patch: patch.replace("Add File: src/new.ts", "Add File: /repo/src/new.ts"),
			}),
		).toBe("apply_patch src/new.ts (+30 -0)");

		const collapsed = renderResult(details, { content: "Applied patch." }).split("\n");
		// Leading blank line comes from Spacer(1), matching Pi's native edit renderer.
		expect(collapsed).toHaveLength(22);
		expect(collapsed[0]).toBe("");
		expect(collapsed[1]).toBe("+1 line1");
		expect(collapsed[20]).toBe("+20 line20");
		expect(collapsed[21]).toContain("to expand");

		const expanded = renderResult(details, { expanded: true, content: "Applied patch." }).split(
			"\n",
		);
		expect(expanded).toHaveLength(31);
		expect(expanded[0]).toBe("");
		expect(expanded.at(-1)).toBe("+30 line30");
		expect(expanded.join("\n")).not.toContain("to expand");
	});

	test("multi file: one native diff block per file with an operation tag", () => {
		const added = Array.from({ length: 12 }, (_, index) => `a${String(index + 1)}`);
		const patch =
			"*** Begin Patch\n*** Add File: a.ts\n" +
			added.map((line) => `+${line}\n`).join("") +
			"*** Update File: b.ts\n@@\n-old\n+new\n*** End Patch";
		const details = successDetails(
			[
				{ operationIndex: 0, kind: "add", path: "a.ts", status: "applied", addedLines: 12, removedLines: 0 },
				{ operationIndex: 1, kind: "update", path: "b.ts", status: "applied", addedLines: 1, removedLines: 1 },
			],
			[
				{ operationIndex: 0, kind: "add", paths: ["a.ts"], outcomes: [], snapshots: [snapshot("a.ts", [], added)] },
				{ operationIndex: 1, kind: "update", paths: ["b.ts"], outcomes: [], snapshots: [snapshot("b.ts", ["old"], ["new"])] },
			],
		);

		expect(renderCall({ patch })).toBe("apply_patch 2 files (+13 -1)");

		const collapsed = renderResult(details);
		expect(collapsed).toContain("a.ts (+12) added");
		expect(collapsed).toContain("b.ts (+1 -1) updated");
		expect(collapsed).toContain("+1 a1");
		expect(collapsed).toContain("-1 old");
		expect(collapsed).toContain("+1 new");
		expect(collapsed).toContain("... (4 more lines)");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("+12 a12");

		const expanded = renderResult(details, { expanded: true });
		expect(expanded).toContain("+12 a12");
		expect(expanded).not.toContain("... (4 more lines)");
		expect(expanded).not.toContain("to expand");
	});

	test("streaming arguments preview pending rows and accumulate across updates", () => {
		const state = {};
		const firstPatch = "*** Begin Patch\n*** Add File: first.txt\n+one\n";
		const first = renderCall({ patch: firstPatch }, { argsComplete: false, state });
		expect(first).toContain("apply_patch first.txt (+1 -0)");
		expect(first).toContain("pending first.txt (+1)");

		const grownPatch =
			"*** Begin Patch\n*** Add File: first.txt\n+one\n" +
			"*** Update File: second.ts\n@@ old\n-new\n+new\n";
		const second = renderCall({ patch: grownPatch }, { argsComplete: false, state });
		expect(second).toContain("apply_patch 2 files (+2 -1)");
		expect(second).toContain("pending first.txt (+1)");
		expect(second).toContain("pending second.ts (+1 -1)");

		const settled = renderCall({ patch: grownPatch }, { argsComplete: true, state });
		expect(settled).toBe("apply_patch 2 files (+2 -1)");
	});

	test("live partial results show status rows with per-file deltas", () => {
		const details = {
			status: "success",
			changedPaths: [],
			addedLines: 5,
			removedLines: 3,
			operations: [
				{ operationIndex: 0, kind: "update", path: "a.txt", status: "applied", addedLines: 1, removedLines: 1 },
				{ operationIndex: 1, kind: "update", path: "b.txt", status: "pending", addedLines: 4, removedLines: 2 },
				{ operationIndex: 2, kind: "add", path: "c.txt", status: "fuzzy", addedLines: 0, removedLines: 0 },
				{ operationIndex: 3, kind: "update", path: "d.txt", status: "rejected", addedLines: 0, removedLines: 0 },
			],
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		};
		const body = renderResult(details, { isPartial: true });
		expect(body).toContain("applied a.txt (+1 -1)");
		expect(body).toContain("pending b.txt (+4 -2)");
		expect(body).toContain("fuzzy c.txt");
		expect(body).toContain("rejected d.txt");
		expect(body.split("\n").every((line) => !line.startsWith("+"))).toBe(true);
	});

	test("partial results keep the applied diff and report hunk diagnostics", () => {
		const details = {
			status: "partial",
			changedPaths: ["b.ts"],
			addedLines: 1,
			removedLines: 1,
			operations: [
				{
					operationIndex: 0,
					kind: "update",
					path: "b.ts",
					status: "partial",
					addedLines: 1,
					removedLines: 1,
					appliedHunks: 1,
					totalHunks: 2,
					partialReason: "hunk 2",
				},
			],
			applied: [
				{
					operationIndex: 0,
					kind: "update",
					paths: ["b.ts"],
					outcomes: [],
					snapshots: [snapshot("b.ts", ["old"], ["new"])],
				},
			],
			rejected: [
				{
					operationIndices: [0],
					paths: ["b.ts"],
					error: "ambiguous",
					diagnostics: [
						{ kind: "ambiguous_exact", hunkIndex: 2, candidateStartLines: [10, 20, 30] },
						{ kind: "context_not_found", hunkIndex: 3, hint: "near line 4" },
					],
				},
			],
			unconfirmed: [
				{ operationIndices: [1], paths: ["u.ts"], error: "publish unconfirmed", diagnostics: [] },
			],
			notApplied: [
				{ operationIndices: [2], paths: ["n.ts"], error: "lock held", diagnostics: [] },
			],
		};
		const body = renderResult(details, { content: "Patch partially applied.", isError: true });
		expect(body).toContain("b.ts partial (1/2 hunks; hunk 2)");
		expect(body).toContain("-1 old");
		expect(body).toContain("+1 new");
		expect(body).toContain("exact context is ambiguous at lines 10, 20, 30 (3 candidates)");
		expect(body).toContain("context not found (near line 4)");
		expect(body).toContain("unconfirmed u.ts · publish unconfirmed");
		expect(body).toContain("not applied n.ts · lock held");
	});

	test("falls back to result text when structured details are absent", () => {
		expect(renderResult({}, { content: "Patch was not applied.", isError: true })).toBe(
			"\nPatch was not applied.",
		);
		expect(
			renderResult(
				{ status: "failed", operations: [], applied: [], rejected: [], unconfirmed: [], notApplied: [] },
				{ content: "Patch was not applied.", isError: true },
			),
		).toBe("\nPatch was not applied.");
		expect(renderResult(undefined, { content: "Applied patch." })).toBe("\nApplied patch.");
	});
});
