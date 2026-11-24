import { isRecord } from "./support.js";
import type {
	ApplyPatchHunkSnapshot,
	ApplyPatchOperationProgress,
	ApplyPatchOperationStatus,
	ApplyPatchRejection,
	RejectedPatchHunk,
} from "./outcome.js";

/**
 * Display-side reading of the persisted `apply_patch` details. The details are the contract; a
 * session written by an older build reaches this module as untrusted JSON, so every field is
 * narrowed once here and dropped when it does not match.
 */
export interface ApplyPatchResultFacts {
	readonly status: "success" | "partial" | "failed";
	readonly operations: readonly ApplyPatchOperationProgress[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
	readonly rejected: readonly ApplyPatchRejection[];
	readonly unconfirmed: readonly ApplyPatchRejection[];
	readonly notApplied: readonly ApplyPatchRejection[];
	readonly addedLines: number;
	readonly removedLines: number;
	readonly changedPaths: readonly string[];
}

const OPERATION_STATUSES: ReadonlySet<string> = new Set<ApplyPatchOperationStatus>([
	"pending",
	"applied",
	"partial",
	"fuzzy",
	"unconfirmed",
	"not_applied",
	"rejected",
]);

function isPatchStatus(value: unknown): value is ApplyPatchResultFacts["status"] {
	return value === "success" || value === "partial" || value === "failed";
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function operationView(value: unknown): ApplyPatchOperationProgress | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	const kind = value.kind;
	const status = value.status;
	if (path === undefined) return undefined;
	if (kind !== "add" && kind !== "delete" && kind !== "update") return undefined;
	if (typeof status !== "string" || !OPERATION_STATUSES.has(status)) return undefined;
	const appliedHunks = numberField(value, "appliedHunks");
	const totalHunks = numberField(value, "totalHunks");
	const partialReason = stringField(value, "partialReason");
	return {
		operationIndex: numberField(value, "operationIndex") ?? 0,
		kind,
		path,
		addedLines: numberField(value, "addedLines") ?? 0,
		removedLines: numberField(value, "removedLines") ?? 0,
		status: status as ApplyPatchOperationStatus,
		...(appliedHunks === undefined ? {} : { appliedHunks }),
		...(totalHunks === undefined ? {} : { totalHunks }),
		...(partialReason === undefined ? {} : { partialReason }),
	};
}

function snapshotView(value: unknown): ApplyPatchHunkSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	if (path === undefined) return undefined;
	const before = value.before;
	const after = value.after;
	if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
	const startLine = numberField(value, "startLine");
	return {
		path,
		hunkIndex: numberField(value, "hunkIndex") ?? 0,
		startLine: startLine !== undefined && startLine > 0 ? startLine : 1,
		afterStartLine: numberField(value, "afterStartLine") ?? startLine ?? 1,
		before: before.filter((line): line is string => typeof line === "string"),
		after: after.filter((line): line is string => typeof line === "string"),
	};
}

function diagnosticView(value: unknown): RejectedPatchHunk | undefined {
	if (!isRecord(value)) return undefined;
	const hunkIndex = numberField(value, "hunkIndex");
	if (hunkIndex === undefined) return undefined;
	switch (value.kind) {
		case "context_not_found": {
			const hint = stringField(value, "hint");
			return { kind: "context_not_found", hunkIndex, ...(hint === undefined ? {} : { hint }) };
		}
		case "ambiguous_exact":
			return {
				kind: "ambiguous_exact",
				hunkIndex,
				candidateStartLines: Array.isArray(value.candidateStartLines)
					? value.candidateStartLines.filter((line): line is number => typeof line === "number")
					: [],
			};
		default:
			return undefined;
	}
}

function rejectionView(value: unknown): ApplyPatchRejection | undefined {
	if (!isRecord(value)) return undefined;
	const error = stringField(value, "error");
	if (error === undefined) return undefined;
	const operationIndices = Array.isArray(value.operationIndices)
		? value.operationIndices.filter((index): index is number => typeof index === "number")
		: [];
	return {
		operationIndices,
		paths: stringList(value.paths),
		error,
		diagnostics: Array.isArray(value.diagnostics)
			? value.diagnostics
					.map(diagnosticView)
					.filter((diagnostic): diagnostic is RejectedPatchHunk => diagnostic !== undefined)
			: [],
	};
}

function rejectionList(value: unknown): readonly ApplyPatchRejection[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(rejectionView)
		.filter((rejection): rejection is ApplyPatchRejection => rejection !== undefined);
}

/** Applied-operation snapshots, in the executor's operation order. */
function snapshotList(value: unknown): readonly ApplyPatchHunkSnapshot[] {
	if (!Array.isArray(value)) return [];
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	for (const operation of value) {
		if (!isRecord(operation) || !Array.isArray(operation.snapshots)) continue;
		for (const snapshot of operation.snapshots) {
			const view = snapshotView(snapshot);
			if (view !== undefined) snapshots.push(view);
		}
	}
	return snapshots;
}

/** Reads only the persisted `apply_patch` details; other shapes return undefined. */
export function applyPatchResultFacts(details: unknown): ApplyPatchResultFacts | undefined {
	if (!isRecord(details) || !isPatchStatus(details.status)) return undefined;
	return {
		status: details.status,
		operations: Array.isArray(details.operations)
			? details.operations
					.map(operationView)
					.filter((operation): operation is ApplyPatchOperationProgress => operation !== undefined)
			: [],
		snapshots: snapshotList(details.applied),
		rejected: rejectionList(details.rejected),
		unconfirmed: rejectionList(details.unconfirmed),
		notApplied: rejectionList(details.notApplied),
		addedLines: numberField(details, "addedLines") ?? 0,
		removedLines: numberField(details, "removedLines") ?? 0,
		changedPaths: stringList(details.changedPaths),
	};
}
