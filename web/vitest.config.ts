import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // Live vision-accuracy eval (needs ANTHROPIC_API_KEY, costs money) runs via a
    // separate command, never in the gate.
    exclude: [...configDefaults.exclude, "**/*.eval.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
