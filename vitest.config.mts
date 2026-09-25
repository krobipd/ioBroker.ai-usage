import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // src-admin is a separate bundle, but `rows.ts` is pure logic that the panel and
    // the adapter must agree on — it belongs in the same test run, not outside every
    // gate.
    include: ["src/**/*.test.ts", "src-admin/src/**/*.test.ts", "test/standards/*.test.ts"],
    watch: false,
    // Process forks instead of worker threads: the boot test and the adapter stand-ins
    // touch module state that threads would share.
    pool: "forks",
    coverage: {
      // Explicit include so files that no test imports still show up as 0 %
      // — without this the v8 provider silently omits them and the headline
      // number overstates real coverage (fleet lesson from the govee-smart
      // v2.16.1 audit; before the v0.7.2 test wave this hid main.ts at 0 %).
      // vitest 5 reads `include` STRICTLY: what is not listed here is not measured —
      // not even when a test imports it. Under vitest 4 `src-admin/src` slipped in
      // silently; without the second pattern it drops out and the percentage RISES,
      // because less is measured.
      // `.tsx` too: the panel's own logic lives in ConfigPanel.tsx as well, and the
      // `.ts`-only pattern left it out of the number entirely. The three bundle
      // entry files carry no logic of their own.
      include: ["src/**/*.ts", "src-admin/src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src-admin/src/**/*.test.ts",
        "src-admin/src/index.tsx",
        "src-admin/src/App.tsx",
        "src-admin/src/Components.tsx",
      ],
    },
  },
});
