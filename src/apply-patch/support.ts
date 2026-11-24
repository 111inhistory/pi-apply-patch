import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Self-contained replacements for the small `@hheei/pi-ext-core` helpers this package used. The
 * runtime imports stay on Node builtins only: the jsdiff worker loads this module for
 * `errorMessage`, and pulling the Pi barrel in would add that barrel's startup cost to every
 * update. All Pi types are type-only imports and erase before the worker starts.
 */

/** The one narrowing guard for a plain JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a display message out of an unknown caught value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Builds the single-text-part result that every tool returns to the model. */
export function textToolResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: "text", text }], details };
}

/** Streaming repaint window for paths that rebuild a whole snapshot per event. */
const STREAM_REPAINT_INTERVAL_MS = 100;

/**
 * Decides *when* a caller rebuilds its snapshot; the caller still decides *what* it rebuilds.
 * The first request renders immediately, later requests in the same window collapse into one
 * trailing render, and the last state is not dropped while the window is open.
 */
export interface RenderThrottle {
	/** Renders now when no window is open, otherwise records one trailing render. */
	request(): void;
	/** Renders a pending trailing update now; used before publishing a final state. */
	flush(): void;
	/** Idempotent: clears the timer and drops the pending render. */
	dispose(): void;
}

export function createRenderThrottle(
	render: () => void,
	intervalMs: number = STREAM_REPAINT_INTERVAL_MS,
): RenderThrottle {
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
		throw new Error("Render throttle interval must be a positive safe integer");
	let timer: NodeJS.Timeout | undefined;
	let pending = false;
	let disposed = false;
	return {
		request(): void {
			if (disposed) return;
			if (timer !== undefined) {
				pending = true;
				return;
			}
			render();
			timer = setTimeout(() => {
				timer = undefined;
				if (!pending) return;
				pending = false;
				render();
			}, intervalMs);
			timer.unref?.();
		},
		flush(): void {
			if (disposed || !pending) return;
			pending = false;
			render();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			pending = false;
			if (timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** User-wide and project-local settings files. Missing files are treated as empty. */
export interface ExtensionSettingsPaths {
	readonly globalPath: string;
	readonly projectPath: string;
}

export interface MergedJsonSettingsSection {
	readonly global: Readonly<Record<string, unknown>>;
	readonly project: Readonly<Record<string, unknown>>;
	/** Project values win, recursively, at object roots. */
	readonly merged: Readonly<Record<string, unknown>>;
}

export interface ReadMergedJsonSettingsSectionOptions {
	readonly paths: ExtensionSettingsPaths;
	readonly section: string;
	readonly signal?: AbortSignal;
}

const PI_CONFIG_DIR = ".pi";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Mirrors Pi's `PI_CODING_AGENT_DIR` override, including a leading `~`. */
function agentDirectory(): string {
	const override = process.env[AGENT_DIR_ENV];
	if (override !== undefined && override !== "") {
		if (override === "~") return homedir();
		if (override.startsWith("~/")) return join(homedir(), override.slice(2));
		return override;
	}
	return join(homedir(), PI_CONFIG_DIR, "agent");
}

/** `<agent-dir>/settings.json` and `<cwd>/.pi/settings.json`, the two Pi settings layers. */
export function defaultExtensionSettingsPaths(
	cwd: string = process.cwd(),
): ExtensionSettingsPaths {
	return {
		globalPath: join(agentDirectory(), "settings.json"),
		projectPath: join(cwd, PI_CONFIG_DIR, "settings.json"),
	};
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function readJsonSettingsRoot(
	path: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, signal === undefined ? "utf8" : { encoding: "utf8", signal });
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}`, { cause: error });
	}
	if (!isRecord(value)) throw new Error(`Expected JSON object root in ${path}`);
	return value;
}

async function readJsonSettingsSection(
	path: string,
	section: string,
	signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
	const root = await readJsonSettingsRoot(path, signal);
	const value = root[section];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Expected ${section} to be an object in ${path}`);
	return value;
}

function mergeSettingsObjects(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...global };
	for (const [key, projectValue] of Object.entries(project)) {
		const globalValue = global[key];
		merged[key] =
			isRecord(globalValue) && isRecord(projectValue)
				? mergeSettingsObjects(globalValue, projectValue)
				: projectValue;
	}
	return merged;
}

/**
 * Loads both layers and a project-wins recursive merge. Consumers that restrict project trust
 * read `global` and `project`, not `merged`, so the merge never hides which layer set a value.
 */
export async function readMergedJsonSettingsSection(
	options: ReadMergedJsonSettingsSectionOptions,
): Promise<MergedJsonSettingsSection> {
	const [global, project] = await Promise.all([
		readJsonSettingsSection(options.paths.globalPath, options.section, options.signal),
		readJsonSettingsSection(options.paths.projectPath, options.section, options.signal),
	]);
	options.signal?.throwIfAborted();
	return { global, project, merged: mergeSettingsObjects(global, project) };
}
