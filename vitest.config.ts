import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "eval/**/*.test.ts", "scripts/**/*.test.ts"], environment: "node" },
  // Component tests render .tsx with the automatic JSX runtime (tsconfig keeps "preserve" for Next).
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
