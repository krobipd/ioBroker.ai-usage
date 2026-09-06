"use strict";
// Preloaded into the ADAPTER process (NODE_OPTIONS=--require …) by test/inventory.js.
//
// The adapter talks to seven fixed provider addresses. To let the inventory run
// cover every account type, those answers have to come from the fixtures — and
// they must not come from the internet: a gate that depends on someone else's
// service is not a gate. The hook replaces the global `fetch` the adapter uses
// (lib/http.ts calls it directly) with one that serves the fixture table and
// REFUSES everything else, so a forgotten route shows up as a failure instead of
// a live request.
//
// Nothing in the adapter knows about this. No test seam in production code.
const { routes } = require("./responses.cjs");

const table = routes();

globalThis.fetch = function fixtureFetch(input) {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const route = table.find(entry => url.includes(entry.match));
  if (!route) {
    return Promise.reject(new Error(`inventory fixture: no route for ${url}`));
  }
  const body = JSON.stringify(route.body);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  });
};
