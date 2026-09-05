import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Object names as translation objects, read from `admin/i18n/<lang>.json`.
 *
 * The ioBroker core team's line (mcm1957, nut2 #15) is that `common.name` and
 * `common.desc` carry the FULL translation object for every object type — the
 * adapter must not resolve them into the system language, because the object
 * outlives the language that was set when it was created. That is also why this
 * does not go through `adapter-core`'s `I18n` helper: that one needs the running
 * controller (importing it alone calls `process.exit` outside an ioBroker install),
 * while the tree builder and the poll engine are pure modules the unit tests drive
 * without any of that. All the helper would add is picking a language — exactly the
 * step that must NOT happen here.
 *
 * A missing catalogue can never take the object tree down: names then fall back to
 * their English text and, failing that, to the key.
 */

/** key → language → text. Empty until {@link loadCatalogue} ran. */
let words: Record<string, Record<string, string>> = {};

/**
 * Read every `<rootDir>/i18n/<lang>.json` into the catalogue.
 *
 * @param rootDir the directory holding the `i18n` folder (the adapter's `admin/`)
 * @returns how many keys were loaded
 */
export function loadCatalogue(rootDir: string): number {
  const dir = join(rootDir, "i18n");
  const loaded: Record<string, Record<string, string>> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const lang = file.slice(0, -".json".length);
    const texts = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    for (const [key, text] of Object.entries(texts)) {
      if (typeof text !== "string") {
        continue;
      }
      loaded[key] ??= {};
      loaded[key][lang] = text;
    }
  }
  words = loaded;
  return Object.keys(words).length;
}

/** Forget the catalogue — for tests that check the fallback path. */
export function clearCatalogue(): void {
  words = {};
}

/**
 * The translation object for one object name or description.
 *
 * @param key the i18n key
 * @param arg optional replacement for the single `%s` placeholder the text may carry
 * @returns the translation object, or the plain fallback text
 */
export function tName(key: string, arg?: string | ioBroker.StringOrTranslated): ioBroker.StringOrTranslated {
  const entry = words[key];
  if (!entry) {
    // Never seen this key: the key itself is a visible, greppable defect — far
    // better than an empty name nobody can trace back.
    return arg === undefined ? key : key.replace("%s", argIn(arg, "en"));
  }
  if (arg === undefined) {
    return { ...entry } as ioBroker.StringOrTranslated;
  }
  const filled: Record<string, string> = {};
  for (const [lang, text] of Object.entries(entry)) {
    filled[lang] = text.replace("%s", argIn(arg, lang));
  }
  return filled as ioBroker.StringOrTranslated;
}

/**
 * The substitution value in one language.
 *
 * An argument may itself be translated — the name of a limit window goes into
 * "%s used", and putting the ENGLISH window name into the German sentence would
 * leave the name half translated.
 *
 * @param arg the raw string or translation object
 * @param lang the language wanted
 * @returns the text for that language, falling back to English and then to any
 */
function argIn(arg: string | ioBroker.StringOrTranslated, lang: string): string {
  if (typeof arg === "string") {
    return arg;
  }
  const table = arg as Record<string, string>;
  return table[lang] ?? table.en ?? Object.values(table)[0] ?? "";
}
