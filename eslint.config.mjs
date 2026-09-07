import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Only files NO tsconfig covers may stand here — a file that is also in
          // the project service makes the parser refuse the whole run. Since the
          // root tsconfig includes `test/**/*.ts` (fleet master, 2026-09-07), the
          // repo-standards suite is covered there and must NOT be listed.
          allowDefaultProject: [
            "*.mjs",
            "*.mts",
            // The inventory fixtures: plain CommonJS the adapter process preloads,
            // outside every tsconfig include but ours to keep clean.
            "test/fixtures/inventory/*.cjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      // Only the two ioBroker template files under test/ stay out — the repo-standards
      // suite next to them is ours and is linted like every other test (fleet rule
      // since 2026-09-02).
      "test/*.js",
      "*.config.mjs",
      "*.config.mts",
      "tasks.js",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      "src-admin",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
