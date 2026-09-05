import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // src-admin is a separate bundle, but `rows.ts` is pure logic that the panel and
    // the adapter must agree on — it belongs in the same test run, not outside every
    // gate.
    include: ["src/**/*.test.ts", "src-admin/src/**/*.test.ts", "test/standards/*.test.ts"],
    watch: false,
    // Prozess-Forks statt Worker-Threads: der Boot-Test und die Adapter-Attrappen
    // fassen Modul-Zustand an, den Threads teilen würden.
    pool: "forks",
    coverage: {
      // Explicit include so files that no test imports still show up as 0 %
      // — without this the v8 provider silently omits them and the headline
      // number overstates real coverage (fleet lesson from the govee-smart
      // v2.16.1 audit; before the v0.7.2 test wave this hid main.ts at 0 %).
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
