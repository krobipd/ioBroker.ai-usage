# CLAUDE.md — ioBroker.ai-usage

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Konzept + Anbieter-Recherche (Abfrage-Wege, Belege, Datenpunkt-Schema): `../../Ressourcen/ai-usage/`.

## Projekt

**ioBroker AI Usage** — Verbrauchs-/Limit-/Kosten-Monitor für KI-Konten (Claude-Abo, OpenRouter,
DeepSeek, OpenAI-API, Anthropic-API — krobi 2026-08-25: NUR was der ioBroker-Admin nativ kann;
Copilot wieder ausgebaut, weil er ein von Hand erzeugtes GitHub-Token bräuchte). Reiner Beobachter: liest nur, ruft keine KI
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
src/lib/providers/openrouter|deepseek|openai|anthropic-api.ts → je Anbieter fetch+parse (pur)
src/lib/providers/report-utils.ts  → Monatsstart/heute/Hochrechnung für die Report-Anbieter
src/lib/snapshot-tree.ts       → Snapshot → Objekt-Definitionen + Werte (capability-driven)
src/lib/totals.ts              → total.* aus den Snapshots im Speicher
src/lib/pure-helpers.ts        → Konten-Tabelle parsen (API-Boundary), sanitizeId, Cleanup-Ids
src/types/adapter-config.d.ts  → native-Typen
src-admin/                     → React-Konfig-Panel (Module-Federation, Admin-8-only, guiApi 2):
                                 Claude-Karte + Zugangs-Liste; Build → admin/custom (git-getrackt,
                                 sonst GitHub-Install leer) via `npm run build:admin` (tasks.js)
```

Warum so: Die Anbieter-Module sind reine Funktionen hinter EINEM Vertrag — bricht die inoffizielle
Claude-Abo-Abfrage, fällt genau ein Modul aus; Objekt-Anlage und totals sind anbieter-agnostisch;
die Engine ist ohne ioBroker voll testbar (injizierte Uhr/Zeitgeber/IO).

## Design-Entscheidungen

1. **Admin-8-only** (krobi 2026-08-25): Zugänge über den zentralen Zugangsdaten-Speicher des Admin
   (`system.credentials.*`, jsonConfig-Komponente `credential`, Lese-Helfer in adapter-core) —
   keine eigenen encryptedNative-Schlüsselfelder. `globalDependencies admin >= 8.0.1` (Speicher seit Admin 7.9.0; ⚠️ die 8.4.x-Nummern der Formular-Doku sind jsonConfig-PAKET-Versionen, keine Admin-Versionen).
2. **Claude-Abo = eigener geführter Anmelde-Fluss** (der zentrale Speicher kennt nur statische
   Schlüssel): Tokens verschlüsselt im Instanz-Datenverzeichnis (native-Schreiben würde restarten).
   Fluss-Details am QUELLCODE des HA-Vorbilds trickv/hass-claude-usage verifizieren, nicht an Blogs.
3. **Harte Intervall-Untergrenze 60 s + Backoff bei Drosselung** — die Claude-Abo-Drossel sperrt
   das NUTZERKONTO ~24 h (trifft auch Claude Code). Standard 300 s. Letzte Werte bleiben stehen.
4. **Nur Gelieferte Datenpunkte anlegen** (capability-driven wie die Geräte-Adapter); gleiche Sache
   = gleicher Pfad über alle Anbieter (`limits.*`/`credits.*`/`costs.*`/`tokens.*`).
5. **total.costs summiert nur echtes Geld gleicher Währung** — Stück-Guthaben (pieces:true)
   und Fremdwährungen bleiben draußen.
6. **Konfiguration = React-Komponente statt jsonConfig-Tabelle** (krobi 2026-08-25: „die Tabelle
   ist ultra kompliziert … schau dir mal homeconnect an"): `src-admin/` (Module-Federation,
   GUI-API-Gen-2, Blaupause homeconnect) rendert die gesamte Konten-Wahl — Claude-Abo-Karte mit
   geführter Anmeldung + die zentral gespeicherten KI-Zugänge als An/Aus-Liste (Anbieter wird aus
   Vorlagen-Name/Anzeige-Name geraten, sonst einmalige Auswahl; Gemini = ausgegraut, kein
   Abfrageweg). Die Komponente besitzt NUR das native-Feld `accounts` — Backend-Modell unverändert.
7. **Der Adapter besitzt den Claude-Anmelde-Fluss** (homeconnect-Muster): er erzeugt das
   PKCE-Geheimnis EINMAL, veröffentlicht den Link als Datenpunkt `auth.<Konto>.signInUrl`
   (+ `signedIn`), die Karte zeigt ihn nur live an; Code-Einlösung per Nachricht gegen das stabile
   Geheimnis. Der alte jsonConfig-Weg (textSendTo, das sich bei jeder Feld-Änderung neu erzeugte
   und den Link entwertete) ist damit strukturell weg — genau daran scheiterte krobis erster
   Anmelde-Versuch (v0.1.0).

## Tests

```
src/**/*.test.ts               → vitest: Anbieter-Parser gegen echte Antwort-Fixtures,
                                 Poll-Engine/Backoff/Warnlogik mit injizierten Uhren+HTTP-Fakes
test/package.js                → standard: @iobroker/testing packageFiles
test/integration.js            → standard: @iobroker/testing integration (CI)
test/standards/                → iobroker-adapter-checks (Repo-Standards)
```

**Test-Oberfläche krobi:** Claude-Abo (Max) vorhanden; übrige Anbieter ggf. ohne Live-Konto →
Changelog „sagen, nicht behaupten".
