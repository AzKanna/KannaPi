import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package SOURCES (no prior build needed).
// Production/runtime resolution goes through each package's dist/ (see package.json exports).
const packages = ["shared", "database", "traffic", "browser", "state", "security", "agent"];
const alias: Record<string, string> = Object.fromEntries(
  packages.map((p) => [`@kanna/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
  },
});
