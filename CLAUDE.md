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
                                 verschlüsselte Token-Datei, Cleanup
src/lib/poll-engine.ts         → Orchestrierung (pur, IO injiziert): Zyklen je Konto, Fehlerklassen
                                 (auth=1×Meldung / rate-limit=Backoff / service=sofort offline /
                                 network=3 Versuche), Dienst-Status je Konto,
                                 Warnschwellen-Übergänge, totals
src/lib/provider.ts            → UsageProvider-Vertrag + UsageSnapshot + FetchError-Klassen
src/lib/http.ts                → getJson/postJson/postForm über EINE `request`-Funktion (natives
                                 fetch, Status→eine von VIER Fehlerklassen: auth · rate-limit ·
                                 service · network)
src/lib/providers/claude-auth.ts   → OAuth-Konstanten/PKCE/Tausch/Auffrischung (HA-Vorbild-verifiziert);
                                 Scope NUR user:profile (seit 0.10.0, Vorbild-bewiesen) + die
                                 claude-code-Absender-Kennung (Drossel-Eimer, s. Entscheidung 20)
src/lib/providers/claude-sub.ts    → Abo-Abfrage: limits[]-Auswertung, Extra-Guthaben beide Schemata
src/lib/providers/chatgpt-auth.ts   → Geräte-Code-Anmeldung (Start/Poll/Einlösen/Erneuern)
src/lib/providers/chatgpt-sub.ts   → /wham/usage: 5-h- + Wochen-Fenster, Guthaben; seit 0.10.0 auch
                                 /wham/rate-limit-reset-credits (Reset-Gutschein-Inventar,
                                 CodexBar-quellverifiziert; Zweitabruf best-effort)
src/lib/providers/gemini-auth.ts   → Google-Anmeldung (PKCE, Adresszeile auswerten, Erneuern)
src/lib/providers/gemini-sub.ts    → loadCodeAssist (Projekt) + retrieveUserQuota (Kontingente)
src/lib/providers/openrouter|deepseek|openai|anthropic-api.ts → je Anbieter fetch+parse (pur)
src/lib/sign-in.ts             → Anmelde-Fluss/Label je Anbieter (aus dem Katalog), Zeilen-Zustände
src/lib/sign-in-manager.ts     → die drei Anmelde-Flüsse: laufende Versuche, Gerätecode-Poller,
                                 abgelehnte Token, was die Karte sieht (IO injiziert, ohne ioBroker testbar)
src/lib/jwt.ts                 → Ablaufzeit + ChatGPT-Konto-Kennung aus dem Token lesen
src/lib/providers/report-utils.ts  → Monatsstart/heute/Hochrechnung + Seiten-Blättern für die
                                 beiden Report-Anbieter (OpenAI, Anthropic)
src/lib/snapshot-tree.ts       → Snapshot → Objekt-Definitionen + Werte (capability-driven),
                                 limitingWindow (wer spricht fürs Konto), orphanObjectIds (was weg muss)
src/lib/totals.ts              → total.* aus den Snapshots im Speicher
src/lib/pure-helpers.ts        → Konten-Tabelle parsen (API-Boundary), sanitizeId, Konto-Kennung,
                                 round2/finiteNumber (von allen Anbieter-Modulen benutzt)
src/lib/i18n.ts                → Objektnamen als Übersetzungsobjekt aus `admin/i18n/<lang>.json`
                                 (`tName`), bewusst OHNE adapter-core — s. Entscheidung 23
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

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“ (lokal, gitignored)._

1. **Admin-8-only** — (krobi 2026-08-25): Schlüssel-Konten über den zentralen Zugangsdaten-Speicher (`system.credentials.*`, Lese-Helfer in adapter-core) — keine eigenen Schlüsselfelder.
2. **DREI Zugangs-Wege, weil die Anbieter drei verschiedene erzwingen** — (Recherche 2026-08-26, Belege in `Ressourcen/ai-usage/`): Claude = Code einfügen · ChatGPT = Geräte-Code eintippen, Adapter pollt selbst · Gemini = Adresszeile der Fehlerseite einfügen (GEMESSEN: Googles Geräte-Fluss …
3. **Zugangs-Daten der Abos gehören dem Adapter allein** — eigene Anmeldung, eigene Datei `tokens-<anbieter>.json` im Instanz-Datenverzeichnis.
4. **Konto-Kennungen sind fest und deterministisch** — (`accountId`): Abos `claude`/`chatgpt`/ `gemini`, Schlüssel-Konten `<speichername>-api`.
5. **Harte Intervall-Untergrenze 60 s + Backoff** — die Claude-Drossel wirkt nach neuerer Community-Messung (2026-09, Usage-Monitor #202) PRO ZUGANGS-TOKEN und hängt am Absender-Namen (s. Entscheidung 20); die früher berichtete ~24-h-KONTO-Sperre ist damit relativiert, …
6. **Nur Geliefertes anlegen — aber einmal Angelegtes bleibt** — (capability-driven); gleiche Sache = gleicher Pfad über alle Anbieter.
7. **Gemini: Kennung ist Pflichtteil der Abfrage** — mit der falschen Kennung (User-Agent + `ideType`) antwortet Google trotzdem, liefert aber den stillgelegten Gratis-Satz mit dauerhaft 100 %. Ein Zähler, der nie fällt, ist schlimmer als ein Fehler → beide Aufrufe tragen …
8. **total.costs summiert nur echtes Geld gleicher Währung** — Stück-Guthaben und Fremdwährungen bleiben draußen.
9. **Nach erfolgreicher Anmeldung sofort abfragen** — (`engine.pollNow`) — sonst wirkt ein erfolgreicher Login bis zu 5 Minuten lang wie ein Fehlschlag (krobi-Fund 2026-08-26).
10. **Nur PLAN-WEITE Fenster sprechen fürs Konto** — (`LimitWindow.scoped`, krobi-Fund 2026-08-26: „das betrifft nur Fable, nicht allgemein"): Modell-Kontingente bekommen eigene Datenpunkte, lösen aber nie `warning`/`limitReached` aus — ein Modell, das der Nutzer nie …
11. **Vier Fehlerklassen, damit „offline" etwas bedeutet** — `auth` und `rate-limit` heißen, der Dienst hat GEANTWORTET (er ist online, er sagt nur nein), `service` = er meldet eigenen Defekt (sofort offline, er hat es uns ja gesagt), `network` = nie erreicht (erst nach 3 …
12. **Das Verbindungs-Symbol im Objektbaum kommt AUSSCHLIESSLICH aus `common.statusStates`** — am Geräte-Objekt (`{ offlineId: "info.unreach" }`, relative Id wird zu `<gerät>.<id>` ergänzt) — verifiziert in `adapter-react-v5/src/Components/ObjectBrowser/renderLeaf.tsx`.
13. **ZWEI Status-Datenpunkte je Konto, an ioBrokers eigenen Plätzen** — (krobi 2026-08-26, nachdem ich sechs angelegt hatte, von denen zwei etwas sagten): `info.unreach` (Ja/Nein) ist das Offline-Kennzeichen, das der Typ-Erkenner kennt — `indicator.reachable` ist dort ausdrücklich VERALTET, …
14. **Datenpunkt-Bilanz beim Start** — (Flotten-Standard, beszel-Vorbild): EINE `info`-Zeile „Object tree updated: created N, removed M datapoint(s)", still bei 0/0.
15. **Der Waisen-Aufräumer entfernt nur STRUKTUR, nie Einzelwerte** — (0.8.0, geschärft 0.10.0): Gelöscht wird ein ganzer `limits.<fenster>`- oder `models.<modell>`-Teilbaum, dessen Fenster/Modell die Antwort gar nicht mehr führt (umbenanntes Modell, weggefallenes Fenster) — das stünde …
16. **Zugangsdaten liegen NUR in der Ablage, nie im Anbieter-Modul** — (0.8.0): `tokenStore(provider)` gibt pro Anbieter dieselbe Instanz zurück, die den Speicher-Zwischenstand hält.
17. **Eine Abfrage pro Konto, nie zwei gleichzeitig** — (0.8.0): eine Anmeldung stößt sofort eine Abfrage an und kann auf eine laufende treffen — zwei Ticket-Erneuerungen parallel melden sich auf einem rotierenden Schlüssel gegenseitig ab (Punkt 3). Wer während einer …
18. **Der wiederkehrende Takt wird IN der versetzten Erstabfrage scharfgeschaltet** — (0.8.0), nicht daneben: nebeneinander angelegt zählen alle Konten ab derselben Sekunde und feuern ab der zweiten Runde gemeinsam — genau das Bündel, gegen das die Entzerrung und die Mindestwartezeit aus Punkt 5 gebaut …
19. **Offline-Kennzeichnung an DREI Stellen** — (0.9.0, live gemessen — allgemeine Regel jetzt in `Entwicklung/CLAUDE_CODING.md`): a) **Kein `supportedMessages.stopInstance` im Manifest.** Mit dem Eintrag beendet der Host den Prozess bedingungslos hart, `onUnload` …
20. **Die Claude-Abfrage meldet sich als claude-code** — (0.10.0): der Drossel-Eimer des Abfrage-Endpunkts hängt an der Absender-Kennung — dreifach community-gemessen (Claude-Code-Usage-Monitor #202, claude-code #31021/#31637): claude-code-Kennung = großzügiger Eimer (sicher …
21. **Fehlerklasse einer unlesbaren Antwort ist `service`, nicht `network`** — (0.10.0): eine Antwort, die ankam, aber nicht unserem Schema entspricht, heißt „der Dienst hat geantwortet und ist defekt" — vorher lief sie als „keine Verbindung" mit drei tolerierten Versuchen und versteckte einen …
22. **`supportedMessages` wird GELÖSCHT, ausgelöst vom bloßen Vorhandensein des Schlüssels** — (0.11.0, Audit 2026-09-04 — am Live-Objekt gemessen).
23. **Objektnamen kommen aus `admin/i18n`, gelesen OHNE adapter-core** — (0.11.0): der Flotten-Standard verlangt das volle Übersetzungsobjekt in `common.name`/`desc` für JEDEN Objekttyp (Kernteam, nut2 #15) — der Adapter darf nicht selbst in die Systemsprache auflösen, weil das Objekt die …
24. **Die drei Manifest-Objekte werden im `onReady` per `extendObject` erneuert** — (0.11.0): js-controller wendet `instanceObjects` selbst an, aber mit `preserve` auf `common.name` — eine UMBENENNUNG erreicht sonst nur neue Anlagen, während Manifest und Namens-Gate grün aussehen.
25. **Die ChatGPT-Abfrage meldet sich als Codex** — (0.11.0, dieselbe Regel wie Entscheidung 20): quellverifiziert in openai/codex, `codex-rs/login/src/auth/default_client.rs` — `DEFAULT_ORIGINATOR = "codex_cli_rs"`, und `default_headers()` setzt `originator` UND einen …
26. **Eine gekappte Seitenwanderung sagt es** — (0.11.0): `fetchAllPages` brach nach 12 Seiten ab, während der Kommentar mit 31 Tages-Eimern argumentierte, und gab das Teilergebnis wortlos als vollständig zurück — bei kleiner Server-Seitengröße wären …
27. **Der Name eines Limit-Fensters ist ein SCHLÜSSEL, nicht der Anbieter-Text** — (0.11.0): `LimitWindow.label` bleibt die ENGLISCHE Fassung für Logzeilen und Warnmeldungen (flottenweit englisch), der Objektname kommt aus `labelKey` (+ `labelArg` für den Teil, den der Anbieter benannt hat).
28. **Datei-Existenz ist keine Lebendigkeit** — (0.11.0): `signInState` meldete `signed-in`, sobald die Token-Datei etwas hergab — ein vom Anbieter abgelehntes Auffrisch-Token ließ also einen grünen Haken neben einem gelben „Sign-in rejected" stehen, die exakte …

29. **Der Anbieter-Katalog ist EINE Tabelle** — (0.12.0): `PROVIDERS` in `provider.ts` trägt Kennung, Anzeigename, Anmelde-Fluss, feste Konto-Id und „braucht Admin-Schlüssel".
30. **„Nicht angemeldet" ist eine EIGENE Fehlerklasse** — (0.12.0, fünfte neben Entscheidung 11): `no-credentials` heißt, es liegt keine Anmeldung/kein Schlüssel vor — `auth` heißt, der Anbieter hat eine ABGELEHNT.
31. **Ein Konto ohne brauchbaren Zugang bekommt trotzdem sein Skelett** — (0.12.0): vorher wurde es im Engine-Konstruktor übersprungen — kein Objekt, kein Start-Stempel.
32. **Nach jedem `await` im Abfragepfad wird der Stopp erneut geprüft** — (0.12.0): `stop()` bricht Zeitgeber ab, keine laufende Anfrage.
33. **EINE Antwort auf „liefert das Konto"** — (0.12.0): `isDelivering(state)`.
34. **`authOn400` steht am AUFRUF, nicht im Helfer** — (0.12.0): richtig für die Token-Endpunkte, falsch überall sonst.
35. **`is_active` wird angezeigt, entscheidet aber nichts** — (0.12.0, Rohantwort gemessen 2026-09-06): Anthropic markiert das Fenster, das gerade gilt (Fable 97 % aktiv, Sitzung 8 % und Woche 54 % nicht).
36. **`locked_reason` ist das echte Gesperrt-Signal** — (0.12.0): es sitzt nur an `five_hour`/`seven_day` und sagt, dass der Anbieter das Fenster geschlossen hat.
37. **Fenster-Enden werden auf die MINUTE geschrieben** — (0.12.0): Anthropic rechnet den Zeitpunkt je Anfrage neu (…59.898Z / …00.364Z / …59.539Z).
38. **`available` liegt unter `credits`** — (0.12.0): „reicht das Guthaben noch für Aufrufe" ist eine Aussage über das Guthaben; an der Konto-Wurzel stand sie neben `warning`/`limitReached` und las sich wie ein dritter konto-weiter Alarm.
39. **Das Objekt-Inventar kommt aus einem ECHTEN Lauf, ohne Test-Naht im Produktivcode** — (0.12.0): ai-usage spricht sieben feste Fremd-Adressen — die Flotten-Vorlage füttert ihre Fixtures aber in den laufenden Adapter.
40. **Jeder Datenpunkt ist ENTSCHIEDEN: erklärt oder als selbsterklärend deklariert** — (Flotten-Gate D08, `check-object-inventory.py`, seit 2026-09-07). 21 `desc`-Schlüssel × 11 Sprachen decken 76 der 96 Datenpunkte; die restlichen 20 stehen mit Begründung in `test/self-explaining.json` (8 Muster — …
41. **Die Konfigseite ABONNIERT die Statuswerte** — (0.12.0): vorher fragte sie alle vier Sekunden je Abo eine Nachricht und je Konto zwei Zustände ab, solange sie offen war.
42. **Der Konto-Knoten heißt IMMER „<Name> (<Anbieter>)" — auch wenn beides gleich ist** — (krobi 2026-09-06, nach dem 0.12.0-Deploy entschieden): live liest sich das als „Claude (Claude)", und das Inventar zeigt, dass die Dopplung der NORMALFALL ist — die Konfigseite setzt bei den drei Abos den Namen fest …
43. **`info.lastUpdate` datiert die WERTE, nicht den Abfrageversuch** — (2026-09-07, beim Schreiben seiner Beschreibung gemessen): der Stempel hing an `reachable`, und `isDelivering()` zählt `rate-limited` absichtlich dazu — jede gedrosselte Abfrage datierte damit Werte neu, die sie gar …
44. **`tokens.inputToday` bleibt EIN Name für zwei Anbieter-Wahrheiten** — (2026-09-07, krobi hat die Entscheidung mir überlassen): Anthropic liefert `uncached_input_tokens`, OpenAI `input_tokens` — der Anthropic-Wert lässt Cache-Treffer also weg und meldet bei cache-lastiger Nutzung zu wenig. …

45. **Anthropic rechnet in CENT** — (0.13.0, Nachrecherche zur Audit-Welle): die Referenz des Kosten-Berichts sagt zum Feld `amount` wörtlich „Cost amount in lowest currency units (e.g. cents) as a decimal string.
46. **Ein SCHREIB-Fehler ist kein Anbieter-Fehler** — (0.13.0): `applySnapshot` lag im selben `try` wie der Abruf, also landete ein abgelehntes `extendObject`/`getObjectViewAsync` in `handleFailure` und wurde `network`.
47. **Entscheidung 32 gilt für JEDEN `await` des Abfragepfads** — (0.13.0, die fehlende Hälfte): die Stopp-Prüfung stand nur hinter `provider.fetch()`.
48. **Eine leere Antwort ist kein Aufräum-Auslöser** — (0.13.0, Flotten-Regel „Leere API-Listen NICHT als Cleanup-Trigger"): Der Waisen-Aufräumer las „diese Runde lieferte nichts unter `limits`" als „die Fenster sind weg".
49. **Der Tagesbericht liefert IMMER** — (0.13.0): `snapshot.tokens` wurde nur bei Nutzung gebaut, `snapshot.costs` dagegen immer.
50. **Ein Übergang wird nur behauptet, wenn er beobachtet wurde** — (0.13.0): Warnschwelle und Sperr-Meldung sind Flanken, und die vorherige Seite lag nur im Speicher.
51. **Die Summe kennt das gesperrte Fenster** — (0.13.0, Erweiterung von 36): `computeTotals` las nur den Prozentwert, also sagte `total.limitReached` „nein", während das Konto bei 42 % mit `locked_reason` „ja" sagte — zwei Datenpunkte desselben Adapters im …
52. **Indikatoren aus dem Baumbauer gehen über den Vergleichs-Schreibweg** — (0.13.0, Erweiterung von 13): Die Flotten-Regel („jedes `indicator.*` mit `setStateChangedAsync`") galt überall außer im Baumbauer, der alle seine Writes gleich behandelte — `limits.<fenster>.active` und …
53. **Eine verworfene Konto-Zeile wird benannt** — (0.13.0): unbekannter Anbieter, keine bildbare Id oder eine Id, die eine andere Zeile schon hat — die Zeile verschwand wortlos, und die Startzeile zählt nur die Überlebenden.
54. **Das Gutschein-Inventar wird stündlich geholt, nicht je Zyklus** — (0.13.0): Gutscheine werden von Hand gekauft und eingelöst, die Antwort ist also nahezu statisch — während `/wham/usage` IP-gedrosselt ist und dieser zweite Aufruf in denselben Eimer auf demselben Host geht.

55. **`info.lastUpdate` datiert das ERGEBNIS DIESER RUNDE, nicht den gehaltenen Zustand** — (0.14.0, Audit 2026-09-15 · F1): Entscheidung 43 hat den Drossel-Fall geschlossen, der Netz-Fall blieb offen.
56. **Die Token-Ablage folgt dem SERVER, nicht der Platte** — (0.14.0 · F2 + F3, die zweite Hälfte von Entscheidung 16): `TokenStore.replace(previous, next)` für den Auffrisch-Pfad, in genau dieser Reihenfolge — (1) Tor: schreibt nichts, wenn der Zwischenspeicher nicht mehr …
57. **Ein Nicht-`FetchError` ist ein Dienst-Defekt, kein Netzfehler** — (0.14.0 · F2b, Entscheidung 21 eine Ebene tiefer): ein Parser-`TypeError` lief als Netzfehler mit drei tolerierten Versuchen — zwei Runden still in `debug`, dann „nicht erreichbar" über einen Host, der geantwortet hatte.
58. **Der Waisen-Abgleich ist WARTUNG, nicht Speichern** — (0.14.0 · F5): er lief im selben `try` wie die Wertschreibungen, also verwarf sein Fehlschlag eine Runde, deren Werte nachweislich im Baum standen — das Konto meldete „fetched but not stored", während seine Datenpunkte …
59. **Eine beantwortete Ablehnung nullt den Netz-Strafzähler** — (0.14.0 · F6): `failCount` wurde nur bei Erfolg und im `service`-Zweig genullt.
60. **Angekündigte FAKTEN gehen über den Vergleichs-Schreibweg, Messwerte nicht** — (0.14.0 · F7, Erweiterung von 52): `StateWrite.indicator` heißt jetzt `compare` und wird für Rolle `indicator` UND Rolle `date` gesetzt.
61. **Ein Abmelden löscht die ALARME des Kontos, nicht seine Werte** — (0.14.0 · F8): gemessen — ein bei 100 % abgemeldetes Konto hielt `warning`, `limitReached`, `total.warningsActive`, `total.maxLimitPercent` und `total.limitReached`, bis sich jemand neu anmeldete; eine Automatisierung …
62. **`resets_at` kommt aus dem `limits[]`-Eintrag ODER dem flachen Block** — (0.14.0 · F9): beide im Repo liegenden Ableitungen der Live-Antwort vom 2026-09-06 führen im Sitzungs-Eintrag KEIN `resets_at`, während `five_hour`/`seven_day` es tragen — der Adapter schrieb …
63. **Prototyp-Schlüssel sind keine Anbieter** — (0.14.0 · F4): die Anbieter-Tabellen entstehen über `Object.fromEntries` und tragen damit `Object.prototype` — `SIGN_IN_FLOWS["constructor"]` ist wahr.
64. **„delivering again" erst ab der ZWEITEN Runde eines Prozesses** — (0.14.0 · F10): jedes Konto startet als `no-connection` (Entscheidung 19c), also sah jede erste Antwort wie eine Erholung aus — sieben `info`-Zeilen bei jedem Neustart, über einen Fehler, den nie jemand gemeldet hatte.
65. **Der Anbieter darf seinen eigenen Grund sagen** — (0.14.0 · O2): bei 401/403/429/5xx wurde der Antwortkörper verworfen, `info.error` sagte nur „HTTP 401".
66. **Bei `auth` auf der Verbrauchsabfrage wird EINMAL aufgefrischt und wiederholt** — (0.14.0 · O4): ein serverseitig entwertetes Zugangs-Token vor seinem Ablauf meldete bis zum Ablauf (Claude ~8 h) eine abgelehnte Anmeldung samt Benachrichtigung und erholte sich danach von selbst.
67. **`windowEnd` rundet zur NÄCHSTEN Minute, NICHT auf** — (0.14.0, geprüft und VERWORFEN): der Audit-Vorschlag „aufrunden, damit `resetAt` nie vor dem echten Ende liegt" klingt richtig und zerstört genau die Stabilisierung, für die Entscheidung 37 gebaut wurde — der Jitter des …
68. **Ein Modell ohne Verbrauch bekommt seine 0, statt gefegt zu werden** — (0.15.0 · B1, die zweite Hälfte von Entscheidung 49): Der Verbrauchsbericht ist eine Aussage über einen ZEITRAUM, kein Bestandsverzeichnis — ein Modell fehlt darin, weil nichts darauf lief, nicht weil der Anbieter es …
69. **Die Stopp-Prüfung gilt auch im STARTpfad** — (0.15.0 · B3, die dritte Hälfte von 32/47): `stop()` erreicht nur eine Engine, die schon existiert — ein Abschalten, das in die Wartezeiten des Starts fiel, sah niemand.
70. **Der Antwortkörper hat eine Obergrenze, nicht nur eine Frist** — (0.15.0 · B4): `AbortSignal.timeout` begrenzt, wie LANGE eine Antwort dauern darf, nicht wie GROSS sie werden kann — auf einer schnellen Leitung sind 15 s sehr viel Speicher, in einem Prozess, der monatelang läuft.
71. **Ein Fehlertext hat EINE Quelle** — (0.15.0 · F1, Flotten-Klasse 1 seit 2026-09-02): 25 Stellen trugen `e instanceof Error ? e.message : String(e)` von Hand.

## Tests

```
src/**/*.test.ts               → vitest: Anbieter-Parser gegen echte Antwort-Fixtures,
                                 Poll-Engine/Backoff/Warnlogik mit injizierten Uhren+HTTP-Fakes
test/package.js                → standard: @iobroker/testing packageFiles
test/integration.js            → standard: @iobroker/testing integration (CI)
test/standards/                → iobroker-adapter-checks (Repo-Standards)
test/inventory.js              → Objekt-Inventar aus Fixtures ÜBER ALLE SIEBEN KONTOARTEN
                                 (`npm run test:inventory`) + Upgrade-Suite (INVENTORY_PREVIOUS)
test/fixtures/inventory/       → die Anbieter-Antworten + der `fetch`-Ersatz für den Adapter-Prozess
```

`src/lib/http.test.ts` (seit 0.11.0) nagelt die Status→Fehlerklasse-Abbildung fest, das Rückgrat der
Entscheidungen 11 und 21: sie war bei 6,25 % Zeilen-Deckung und ALLE sechs Mutationen überlebten
(Audit 2026-09-04). `http.ts` ist das einzige Modul ohne injizierte Naht — deshalb `vi.stubGlobal`.
`src-admin/src/rows.test.ts` (seit 0.11.0) prüft die zweite, bis dahin ungetestete Kopie der
Zeilen-Logik im Konfig-Panel — die Datei liegt bei ihrem Code, wird vom ROOT-Testlauf gefahren
(`vitest.config.mts` nimmt `src-admin/src/**` mit auf) und steht seit 2026-09-05 auch in
`coverage.include`: vitest 5 wertet das Muster STRIKT aus, ohne die zweite Zeile fiel die Datei
still aus der Messung ([[reference_vitest5_deckung_und_pool]]); `src/lib/i18n.test.ts` beweist Vollständigkeit und
Platzhalter-Konsistenz der elf Sprachdateien und dass jeder im Quelltext benutzte Schlüssel existiert.

`src/lib/sign-in-manager.test.ts` (seit 0.12.0, 17 Tests) deckt die drei Anmelde-Flüsse ab — bis dahin
lagen sie in `main.ts` und damit außerhalb jedes Tests: der Gerätecode-Fluss, der Zeitfenster-Ablauf,
die Überlappungs-Sperre des Pollers, „abgelehnt schlägt Datei-Existenz" und das Zurücksetzen einer
Ablehnung. Zwei der drei Abos sind nie an einem echten Konto gelaufen — das war die einzige Stelle,
an der das kein Gate auffing.

`src/main.test.ts` (seit 0.8.0) deckt die Adapter-Schicht ab — Zugangsdaten-Ablage, Anmelde-Wege,
Aufräumen, Start-Schnappschuss, Abschalten; ai-usage war der einzige Adapter der Flotte ohne, und
genau dort saßen vier der acht Fehler des 0.8.0-Audits. Ein Test in `pure-helpers.test.ts` nagelt
die ZWEITE Kopie der Kennungs-Regel im Konfig-Panel an die des Adapters.

```

```

**Gates, die es vor 0.11.0 nicht gab** (alle drei fanden beim ersten Lauf etwas):
`npm run lint:admin` + `npm run check:admin` (die Komponente hat eine eigene Lint-Konfiguration und
einen eigenen Compiler; der Typecheck lief in KEINEM Gate und deckte drei in TS 7 entfallende
`tsconfig`-Optionen auf) · `npm run check:config` (ein `tsc`-Lauf allein auf `vitest.config.mts` —
die Datei liegt außerhalb jedes tsconfig-include, dort überlebte ein toter `forks`-Schlüssel den
Sprung auf vitest 5) · CI-Job `admin-check-and-lint`, der beides fährt.
⚠️ Der Job installiert **beide** Abhängigkeitsbäume: der Lint der Komponente lädt die
Prettier-Regel, und Prettier löst seine Konfiguration aufwärts zur Root-Datei auf, die
`@iobroker/eslint-config` importiert ([[feedback_ci_job_im_leeren_klon_pruefen]]).

**Test-Oberfläche krobi:** NUR das Claude-Abo (Max). ChatGPT-Abo, Gemini-Abo, OpenRouter, DeepSeek,
OpenAI-Organisation und Anthropic-Organisation sind vorbild-/messungs-belegt, aber nie an einem
echten Konto gelaufen — der Adapter ist trotzdem für die Community gebaut (krobi 2026-08-26).
Das Ungetestete steht ausdrücklich im Changelog UND in der README: „sagen, nicht behaupten".
Das Stil-Gate prüft Präfix und Länge, NICHT Wahrheit — der Satz muss von Hand rein.
