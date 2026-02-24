import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts", "src/**/*.ts"],
  outDir: "dist",
  format: ["cjs"],
  clean: true,
  sourcemap: true,
  target: "node22",
  dts: false,
  minify: true,
  tsconfig: "./tsconfig.json",
  publicDir: "./src",
  esbuildOptions(options) {
    options.alias = { "@": "./src" }
  }
})
