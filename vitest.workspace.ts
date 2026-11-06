import { defineWorkspace } from "vitest/config";

// unit: transport, errors, resources and webhook verification against local HTTP fixtures and the spec
// test vectors. contract: every bound route called through the real service bootstrap (spec-driven
// peer mocks behind a minimal gateway), so request shapes and responses are checked against the spec.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/unit/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "contract",
      include: ["test/contract/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
