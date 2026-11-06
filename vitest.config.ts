import { defineConfig } from "vitest/config";

// Coverage gate (foundations §16): ≥ 90% branches on the SDK source (transport, errors, resources, webhooks).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90, lines: 90 },
    },
  },
});
