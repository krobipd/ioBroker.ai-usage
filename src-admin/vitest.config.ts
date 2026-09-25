import { defineConfig } from "vitest/config";

// The component's own suite, as a project of its own: the needle harness sends every
// mutation under src-admin/ here only when this folder carries a package.json AND a
// vitest config — otherwise the root suite ran and every needle read as survived.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
