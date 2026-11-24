import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { diffArrays } from "diff";
import {
	type ApplyPatchHunkSnapshot,
	type ApplyPatchOperationProgress,
	type ApplyPatchOperationStatus,
	type ApplyPatchRejection,
	CONFIRMED_STATUSES,
	type RejectedPatchHunk,
} from "./outcome.js";
import {
	createV4aPreviewCursor,
	previewV4aPatchPrefix,
	type V4aPreviewCursor,
	type V4aPreviewOperation,
} from "./parser.js";
import { isRecord } from "./support.js";
import { type ApplyPatchResultFacts, applyPatchResultFacts } from "./view.js";

const SINGLE_FILE_PREVIEW_LINES = 20;
const MULTI_FILE_PREVIEW_LINES = 8;
const MAX_CANDIDATE_LINES = 6;

type RenderOperation = ApplyPatchOperationProgress;
type RenderRejection = ApplyPatchRejection;
type RenderDetails = ApplyPatchResultFacts;

const STATUS_TONE: Record<
	ApplyPatchOperationStatus,
	"dim" | "success" | "warning" | "error"
> = {
	pending: "dim",
	applied: "success",
	partial: "warning",
	fuzzy: "warning",
	unconfirmed: "warning",
	not_applied: "dim",
	rejected: "error",
};

const STATUS_LABEL: Record<ApplyPatchOperationStatus, string> = {
	pending: "pending",
	applied: "applied",
	partial: "partial",
	fuzzy: "fuzzy",
	unconfirmed: "unconfirmed",
	not_applied: "not applied",
	rejected: "rejected",
};



/**
 * Pi's `renderDiff` reads the module-level theme and throws before `initTheme()`. Display-only
 * processes and tests that pass their own theme take the local fallback, which keeps the visible
 * text identical.
 */
const DIFF_LINE = /^([+-\s])(\s*\d*)\s(.*)$/;

function fallbackDiff(diffText: string, theme: Theme): string {
	return diffText
		.split("\n")
		.map((line) => {
			const match = DIFF_LINE.exec(line);
			if (match === null) return theme.fg("toolDiffContext", line);
			const prefix = match[1] ?? " ";
			const content = match[3] ?? "";
			if (prefix === "+")
				return theme.fg("toolDiffAdded", `+${match[2] ?? ""} ${content}`);
			if (prefix === "-")
				return theme.fg("toolDiffRemoved", `-${match[2] ?? ""} ${content}`);
			return theme.fg("toolDiffContext", ` ${match[2] ?? ""} ${content}`);
		})
		.join("\n");
}

function renderDiffBody(diffText: string, theme: Theme): string {
	if (diffText === "") return "";
	try {
		return renderDiff(diffText);
	} catch {
		return fallbackDiff(diffText, theme);
	}
}

/**
 * One snapshot as Pi's line-numbered diff text: ` N line`, `-N line` and `+N line`. Removed lines
 * use the old file's numbering (`startLine`) and added or context lines the new file's
 * (`afterStartLine`), so Pi's renderer pairs adjacent removals and additions for intra-line word
 * diffing.
 */
export function formatSnapshotDiff(snapshot: ApplyPatchHunkSnapshot): string {
	const rows: string[] = [];
	let oldLine = snapshot.startLine;
	let newLine = snapshot.afterStartLine;
	for (const part of diffArrays([...snapshot.before], [...snapshot.after])) {
		for (const text of part.value) {
			if (part.added === true) {
				rows.push(`+${String(newLine)} ${text}`);
				newLine += 1;
			} else if (part.removed === true) {
				rows.push(`-${String(oldLine)} ${text}`);
				oldLine += 1;
			} else {
				rows.push(` ${String(newLine)} ${text}`);
				oldLine += 1;
				newLine += 1;
			}
		}
	}
	return rows.join("\n");
}

function patchArgument(args: unknown): string {
	return isRecord(args) && typeof args.patch === "string" ? args.patch : "";
}

/**
 * Preview cursors are display-only stream position, keyed by the row's shared render state. They are
 * never persisted and rebuilding one only re-reads the same arguments.
 */
const previewCursors = new WeakMap<object, V4aPreviewCursor>();

function previewOperations(
	patch: string,
	context: { readonly state: unknown; readonly argsComplete: boolean },
): readonly V4aPreviewOperation[] {
	const key =
		typeof context.state === "object" && context.state !== null ? context.state : undefined;
	const cursor =
		key === undefined
			? createV4aPreviewCursor()
			: (previewCursors.get(key) ?? createV4aPreviewCursor());
	const operations = previewV4aPatchPrefix(patch, context.argsComplete, cursor);
	if (key !== undefined) previewCursors.set(key, cursor);
	return operations;
}

/** cwd-relative when inside the workspace, `~`-relative when inside the home directory. */
function shortPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const fromCwd = relative(cwd, path);
	if (fromCwd === "") return ".";
	if (!fromCwd.startsWith("..") && !isAbsolute(fromCwd))
		return fromCwd.split(sep).join("/");
	const home = homedir();
	const fromHome = relative(home, path);
	if (fromHome === "") return "~";
	if (!fromHome.startsWith("..") && !isAbsolute(fromHome))
		return `~/${fromHome.split(sep).join("/")}`;
	return path;
}

function formatDelta(
	operation: {
		readonly addedLines: number;
		readonly removedLines: number;
	},
	theme: Theme,
): string {
	const parts: string[] = [];
	if (operation.addedLines > 0)
		parts.push(theme.fg("success", `+${String(operation.addedLines)}`));
	if (operation.removedLines > 0)
		parts.push(theme.fg("error", `-${String(operation.removedLines)}`));
	return parts.length === 0 ? "" : ` (${parts.join(" ")})`;
}

function statusRow(
	operation: {
		readonly path: string;
		readonly status: ApplyPatchOperationStatus;
		readonly addedLines: number;
		readonly removedLines: number;
		readonly appliedHunks?: number;
		readonly totalHunks?: number;
		readonly partialReason?: string;
	},
	theme: Theme,
): string {
	const hunks =
		operation.status === "partial" &&
		operation.appliedHunks !== undefined &&
		operation.totalHunks !== undefined
			? theme.fg(
					"muted",
					` (${String(operation.appliedHunks)}/${String(operation.totalHunks)} hunks${
						operation.partialReason === undefined
							? ""
							: `; ${operation.partialReason}`
					})`,
				)
			: "";
	return `${theme.fg(STATUS_TONE[operation.status], STATUS_LABEL[operation.status])} ${operation.path}${formatDelta(operation, theme)}${hunks}`;
}

function callHeader(
	operations: readonly V4aPreviewOperation[],
	theme: Theme,
	cwd: string,
): string {
	const paths = new Set(operations.map((operation) => operation.path));
	const target =
		paths.size === 0
			? ""
			: paths.size === 1
				? shortPath(operations[0]?.path ?? "", cwd)
				: `${String(paths.size)} files`;
	const added = operations.reduce((sum, operation) => sum + operation.addedLines, 0);
	const removed = operations.reduce((sum, operation) => sum + operation.removedLines, 0);
	const title = theme.fg("toolTitle", theme.bold("apply_patch"));
	const head = target === "" ? title : `${title} ${theme.fg("accent", target)}`;
	return added === 0 && removed === 0
		? head
		: `${head}${theme.fg("muted", ` (+${String(added)} -${String(removed)})`)}`;
}

function pendingRow(operation: V4aPreviewOperation, theme: Theme): string {
	return `${theme.fg("dim", "pending")} ${operation.path}${formatDelta(operation, theme)}`;
}

export const applyPatchRenderers: ToolRenderers = {
	renderShell: "default",
	renderCall(args, theme, context) {
		const operations = previewOperations(patchArgument(args), context);
		const lines = [callHeader(operations, theme, context.cwd)];
		if (!context.argsComplete)
			lines.push(...operations.map((operation) => pendingRow(operation, theme)));
		const component =
			context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		component.setText(lines.join("\n"));
		return component;
	},
	renderResult(result, options, theme, context) {
		const text = stripTerminalSequences(
			result.content
				.filter((item) => item.type === "text")
				.map((item) => ("text" in item ? item.text : ""))
				.join("\n"),
		);
		const details = applyPatchResultFacts(result.details);
		const body = details === undefined ? "" : renderDetailsBody(details, options, theme, context);
		const output = body === "" ? fallbackBody(text, context.isError, theme) : body;
		const component =
			context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		if (output === "") return component;
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, 0, 0));
		return component;
	},
};

interface DiffBlock {
	readonly path: string;
	readonly diff: string;
	readonly operation: RenderOperation | undefined;
}

function diffBlocks(details: RenderDetails): readonly DiffBlock[] {
	const byPath = new Map<string, string[]>();
	for (const snapshot of details.snapshots) {
		const diff = formatSnapshotDiff(snapshot);
		if (diff === "") continue;
		const diffs = byPath.get(snapshot.path) ?? [];
		diffs.push(diff);
		byPath.set(snapshot.path, diffs);
	}
	// A pure move publishes no hunk window but still has a path to report.
	for (const operation of details.operations) {
		if (!CONFIRMED_STATUSES.has(operation.status)) continue;
		if (!byPath.has(operation.path)) byPath.set(operation.path, []);
	}
	const operations = new Map(details.operations.map((operation) => [operation.path, operation]));
	return [...byPath].map(([path, diffs]) => ({
		path,
		diff: diffs.join("\n"),
		operation: operations.get(path),
	}));
}

function operationTag(operation: RenderOperation, theme: Theme): string {
	if (operation.status === "partial") {
		const hunks =
			operation.appliedHunks !== undefined && operation.totalHunks !== undefined
				? ` (${String(operation.appliedHunks)}/${String(operation.totalHunks)} hunks${
						operation.partialReason === undefined ? "" : `; ${operation.partialReason}`
					})`
				: "";
		return theme.fg("warning", `partial${hunks}`);
	}
	if (operation.status === "fuzzy") return theme.fg("warning", "fuzzy");
	if (operation.kind === "add") return theme.fg("muted", "added");
	if (operation.kind === "delete") return theme.fg("muted", "deleted");
	return theme.fg("muted", "updated");
}

function singleStatusTag(operation: RenderOperation | undefined, theme: Theme): string | undefined {
	if (operation === undefined) return undefined;
	if (operation.status === "partial") return operationTag(operation, theme);
	if (operation.status === "fuzzy") return operationTag(operation, theme);
	return undefined;
}

function multiFileHeader(block: DiffBlock, theme: Theme, cwd: string): string {
	const target = theme.fg("accent", shortPath(block.path, cwd));
	if (block.operation === undefined) return target;
	const delta = formatDelta(block.operation, theme);
	return `${target}${delta} ${operationTag(block.operation, theme)}`;
}

interface DiffPreview {
	readonly text: string;
	readonly remaining: number;
}

function previewDiff(diff: string, maxLines: number): DiffPreview {
	const lines = diff.split("\n");
	if (lines.length <= maxLines) return { text: diff, remaining: 0 };
	return {
		text: lines.slice(0, maxLines).join("\n"),
		remaining: lines.length - maxLines,
	};
}

interface RenderViewContext {
	readonly cwd: string;
	keyHint(keybinding: "app.tools.expand", description: string): string;
}

function expandHint(remaining: number, theme: Theme, context: RenderViewContext): string {
	return `${theme.fg("muted", `... (${String(remaining)} more lines,`)} ${context.keyHint(
		"app.tools.expand",
		"to expand",
	)}${theme.fg("muted", ")")}`;
}

function liveRows(details: RenderDetails, theme: Theme): string {
	return details.operations.map((operation) => statusRow(operation, theme)).join("\n");
}

function diagnosticText(diagnostic: RejectedPatchHunk): string {
	switch (diagnostic.kind) {
		case "context_not_found":
			return diagnostic.hint === undefined
				? "context not found"
				: `context not found (${diagnostic.hint})`;
		case "ambiguous_exact": {
			const candidates = diagnostic.candidateStartLines
				.slice(0, MAX_CANDIDATE_LINES)
				.join(", ");
			if (candidates === "") return "exact context is ambiguous";
			return `exact context is ambiguous at lines ${candidates} (${String(diagnostic.candidateStartLines.length)} candidates)`;
		}
		default:
			return "context not applied";
	}
}

function failureRows(
	rejections: readonly RenderRejection[],
	status: ApplyPatchOperationStatus,
	theme: Theme,
): readonly string[] {
	const rows: string[] = [];
	const tone = STATUS_TONE[status];
	for (const rejection of rejections) {
		const path = rejection.paths[0] ?? "<unknown>";
		if (rejection.diagnostics.length === 0) {
			rows.push(
				`${theme.fg(tone, STATUS_LABEL[status])} ${theme.fg("accent", path)}${theme.fg("muted", ` · ${rejection.error}`)}`,
			);
			continue;
		}
		for (const diagnostic of rejection.diagnostics) {
			rows.push(
				`${theme.fg(tone, STATUS_LABEL[status])} ${theme.fg("accent", path)}${theme.fg("muted", ` · hunk ${String(diagnostic.hunkIndex)} · ${diagnosticText(diagnostic)}`)}`,
			);
		}
	}
	return rows;
}

function renderDetailsBody(
	details: RenderDetails,
	options: { readonly expanded: boolean; readonly isPartial: boolean },
	theme: Theme,
	context: RenderViewContext,
): string {
	if (options.isPartial) return liveRows(details, theme);

	const blocks = diffBlocks(details);
	const lines: string[] = [];
	let truncated = 0;

	if (blocks.length === 1) {
		const block = blocks[0];
		if (block !== undefined) {
			const tag = singleStatusTag(block.operation, theme);
			if (tag !== undefined)
				lines.push(`${theme.fg("accent", shortPath(block.path, context.cwd))} ${tag}`);
			const preview = previewDiff(
				block.diff,
				options.expanded ? Number.POSITIVE_INFINITY : SINGLE_FILE_PREVIEW_LINES,
			);
			const rendered = renderDiffBody(preview.text, theme);
			if (rendered !== "") lines.push(rendered);
			truncated += preview.remaining;
		}
	} else if (blocks.length > 1) {
		for (const [index, block] of blocks.entries()) {
			if (index > 0) lines.push("");
			lines.push(multiFileHeader(block, theme, context.cwd));
			const preview = previewDiff(
				block.diff,
				options.expanded ? Number.POSITIVE_INFINITY : MULTI_FILE_PREVIEW_LINES,
			);
			const rendered = renderDiffBody(preview.text, theme);
			if (rendered !== "") lines.push(rendered);
			if (preview.remaining > 0) {
				truncated += preview.remaining;
				lines.push(theme.fg("muted", `... (${String(preview.remaining)} more lines)`));
			}
		}
	}

	const failures = [
		...failureRows(details.rejected, "rejected", theme),
		...failureRows(details.unconfirmed, "unconfirmed", theme),
		...failureRows(details.notApplied, "not_applied", theme),
	];
	if (failures.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...failures);
	}

	if (!options.expanded && truncated > 0) lines.push(expandHint(truncated, theme, context));
	return lines.join("\n");
}

function fallbackBody(text: string, isError: boolean, theme: Theme): string {
	return text === "" ? "" : theme.fg(isError ? "error" : "toolOutput", text);
}
