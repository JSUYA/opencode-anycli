import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/openai-compat.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  splitting: false,
  shims: false,
  treeshake: true,
})
