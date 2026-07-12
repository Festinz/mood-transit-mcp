import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 8_000,
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
