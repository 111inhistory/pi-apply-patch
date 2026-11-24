import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchCompaction } from "./apply-patch/compaction.js";
import { isApplyPatchToolDetails, registerApplyPatchTool } from "./apply-patch/tool.js";

export default function piApplyPatchExtension(pi: ExtensionAPI): void {
	registerApplyPatchTool(pi);
	registerApplyPatchCompaction(pi);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "apply_patch" || !isApplyPatchToolDetails(event.details)) return;
		const details = event.details;
		if (
			details.status === "failed" ||
			(details.unconfirmed?.length ?? 0) > 0 ||
			(details.notApplied?.length ?? 0) > 0
		)
			return { isError: true };
		return;
	});
}
