# CLAUDE.md — ioBroker.ai-usage

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Konzept + Anbieter-Recherche (Abfrage-Wege, Belege, Datenpunkt-Schema): `../../Ressourcen/ai-usage/`.

## Projekt

**ioBroker AI Usage** — Verbrauchs-/Limit-/Kosten-Monitor für KI-Konten. DREI Abos mit eigener
Anmeldung (Claude, ChatGPT, Google/Gemini) + vier Schlüssel-Konten aus dem zentralen Admin-Speicher
(OpenRouter, DeepSeek, OpenAI-Organisation, Anthropic-Organisation). Reiner Beobachter: liest nur, ruft keine KI
auf (Abgrenzung zu ai-toolbox/ai-assistant), schreibt nie zum Anbieter.

- **Version:** io-package.json ist die Wahrheit (nicht hier pinnen)
- **GitHub:** https://github.com/krobipd/ioBroker.ai-usage
- **npm:** https://www.npmjs.com/package/iobroker.ai-usage
- **Runtime-Deps:** `@iobroker/adapter-core` (sonst nichts — HTTP über natives fetch)

## Architektur

```
src/main.ts                    → Adapter: Engine-Verdrahtung, Credential-Auflösung (zentraler
                                 Admin-Speicher), Anmelde-Nachrichten aller drei Abos
                                 (signInStart/Submit/Status/signOut), je Anbieter eine
                                 verschlüsselte Token-Datei + Migration der alten, Cleanup
src/lib/poll-engine.ts         → Orchestrierung (pur, IO injiziert): Zyklen je Konto, Fehlerklassen
                                 (auth=1×Meldung / rate-limit=Backoff / service=sofort offline /
                                 network=3 Versuche), Dienst-Status je Konto,
                                 Warnschwellen-Übergänge, totals
src/lib/provider.ts            → UsageProvider-Vertrag + UsageSnapshot + FetchError-Klassen
src/lib/http.ts                → getJson/postJson/postForm (natives fetch, Status→eine von VIER
                                 Fehlerklassen: auth · rate-limit · service · network)
src/lib/providers/claude-auth.ts   → OAuth-Konstanten/PKCE/Tausch/Auffrischung (HA-Vorbild-verifiziert)
src/lib/providers/claude-sub.ts    → Abo-Abfrage: limits[]-Auswertung, Extra-Guthaben beide Schemata
src/lib/providers/chatgpt-auth.ts   → Geräte-Code-Anmeldung (Start/Poll/Einlösen/Erneuern)
src/lib/providers/chatgpt-sub.ts   → /wham/usage: 5-h- + Wochen-Fenster, Guthaben
src/lib/providers/gemini-auth.ts   → Google-Anmeldung (PKCE, Adresszeile auswerten, Erneuern)
src/lib/providers/gemini-sub.ts    → loadCodeAssist (Projekt) + retrieveUserQuota (Kontingente)
src/lib/providers/openrouter|deepseek|openai|anthropic-api.ts → je Anbieter fetch+parse (pur)
src/lib/sign-in.ts             → welcher Anmelde-Fluss je Anbieter + Zeilen-Zustände
src/lib/jwt.ts                 → Ablaufzeit + ChatGPT-Konto-Kennung aus dem Token lesen
src/lib/providers/report-utils.ts  → Monatsstart/heute/Hochrechnung für die Report-Anbieter
src/lib/snapshot-tree.ts       → Snapshot → Objekt-Definitionen + Werte (capability-driven)
src/lib/totals.ts              → total.* aus den Snapshots im Speicher
src/lib/pure-helpers.ts        → Konten-Tabelle parsen (API-Boundary), sanitizeId, Cleanup-Ids
src/types/adapter-config.d.ts  → native-Typen
src-admin/                     → React-Konfig-Panel (Module-Federation, Admin-8-only, guiApi 2):
                                 EINE Liste — 3 Abo-Zeilen + je eine Zeile pro gespeichertem
                                 Schlüssel, Anmelde-Bereich klappt pro Zeile auf und rendert den
                                 Fluss des jeweiligen Anbieters; `src/rows.ts` = pure Zeilen-Logik
                                 (testbar ohne React). Build → admin/custom (git-getrackt,
                                 sonst GitHub-Install leer) via `npm run build:admin` (tasks.js)
```

Warum so: Die Anbieter-Module sind reine Funktionen hinter EINEM Vertrag — bricht die inoffizielle
Claude-Abo-Abfrage, fällt genau ein Modul aus; Objekt-Anlage und totals sind anbieter-agnostisch;
die Engine ist ohne ioBroker voll testbar (injizierte Uhr/Zeitgeber/IO).

## Design-Entscheidungen

1. **Admin-8-only** (krobi 2026-08-25): Schlüssel-Konten über den zentralen Zugangsdaten-Speicher
   (`system.credentials.*`, Lese-Helfer in adapter-core) — keine eigenen Schlüsselfelder.
   `globalDependencies admin >= 8.0.1`.
2. **DREI Zugangs-Wege, weil die Anbieter drei verschiedene erzwingen** (Recherche 2026-08-26,
   Belege in `Ressourcen/ai-usage/`): Claude = Code einfügen · ChatGPT = Geräte-Code eintippen,
   Adapter pollt selbst · Gemini = Adresszeile der Fehlerseite einfügen (GEMESSEN: Googles
   Geräte-Fluss ist für beide Zugänge gesperrt, die Anzeige-Seite abgelehnt, nur die
   localhost-Rückleitung wird angenommen). Der Fluss je Anbieter steht in `lib/sign-in.ts`,
   die Karte rendert genau die passende Anleitung.
3. **Zugangs-Daten der Abos gehören dem Adapter allein** — eigene Anmeldung, eigene Datei
   `tokens-<anbieter>.json` im Instanz-Datenverzeichnis. NIEMALS die Datei des Nutzer-Programms
   (`~/.codex/auth.json`, `oauth_creds.json`) lesen oder schreiben: die Auffrisch-Token rotieren
   und sind einmalig — zwei Erneuerer melden sich gegenseitig ab.
4. **Konto-Kennungen sind fest und deterministisch** (`accountId`): Abos `claude`/`chatgpt`/
   `gemini`, Schlüssel-Konten `<speichername>-api`. Nie aus dem Anzeigenamen abgeleitet, sonst
   wandert ein ganzer Objektbaum, wenn der Nutzer umbenennt oder später einen Speicher-Eintrag
   anlegt. Anmelde-Status liegt IM Konto (`<konto>.info.signedIn`) — der frühere zweite Zweig
   `auth.<name>` zeigte jedes Abo doppelt (krobi-Fund 2026-08-26).
5. **Harte Intervall-Untergrenze 60 s + Backoff** — die Claude-Drossel sperrt das NUTZERKONTO
   ~24 h; für ChatGPT ist keine Kontosperre belegt, aber der Endpunkt ist IP-gedrosselt; für
   Google gibt es keinen belegten sicheren Takt (einziger Anker: deren eigenes Programm cacht 30 s).
6. **Nur Geliefertes anlegen** (capability-driven); gleiche Sache = gleicher Pfad über alle
   Anbieter. Ein Kontingent ohne brauchbaren Wert wird NICHT als 0 % erfunden.
7. **Gemini: Kennung ist Pflichtteil der Abfrage** — mit der falschen Kennung (User-Agent +
   `ideType`) antwortet Google trotzdem, liefert aber den stillgelegten Gratis-Satz mit dauerhaft
   100 %. Ein Zähler, der nie fällt, ist schlimmer als ein Fehler → beide Aufrufe tragen dieselbe
   Kennung, Wirt-Kette `daily-` vor `prod`.
8. **total.costs summiert nur echtes Geld gleicher Währung** — Stück-Guthaben und Fremdwährungen
   bleiben draußen.
9. **Nach erfolgreicher Anmeldung sofort abfragen** (`engine.pollNow`) — sonst wirkt ein
   erfolgreicher Login bis zu 5 Minuten lang wie ein Fehlschlag (krobi-Fund 2026-08-26).
10. **Nur PLAN-WEITE Fenster sprechen fürs Konto** (`LimitWindow.scoped`, krobi-Fund 2026-08-26:
    „das betrifft nur Fable, nicht allgemein"): Modell-Kontingente bekommen eigene Datenpunkte,
    lösen aber nie `warning`/`limitReached` aus — ein Modell, das der Nutzer nie anfasst, kann
    dauerhaft auf 100 % stehen, und ein Alarm, der nie ausgeht, ist schlimmer als keiner
    (dieselbe Regel wie bei der Gemini-Kennung). Wer scoped setzt, entscheidet der Anbieter-Parser:
    Claude alles außer `session`/`weekly_all`, ChatGPT die `additional_rate_limits`, Google GAR
    NICHTS — dort sind die Modell-Eimer das ganze Kontingent. Jede Warnmeldung nennt das Fenster.
11. **Vier Fehlerklassen, damit „offline" etwas bedeutet**: `auth` und `rate-limit` heißen, der
    Dienst hat GEANTWORTET (er ist online, er sagt nur nein), `service` = er meldet eigenen Defekt
    (sofort offline, er hat es uns ja gesagt), `network` = nie erreicht (erst nach 3 Versuchen,
    sonst flattert die Anzeige).
12. **Das Verbindungs-Symbol im Objektbaum kommt AUSSCHLIESSLICH aus `common.statusStates`**
    am Geräte-Objekt (`{ offlineId: "info.unreach" }`, relative Id wird zu `<gerät>.<id>`
    ergänzt) — verifiziert in `adapter-react-v5/src/Components/ObjectBrowser/renderLeaf.tsx`.
    Weder eine Rolle noch der Typ-Erkenner erzeugen es. govee, beszel, homewizard und nut2
    setzen es alle; ai-usage war der einzige ohne, deshalb blieb der Konto-Knoten symbollos
    (krobi-Fund 2026-08-26, drei Anläufe — ich habe am Typ-Erkenner statt an den eigenen
    Adaptern gemessen). `info.unreach` bedeutet deshalb „liefert NICHT": eine Drosselung hält
    die Werte gültig und bleibt grün, abgelehnte Anmeldung/Dienst-Defekt/keine Verbindung nicht.
    Ein Test pinnt die Verknüpfung (nut2-Vorbild).
13. **ZWEI Status-Datenpunkte je Konto, an ioBrokers eigenen Plätzen** (krobi 2026-08-26, nachdem
    ich sechs angelegt hatte, von denen zwei etwas sagten): `info.unreach` (Ja/Nein) ist das
    Offline-Kennzeichen, das der Typ-Erkenner kennt — `indicator.reachable` ist dort ausdrücklich
    VERALTET, deshalb sah man von den alten Datenpunkten nirgends ein Symbol. `info.error` trägt
    den Grund im Klartext. **Nicht** mit der Rolle `indicator.error`: die zwei offiziellen Quellen
    widersprechen sich (Typ-Erkenner: Text, Gültigkeits-Liste des Prüfbots: nur Ja/Nein → E1009) —
    Gültigkeit gewinnt, der Text läuft auf `text`. Beide nur bei ÄNDERUNG geschrieben — seit 0.7.0 gilt das auch für `warning`, `limitReached`,
    `total.limitReached` und `info.connection` (govee-Lehre, Muster in `CLAUDE_PATTERNS.md`).
    Entfallen: `provider`, `reachable`, `serviceOnline`, `state`, `signedIn` — beim Start
    deterministisch gelöscht (feste Liste, kein Zustands-Raten), ioBroker räumt Verwaistes nie
    selbst weg, ein toter Datenpunkt lügt weiter.
14. **Datenpunkt-Bilanz beim Start** (Flotten-Standard, beszel-Vorbild): EINE `info`-Zeile
    „Object tree updated: created N, removed M datapoint(s)", still bei 0/0. Damit sie nicht nach
    jedem Neustart alles als neu meldet, wird VOR Aufräumen und Engine ein Schnappschuss aller
    vorhandenen Zustands-Ids gezogen — der Anlege-Pfad läuft pro Prozess einmal über JEDEN
    Datenpunkt, auch über bestehende. Die Einmal-Migration der abgeschafften Status-Datenpunkte
    zählt NICHT mit, sie meldet ihre eigene Summe. Ausgelöst wird die Zeile, wenn das LETZTE Konto
    seine erste Abfrage hinter sich hat (`afterFirstRound`) — die erste Runde ist bewusst versetzt,
    und ein Konfig-Wechsel startet die Instanz ohnehin neu.

## Tests

```
src/**/*.test.ts               → vitest: Anbieter-Parser gegen echte Antwort-Fixtures,
                                 Poll-Engine/Backoff/Warnlogik mit injizierten Uhren+HTTP-Fakes
test/package.js                → standard: @iobroker/testing packageFiles
test/integration.js            → standard: @iobroker/testing integration (CI)
test/standards/                → iobroker-adapter-checks (Repo-Standards)
```

**Test-Oberfläche krobi:** NUR das Claude-Abo (Max). ChatGPT-Abo, Gemini-Abo, OpenRouter, DeepSeek,
OpenAI-Organisation und Anthropic-Organisation sind vorbild-/messungs-belegt, aber nie an einem
echten Konto gelaufen — der Adapter ist trotzdem für die Community gebaut (krobi 2026-08-26).
Das Ungetestete steht ausdrücklich im Changelog UND in der README: „sagen, nicht behaupten".
Das Stil-Gate prüft Präfix und Länge, NICHT Wahrheit — der Satz muss von Hand rein.
