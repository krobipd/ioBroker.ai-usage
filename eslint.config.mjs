import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // test/standards is ours and is linted; it lives outside the root
          // tsconfig include (which stays at the fleet master), so the parser
          // needs it named here.
          allowDefaultProject: ["*.mjs", "*.mts", "test/standards/*.test.ts"],
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
