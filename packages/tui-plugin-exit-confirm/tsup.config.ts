import { defineConfig } from "tsup"

export default defineConfig({
  // Entry filename matters: opencode loads `./tui` from package.json `exports`,
  // which we point at `./dist/tui.js`. Build entry must produce that file.
  entry: { tui: "src/tui.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  splitting: false,
  shims: false,
  // Bundling solid-js is wrong — opencode's TUI runtime owns the solid
  // instance; the plugin must use the host's. Mark all peers external.
  external: ["@opencode-ai/plugin", "@opentui/solid", "@opentui/core", "solid-js"],
})
