"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY account type the adapter supports
//   (feedFixtures), then dump every ai-usage.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current name/desc/role/type/unit and that removed objects are gone.
//
// ai-usage speaks to seven fixed provider addresses, so the fixtures reach it
// through a preloaded `fetch` replacement in the ADAPTER process (env below) —
// the production code carries no test seam and no fixture mode.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];

/** The adapter process serves every provider answer from the fixture table. */
const FIXTURE_ENV = { NODE_OPTIONS: `--require ${path.join(__dirname, "fixtures", "inventory", "fetch-hook.cjs")}` };

/** The stored credentials the key accounts read, as the admin would write them. */
const CREDENTIALS = [
  { id: "system.credentials.fixture-openrouter", name: "OpenRouter" },
  { id: "system.credentials.fixture-deepseek", name: "DeepSeek" },
  { id: "system.credentials.fixture-openai", name: "OpenAI" },
  { id: "system.credentials.fixture-anthropic", name: "Anthropic" },
];

/** Adapter-specific config the fixtures need: every account type switched on. */
const FIXTURE_NATIVE = {
  pollInterval: 60,
  notifications: false,
  accounts: [
    { name: "Claude", provider: "claude-sub", credentialId: "", warnThreshold: 80 },
    { name: "ChatGPT", provider: "chatgpt-sub", credentialId: "", warnThreshold: 80 },
    { name: "Gemini", provider: "gemini-sub", credentialId: "", warnThreshold: 80 },
    { name: "OpenRouter", provider: "openrouter", credentialId: CREDENTIALS[0].id, warnThreshold: 80 },
    { name: "DeepSeek", provider: "deepseek", credentialId: CREDENTIALS[1].id, warnThreshold: 80 },
    { name: "OpenAI", provider: "openai", credentialId: CREDENTIALS[2].id, warnThreshold: 80 },
    { name: "Anthropic", provider: "anthropic-api", credentialId: CREDENTIALS[3].id, warnThreshold: 80 },
  ],
};

/**
 * The four key accounts read their key from the admin's central storage. The
 * values are plain here on purpose: `getCredentials` only decrypts fields listed
 * in `native.encryptedFields`, so this is a valid credential object without
 * needing the instance secret.
 *
 * @param {object} harness
 */
async function seedCredentials(harness) {
  for (const credential of CREDENTIALS) {
    await harness.objects.setObjectAsync(credential.id, {
      type: "config",
      common: { name: credential.name },
      native: { type: "ai", version: 1, key: `fixture-key-${credential.name.toLowerCase()}` },
    });
  }
}

/**
 * Ask the adapter something over the message box.
 *
 * @param {object} harness
 * @param {string} command the message command
 * @param {Record<string, unknown>} message the payload
 * @returns {Promise<Record<string, unknown>>} the adapter's answer
 */
function ask(harness, command, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${command}`)), 20000);
    harness.sendTo(`${ADAPTER}.0`, command, message, answer => {
      clearTimeout(timer);
      resolve(answer || {});
    });
  });
}

/**
 * Adapter-specific: make the adapter create every object it can create.
 *
 * The three subscriptions own their tokens (design decision 3), so the fixtures
 * do NOT write a token file — they run the real sign-in flows against the
 * fixture endpoints and let the adapter store what it gets. That is also the
 * only automated coverage the ChatGPT and Google flows have, which no gate
 * reached before.
 *
 * @param {object} harness
 */
async function feedFixtures(harness) {
  await harness.enableSendTo();
  // Claude and Google hand a pasted value back; ChatGPT confirms out of band and
  // the adapter's own poller picks it up.
  for (const provider of ["claude-sub", "gemini-sub"]) {
    await ask(harness, "signInStart", { provider });
    const state = await ask(harness, "signInSubmit", { provider, value: "fixture-code" });
    assert.strictEqual(state.status, "signed-in", `${provider}: ${JSON.stringify(state)}`);
  }
  await ask(harness, "signInStart", { provider: "chatgpt-sub" });
  await waitFor(
    async () => (await ask(harness, "signInStatus", { provider: "chatgpt-sub" })).status === "signed-in",
    "the ChatGPT device-code sign-in never completed",
  );
  // The first polls are staggered by three seconds per account, so the tree keeps
  // growing for a while. Waiting for "every account is delivering" is the precise
  // condition — a tree that merely stopped growing for a moment is the state that
  // made the first run write a skeleton for four of seven accounts.
  await waitFor(async () => {
    const state = await harness.states.getStateAsync(`${NS}total.accountsReachable`);
    return state?.val === FIXTURE_NATIVE.accounts.length;
  }, `not every account delivered — the fixtures did not reach all ${FIXTURE_NATIVE.accounts.length} of them`);
  await waitForStableTree(harness);
}

/**
 * Poll a condition until it holds.
 *
 * @param {() => Promise<boolean>} check the condition
 * @param {string} what what to say when it never holds
 */
async function waitFor(check, what) {
  for (let i = 0; i < 60; i++) {
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out: ${what}`);
}

/**
 * Wait until the object tree has stopped growing — the accounts start staggered
 * and each creates its objects on its first answer.
 *
 * @param {object} harness
 */
async function waitForStableTree(harness) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    const count = Object.keys(await dumpObjects(harness)).length;
    stable = count === last && count > 0 ? stable + 1 : 0;
    last = count;
    if (stable >= 3) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("the object tree never settled");
}

/**
 * Every object below the instance, in the bot's dump format.
 *
 * @param {object} harness
 * @returns {Promise<Record<string, unknown>>} id → object
 */
async function dumpObjects(harness) {
  // The range starts at "ai-usage.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        await seedCredentials(harness);
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await harness.startAdapterAndWait(false, FIXTURE_ENV);
        await feedFixtures(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("covers every account type, not only the maintainer's", async function () {
        this.timeout(30000);
        const ids = Object.keys(await dumpObjects(harness));
        for (const account of [
          "claude",
          "chatgpt",
          "gemini",
          "fixture-openrouter-api",
          "fixture-deepseek-api",
          "fixture-openai-api",
          "fixture-anthropic-api",
        ]) {
          assert.ok(ids.includes(`${NS}${account}`), `no objects for ${account}`);
        }
        // The datapoint classes a skeleton-only inventory would miss — the ones
        // whose names come from a runtime value, which is exactly the class the
        // live-tree gate had to catch after a deploy on 2026-09-05.
        for (const suffix of [
          "claude.limits.session.percent",
          "claude.limits.session.active",
          "chatgpt.credits.resetCredits",
          "fixture-openai-api.costs.month",
          "fixture-openai-api.models",
        ]) {
          assert.ok(ids.includes(`${NS}${suffix}`), `missing ${suffix}`);
        }
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await seedCredentials(harness);
          await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
          await harness.startAdapterAndWait(false, FIXTURE_ENV);
          await feedFixtures(harness);
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
