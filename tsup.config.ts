import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
