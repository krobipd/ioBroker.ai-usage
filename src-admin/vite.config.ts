import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/gui-components/modulefederation.admin.config";
import { readFileSync } from "node:fs";

const config = {
  plugins: [
    federation({
      // The panel imports the adapter's own rules from ../src/lib; the plugin's type
      // step would compile them under rootDir src-admin/src and fail (TS6059). The
      // admin loads the remote at runtime — nothing consumes its types (fleet form).
      dts: false,
      manifest: true,
      name: "AiUsageComponentSet",
      filename: "customComponents.js",
      exposes: {
        "./Components": "./src/Components.tsx",
      },
      remotes: {},
      shared: moduleFederationShared(JSON.parse(readFileSync("./package.json").toString())),
    }),
    react(),
    commonjs(),
  ],
  // Vite 8 resolves tsconfig paths natively — replaces the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  base: "./",
  build: {
    target: "chrome89",
    outDir: "./build",
  },
};

export default config;
