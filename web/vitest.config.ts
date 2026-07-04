import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // Live vision-accuracy eval (needs ANTHROPIC_API_KEY, costs money) and the
    // Playwright E2E specs run via separate commands, never in the unit gate.
    exclude: [...configDefaults.exclude, "**/*.eval.test.ts", "e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
