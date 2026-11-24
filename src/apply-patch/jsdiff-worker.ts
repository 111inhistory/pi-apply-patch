// Keep worker imports lean: `support.ts` avoids the Pi barrel, which adds ~470ms of startup per update.
import { parentPort, workerData } from "node:worker_threads";
import type { JsDiffUpdateInput } from "./jsdiff-matching.js";

// Node runs source workers directly in tests, without Vite's .js -> .ts resolution.
const supportUrl = new URL(
	import.meta.url.endsWith(".ts") ? "./support.ts" : "./support.js",
	import.meta.url,
);
const { errorMessage }: typeof import("./support.js") = await import(supportUrl.href);

try {
	const matchingUrl = new URL(
		import.meta.url.endsWith(".ts") ? "./jsdiff-matching.ts" : "./jsdiff-matching.js",
		import.meta.url,
	);
	const { prepareJsDiffUpdate }: typeof import("./jsdiff-matching.js") = await import(
		matchingUrl.href
	);
	parentPort?.postMessage({
		kind: "result",
		value: prepareJsDiffUpdate(workerData as JsDiffUpdateInput),
	});
} catch (error) {
	parentPort?.postMessage({ kind: "error", message: errorMessage(error) });
} finally {
	parentPort?.close();
}
