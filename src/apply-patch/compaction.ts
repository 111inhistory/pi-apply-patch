import type {
	ExtensionAPI,
	FileOperations,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { CONFIRMED_STATUSES, type ApplyPatchOperationStatus } from "./outcome.js";
import { isRecord } from "./support.js";

/**
 * Pi's compaction discards the summarized entries, so `apply_patch` has to report its file
 * operations before the cut is persisted. Confirmed details are authoritative; the patch header
 * fallback only fills calls whose result never recorded them, and it never promotes a call that
 * produced no confirmed change.
 */

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type CompactionMessage = CompactionPreparation["messagesToSummarize"][number];

const ADD_HEADER = "*** Add File:";
const UPDATE_HEADER = "*** Update File:";
const MOVE_HEADER = "*** Move to:";
const DELETE_HEADER = "*** Delete File:";

export interface PatchHeaderFileOps {
	readonly written: readonly string[];
	readonly edited: readonly string[];
}

function headerPath(line: string, header: string): string | undefined {
	if (!line.startsWith(header)) return undefined;
	const path = line.slice(header.length).trim();
	return path === "" ? undefined : path;
}

function addPath(target: Set<string>, path: string | undefined): void {
	if (path !== undefined) target.add(path);
}

/**
 * Best-effort file operations for a patch that was not applied yet. A malformed patch yields at
 * most the headers recognized before the defect, and no input makes the scanner throw.
 */
export function extractPatchHeaderFileOps(patch: string): PatchHeaderFileOps {
	const written = new Set<string>();
	const edited = new Set<string>();
	for (const line of patch.split(/\r\n|\n|\r/)) {
		addPath(written, headerPath(line, ADD_HEADER));
		addPath(edited, headerPath(line, UPDATE_HEADER));
		addPath(edited, headerPath(line, MOVE_HEADER));
		addPath(edited, headerPath(line, DELETE_HEADER));
	}
	return { written: [...written], edited: [...edited] };
}

function isApplyPatchStatus(value: unknown): boolean {
	return value === "success" || value === "partial" || value === "failed";
}

function applyPatchDetails(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) && isApplyPatchStatus(value.status) ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		: [];
}

function recordOperation(
	fileOps: FileOperations,
	kind: unknown,
	path: string | undefined,
): void {
	if (path === undefined) return;
	if (kind === "add") fileOps.written.add(path);
	else if (kind === "update" || kind === "delete") fileOps.edited.add(path);
}

/** Details written by a build that already records applied operations. */
function recordApplied(details: Record<string, unknown>, fileOps: FileOperations): void {
	for (const entry of Array.isArray(details.applied) ? details.applied : []) {
		if (!isRecord(entry)) continue;
		for (const path of stringList(entry.paths)) recordOperation(fileOps, entry.kind, path);
	}
}

/**
 * Details that only carry live progress. Confirmed rows keep their own add/update/delete kind;
 * `changedPaths` covers confirmations whose row kind is missing, and is never a promise that an
 * unconfirmed path was written.
 */
function recordConfirmedProgress(
	details: Record<string, unknown>,
	fileOps: FileOperations,
): void {
	const recorded = new Set<string>();
	for (const entry of Array.isArray(details.operations) ? details.operations : []) {
		if (!isRecord(entry)) continue;
		const status = entry.status;
		if (typeof status !== "string" || !CONFIRMED_STATUSES.has(status as ApplyPatchOperationStatus))
			continue;
		const path = typeof entry.path === "string" && entry.path !== "" ? entry.path : undefined;
		recordOperation(fileOps, entry.kind, path);
		if (path !== undefined) recorded.add(path);
	}
	for (const path of stringList(details.changedPaths)) {
		if (!recorded.has(path)) fileOps.edited.add(path);
	}
}

function recordDetails(details: Record<string, unknown>, fileOps: FileOperations): void {
	const applied = details.applied;
	if (Array.isArray(applied) && applied.length > 0) recordApplied(details, fileOps);
	else recordConfirmedProgress(details, fileOps);
}

function patchArgument(value: unknown): string | undefined {
	return isRecord(value) && typeof value.patch === "string" ? value.patch : undefined;
}

function recordHeaderFileOps(patch: string, fileOps: FileOperations): void {
	const { written, edited } = extractPatchHeaderFileOps(patch);
	for (const path of written) fileOps.written.add(path);
	for (const path of edited) fileOps.edited.add(path);
}

/**
 * Adds this extension's file operations to Pi's compaction preparation. Call args are read only
 * for calls whose own result did not record a structured outcome, so a failed patch that wrote
 * nothing does not claim the files it tried to touch.
 */
export function collectApplyPatchFileOps(
	preparation: Pick<
		CompactionPreparation,
		"messagesToSummarize" | "turnPrefixMessages" | "fileOps"
	>,
): void {
	const { fileOps } = preparation;
	const messages: readonly CompactionMessage[] = [
		...preparation.messagesToSummarize,
		...preparation.turnPrefixMessages,
	];
	const handledCallIds = new Set<string>();

	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "apply_patch") continue;
		const details = applyPatchDetails(message.details);
		if (details === undefined) continue;
		handledCallIds.add(message.toolCallId);
		recordDetails(details, fileOps);
	}

	for (const message of messages) {
		if (message.role === "toolResult") {
			// Calls made from codemode scripts are recorded on the script's result.
			for (const call of message.nestedCalls?.calls ?? []) {
				if (call.name !== "apply_patch") continue;
				const patch = patchArgument(call.arguments);
				if (patch !== undefined) recordHeaderFileOps(patch, fileOps);
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "apply_patch") continue;
			if (handledCallIds.has(block.id)) continue;
			const patch = patchArgument(block.arguments);
			if (patch !== undefined) recordHeaderFileOps(patch, fileOps);
		}
	}
}

/** Registers the pre-compaction file operation collector for `apply_patch`. */
export function registerApplyPatchCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => {
		collectApplyPatchFileOps(event.preparation);
	});
}
