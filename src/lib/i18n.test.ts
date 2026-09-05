import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clearCatalogue, loadCatalogue, tName } from "./i18n";

const ADMIN_DIR = join(__dirname, "..", "..", "admin");
const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

describe("the object-name catalogue", () => {
  beforeEach(() => {
    loadCatalogue(ADMIN_DIR);
  });

  test("a name comes back as the FULL translation object, never resolved", () => {
    // The core-team rule: the object outlives the language that was set when it was
    // created, so `common.name` carries every language.
    const name = tName("nameCreditsUsed") as Record<string, string>;
    expect(name.en).toBe("Credits used");
    expect(name.de).toBe("Guthaben verbraucht");
    expect(Object.keys(name).sort()).toEqual([...LANGS].sort());
  });

  test("a placeholder is filled in EVERY language, not just English", () => {
    const name = tName("nameWindowPercent", "Session (5 h)") as Record<string, string>;
    for (const lang of LANGS) {
      expect(name[lang]).toContain("Session (5 h)");
      expect(name[lang]).not.toContain("%s");
    }
  });

  test("an unknown key degrades to the key itself, never to an empty name", () => {
    clearCatalogue();
    expect(tName("nameCreditsUsed")).toBe("nameCreditsUsed");
    // Even the placeholder form stays usable.
    expect(tName("nameModelTokens", "claude-3")).toBe("nameModelTokens");
  });

  test("the caller cannot mutate the catalogue through a returned object", () => {
    const first = tName("nameCredits") as Record<string, string>;
    first.en = "tampered";
    expect((tName("nameCredits") as Record<string, string>).en).toBe("Credits");
  });
});

describe("catalogue completeness", () => {
  const en = JSON.parse(readFileSync(join(ADMIN_DIR, "i18n", "en.json"), "utf8")) as Record<string, string>;

  beforeEach(() => {
    // Independent of what a previous block left behind — one test clears it.
    loadCatalogue(ADMIN_DIR);
  });

  test("all eleven languages carry exactly the same keys", () => {
    const files = readdirSync(join(ADMIN_DIR, "i18n")).filter(file => file.endsWith(".json"));
    expect(files.map(file => file.replace(".json", "")).sort()).toEqual([...LANGS].sort());
    for (const file of files) {
      const words = JSON.parse(readFileSync(join(ADMIN_DIR, "i18n", file), "utf8")) as Record<string, string>;
      expect({ file, keys: Object.keys(words).sort() }).toEqual({ file, keys: Object.keys(en).sort() });
      expect(Object.values(words).every(text => text.trim().length > 0)).toBe(true);
    }
  });

  test("a placeholder in English means a placeholder in every language", () => {
    // A translation that lost its %s would silently drop the model or window name.
    for (const file of readdirSync(join(ADMIN_DIR, "i18n")).filter(name => name.endsWith(".json"))) {
      const words = JSON.parse(readFileSync(join(ADMIN_DIR, "i18n", file), "utf8")) as Record<string, string>;
      for (const [key, text] of Object.entries(en)) {
        expect({ file, key, placeholders: words[key].split("%s").length - 1 }).toEqual({
          file,
          key,
          placeholders: text.split("%s").length - 1,
        });
      }
    }
  });

  test("every i18n key the source asks for actually exists", () => {
    // The catalogue and the call sites are two places that must agree; a typo in a
    // key would otherwise surface as an object literally named "nameCostsTodya".
    const sources = ["poll-engine.ts", "snapshot-tree.ts"].map(file => readFileSync(join(__dirname, file), "utf8"));
    sources.push(readFileSync(join(__dirname, "..", "main.ts"), "utf8"));
    const used = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/tName\("([^"]+)"/g)) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter(key => !(key in en))).toEqual([]);
  });

  test("io-package instanceObjects carry the same texts as the catalogue", () => {
    // The manifest is rendered from admin/i18n by sync-iopackage-from-i18n.py — if
    // the two drift, a fresh installation gets different names than an updated one.
    const manifest = JSON.parse(readFileSync(join(ADMIN_DIR, "..", "io-package.json"), "utf8")) as {
      instanceObjects: { _id: string; common: { name: unknown; desc?: unknown } }[];
    };
    const expected: Record<string, string> = {
      info: "nameInfoChannel",
      "info.connection": "nameConnection",
      total: "nameTotalFolder",
    };
    for (const object of manifest.instanceObjects) {
      const key = expected[object._id];
      expect({ id: object._id, hasKey: !!key }).toEqual({ id: object._id, hasKey: true });
      expect(object.common.name).toEqual(tName(key));
    }
  });
});
