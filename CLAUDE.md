# CLAUDE.md — ioBroker.ai-usage

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Konzept + Anbieter-Recherche (Abfrage-Wege, Belege, Datenpunkt-Schema): `../../Ressourcen/ai-usage/`.

## Projekt

**ioBroker AI Usage** — Verbrauchs-/Limit-/Kosten-Monitor für KI-Konten (Claude-Abo, OpenRouter,
DeepSeek, OpenAI-API, Anthropic-API, GitHub Copilot). Reiner Beobachter: liest nur, ruft keine KI
auf (Abgrenzung zu ai-toolbox/ai-assistant), schreibt nie zum Anbieter.

- **Version:** io-package.json ist die Wahrheit (nicht hier pinnen)
- **GitHub:** https://github.com/krobipd/ioBroker.ai-usage
- **npm:** https://www.npmjs.com/package/iobroker.ai-usage
- **Runtime-Deps:** `@iobroker/adapter-core` (sonst nichts — HTTP über natives fetch)

## Architektur

```
src/main.ts                    → Adapter: Engine-Verdrahtung, Credential-Auflösung (zentraler
                                 Admin-Speicher), Claude-Anmelde-Nachrichten, Token-Datei, Cleanup
src/lib/poll-engine.ts         → Orchestrierung (pur, IO injiziert): Zyklen je Konto, Fehlerklassen
                                 (auth=1×Meldung / rate-limit=Backoff / network=tolerant),
                                 Warnschwellen-Übergänge, totals
src/lib/provider.ts            → UsageProvider-Vertrag + UsageSnapshot + FetchError-Klassen
src/lib/http.ts                → getJson/postJson (natives fetch, Status→Fehlerklasse)
src/lib/providers/claude-auth.ts   → OAuth-Konstanten/PKCE/Tausch/Auffrischung (HA-Vorbild-verifiziert)
src/lib/providers/claude-sub.ts    → Abo-Abfrage: limits[]-Auswertung, Extra-Guthaben beide Schemata
src/lib/providers/openrouter|deepseek|openai|anthropic-api|copilot.ts → je Anbieter fetch+parse (pur)
src/lib/providers/report-utils.ts  → Monatsstart/heute/Hochrechnung für die Report-Anbieter
src/lib/snapshot-tree.ts       → Snapshot → Objekt-Definitionen + Werte (capability-driven)
src/lib/totals.ts              → total.* aus den Snapshots im Speicher
src/lib/pure-helpers.ts        → Konten-Tabelle parsen (API-Boundary), sanitizeId, Cleanup-Ids
src/types/adapter-config.d.ts  → native-Typen
```

Warum so: Die Anbieter-Module sind reine Funktionen hinter EINEM Vertrag — bricht die inoffizielle
Claude-Abo-Abfrage, fällt genau ein Modul aus; Objekt-Anlage und totals sind anbieter-agnostisch;
die Engine ist ohne ioBroker voll testbar (injizierte Uhr/Zeitgeber/IO).

## Design-Entscheidungen

1. **Admin-8-only** (krobi 2026-08-25): Zugänge über den zentralen Zugangsdaten-Speicher des Admin
   (`system.credentials.*`, jsonConfig-Komponente `credential`, Lese-Helfer in adapter-core) —
   keine eigenen encryptedNative-Schlüsselfelder. `globalDependencies admin >= 8.0.0` (Speicher seit Admin 7.9.0; ⚠️ die 8.4.x-Nummern der Formular-Doku sind jsonConfig-PAKET-Versionen, keine Admin-Versionen).
2. **Claude-Abo = eigener geführter Anmelde-Fluss** (der zentrale Speicher kennt nur statische
   Schlüssel): Tokens verschlüsselt im Instanz-Datenverzeichnis (native-Schreiben würde restarten).
   Fluss-Details am QUELLCODE des HA-Vorbilds trickv/hass-claude-usage verifizieren, nicht an Blogs.
3. **Harte Intervall-Untergrenze 60 s + Backoff bei Drosselung** — die Claude-Abo-Drossel sperrt
   das NUTZERKONTO ~24 h (trifft auch Claude Code). Standard 300 s. Letzte Werte bleiben stehen.
4. **Nur Gelieferte Datenpunkte anlegen** (capability-driven wie die Geräte-Adapter); gleiche Sache
   = gleicher Pfad über alle Anbieter (`limits.*`/`credits.*`/`costs.*`/`tokens.*`).
5. **total.costs summiert nur echtes Geld gleicher Währung** — Copilot-Guthaben sind Stück
   (pieces:true) und bleiben draußen.
6. **Admin-Seitenlayout adapter-individuell** (krobi): aktuell EIN Panel; die Claude-Anmeldung
   bekommt bei Bedarf einen eigenen Reiter — Seitenzahl ist kein Fleet-Standard.

## Tests

```
src/**/*.test.ts               → vitest: Anbieter-Parser gegen echte Antwort-Fixtures,
                                 Poll-Engine/Backoff/Warnlogik mit injizierten Uhren+HTTP-Fakes
test/package.js                → standard: @iobroker/testing packageFiles
test/integration.js            → standard: @iobroker/testing integration (CI)
test/standards/                → iobroker-adapter-checks (Repo-Standards)
```

**Test-Oberfläche krobi:** Claude-Abo (Max) + GitHub vorhanden; übrige Anbieter ggf. ohne
Live-Konto → Changelog „sagen, nicht behaupten".
