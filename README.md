# pi-apply-patch

Standalone `apply_patch` extension for [Pi](https://github.com/earendil-works/pi-mono), providing a Codex V4A patch editing tool with worker-thread jsdiff matching, per-path publishing, compaction `fileOps` tracking, and native Pi `edit`-style diff rendering.

## Provenance & License

Derived from `packages/pi-apply-patch` in [hheei/pi-mono](https://github.com/hheei/pi-mono) (v0.4.1, commit `a51a8a4f`), licensed under the MIT License (Copyright (c) 2026 hheei). See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Key changes in this standalone fork:

- **Self-contained package**: Removed the workspace dependency on `@hheei/pi-ext-core`; depends only on `diff` plus Pi peer dependencies.
- **Compaction `fileOps` tracking**: Hooks `session_before_compact` so files created or edited by `apply_patch` (both direct tool calls and Codemode `nestedCalls`, including split-turn prefixes) are recorded in Pi's `<modified-files>` summary and persisted compaction details.
- **Native Pi `edit`-style rendering**: Replaces the external presentation wrapper with Pi's native `renderDiff` and default tool shell (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`), supporting streaming previews, single-file and multi-file diffs, and structured rejection diagnostics.

## Install

```sh
pi install git:github.com/111inhistory/pi-apply-patch
```

The tool registers with `defaultActive: false` and can be enabled via your Pi loadout, preset, or Capability discovery.

## Configuration

Optional context fuzz factor can be configured in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and narrowed in `<workspace>/.pi/settings.json`:

```json
{
  "applyPatch": {
    "fuzzFactor": 0
  }
}
```

`fuzzFactor` accepts integers `0` to `2` (default `0` for strict context matching). Project settings may not exceed the global value.

## Development

```sh
npm install
npm run check
```
