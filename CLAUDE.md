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

1. **Admin-8-only** (krobi 2026-08-25): Schlüssel-Konten über den zentralen Zugangsdaten-Speicher
   (`system.credentials.*`, Lese-Helfer in adapter-core) — keine eigenen Schlüsselfelder.
   `globalDependencies admin >= 8.0.11` (folgt dem ioBroker-Stable-Stand).
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
5. **Harte Intervall-Untergrenze 60 s + Backoff** — die Claude-Drossel wirkt nach neuerer
   Community-Messung (2026-09, Usage-Monitor #202) PRO ZUGANGS-TOKEN und hängt am Absender-Namen
   (s. Entscheidung 20); die früher berichtete ~24-h-KONTO-Sperre ist damit relativiert, bleibt
   aber der Vorsichtsgrund für die Untergrenze. Für ChatGPT ist keine Kontosperre belegt, der
   Endpunkt ist IP-gedrosselt; für Google gibt es keinen belegten sicheren Takt (einziger Anker:
   deren eigenes Programm cacht 30 s).
6. **Nur Geliefertes anlegen — aber einmal Angelegtes bleibt** (capability-driven); gleiche Sache =
   gleicher Pfad über alle Anbieter. Ein Kontingent ohne brauchbaren Wert wird NICHT als 0 % erfunden.
   ⚠️ Seit 0.10.0 gilt die zweite Hälfte hart (krobi-Fund live 2026-09-01, Klassenfehler wie
   homeconnect-childLock): Anbieter lassen optionale Felder ZUSTANDSABHÄNGIG weg (Anthropic liefert
   `resets_at: null`, solange kein Fenster läuft — gemessen genau in der Drossel-Situation). Ein
   Datenpunkt darf mit dieser Laune nicht kommen und gehen. Deshalb: `resetAt` (und
   `resetCreditsNextExpiry`) sind FESTER Teil ihres Fensters/Kanals — immer angelegt, aktiv mit ""
   geschrieben, wenn gerade nichts läuft (das alte Datum stehen zu lassen wäre eine Lüge).
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
    Claude alles außer `session`/`weekly_all`, ChatGPT die `additional_rate_limits`, **Google seit
    0.8.0 ALLE** — Google liefert überhaupt kein plan-weites Fenster, deshalb greift dort die
    Ausnahme in `limitingWindow`: hat ein Konto NUR Modell-Fenster, spricht das vollste von ihnen
    fürs Konto (vorher sprach jedes einzelne, also wieder der Fable-Fall). Jede Warnmeldung nennt
    das Fenster, bei Google also das Modell.
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
    Entfallen: `provider`, `reachable`, `serviceOnline`, `state`, `signedIn` (0.5.0). Die
    Einmal-Löschung beim Start ist seit 2026-09-06 ausgebaut (krobi: „natürlich aufräumen") — ebenso
    die Token-Datei-Übernahme aus dem 0.2.0-Layout und der Sonderfall für den alten `auth`-Zweig:
    alle drei betrafen nur Versionen VOR der Aufnahme ins Latest-Verzeichnis (2026-08-30, ab 0.6.0),
    und krobis Anlage war live geprüft bereits bereinigt.
    ⚠️ **0.8.0 hatte hier „vor der ersten Antwort wird KEIN Status geschrieben" — das war mein
    Fehler und ist in 0.9.0 zurückgenommen** (siehe Punkt 19): der Weglassen-Ansatz lässt nach
    einem Absturz ein totes Konto grün stehen. Der Start-Stempel ist wieder drin.
14. **Datenpunkt-Bilanz beim Start** (Flotten-Standard, beszel-Vorbild): EINE `info`-Zeile
    „Object tree updated: created N, removed M datapoint(s)", still bei 0/0. Damit sie nicht nach
    jedem Neustart alles als neu meldet, wird VOR Aufräumen und Engine ein Schnappschuss aller
    vorhandenen Zustands-Ids gezogen — der Anlege-Pfad läuft pro Prozess einmal über JEDEN
    Datenpunkt, auch über bestehende. Ausgelöst wird die Zeile, wenn das LETZTE Konto
    seine erste Abfrage hinter sich hat (`afterFirstRound`) — die erste Runde ist bewusst versetzt,
    und ein Konfig-Wechsel startet die Instanz ohnehin neu.
15. **Der Waisen-Aufräumer entfernt nur STRUKTUR, nie Einzelwerte** (0.8.0, geschärft 0.10.0):
    Gelöscht wird ein ganzer `limits.<fenster>`- oder `models.<modell>`-Teilbaum, dessen
    Fenster/Modell die Antwort gar nicht mehr führt (umbenanntes Modell, weggefallenes Fenster) —
    das stünde sonst für immer mit seinem letzten Prozentwert im Baum. Ein EINZELNER Wert in einem
    weiterhin gelieferten Fenster ist NIE eine Waise (0.10.0, krobi-Fund: das Reset-Datum wurde
    mitten in der Drossel gelöscht und nach dem Reset wieder angelegt — s. Entscheidung 6). Werte
    unter credits/costs/tokens bleiben, einmal angelegt, grundsätzlich stehen. Die ERSTE Runde
    vergleicht gegen die Datenbank (`listStateIds`), damit auch zählt, was im Stillstand verschwand;
    danach gegen den vorherigen Schnappschuss. Kinder vor Eltern (`orphanObjectIds`).
16. **Zugangsdaten liegen NUR in der Ablage, nie im Anbieter-Modul** (0.8.0): `tokenStore(provider)`
    gibt pro Anbieter dieselbe Instanz zurück, die den Speicher-Zwischenstand hält. Vorher hatte
    jedes Anbieter-Modul seine eigene Kopie — Abmelden löschte die Datei, der Adapter fragte mit der
    Kopie munter weiter, und die nächste Ticket-Erneuerung schrieb die gelöschte Datei zurück.
17. **Eine Abfrage pro Konto, nie zwei gleichzeitig** (0.8.0): eine Anmeldung stößt sofort eine
    Abfrage an und kann auf eine laufende treffen — zwei Ticket-Erneuerungen parallel melden sich
    auf einem rotierenden Schlüssel gegenseitig ab (Punkt 3). Wer während einer laufenden Abfrage
    anklopft, wird gemerkt und läuft direkt danach.
18. **Der wiederkehrende Takt wird IN der versetzten Erstabfrage scharfgeschaltet** (0.8.0), nicht
    daneben: nebeneinander angelegt zählen alle Konten ab derselben Sekunde und feuern ab der
    zweiten Runde gemeinsam — genau das Bündel, gegen das die Entzerrung und die Mindestwartezeit
    aus Punkt 5 gebaut sind.
19. **Offline-Kennzeichnung an DREI Stellen** (0.9.0, live gemessen — allgemeine Regel jetzt in
    `Entwicklung/CLAUDE_CODING.md`):
    a) **Kein `supportedMessages.stopInstance` im Manifest.** Mit dem Eintrag beendet der Host den
    Prozess bedingungslos hart, `onUnload` läuft NIE — jeder Abschalt-Schreibvorgang war toter
    Code, auch das `info.connection` seit 0.1.0. Ein Test nagelt fest, dass der Eintrag draußen
    bleibt; es ist eine Manifest-Eigenschaft, die kein Code verteidigen kann.
    a2) **`clearStopInstanceFlag()` ganz am Anfang von `onReady`** (0.9.2/0.9.3): der Eintrag lebt
    als Kopie im Instanzobjekt weiter und überlebt jedes Update — ohne diese Einmal-Korrektur
    war (a) auf bestehenden Installationen wirkungslos. Nur bei gesetztem Feld schreiben (sonst
    Neustart-Schleife, jede Objekt-Änderung startet die Instanz neu) und den Start danach SOFORT
    verlassen (sonst Zeitgeber-Warnung im Protokoll). Vorbild: public-holidays.
    b) **`onUnload` meldet erst nach den Schreibvorgängen fertig** (`.finally(callback)`) —
    fire-and-forget kommt nicht an. `markAllOffline()` schreibt `info.unreach`, `info.error`,
    `total.accountsReachable` und `info.connection`; dauert ~100 ms, Frist des Hosts ist 1 s.
    Keine eigene Notbremse: die Adapter-Zeitschaltung verweigert beim Beenden, eine nackte
    meldet der Prüfbot (E5005).
    c) **Start-Stempel im Skelett-Aufbau** — jedes Konto steht auf „liefert nicht", bis die erste
    Antwort da ist. Der tragende Teil: Absturz, Stromausfall und harter Abschuss lassen keinen
    Abschalt-Code laufen. nut2 macht dasselbe mit `markAllUnreachable()`.
    d) **Der Grund-Text ist `REASON_UNKNOWN` = `Unknown`** (0.9.1, krobi-Vorgabe: „da muss eine rote
    linie her in allen adaptern") — an EINER Stelle definiert, benutzt beim Start und beim
    Beenden. Leer im Normalbetrieb, sonst der Text des Anbieters. Vorher stand dort ein Satz,
    den ich mir ausgedacht hatte („The adapter is stopped — nothing is being read"); der
    angehängte Halbsatz war die Rechtfertigung, an der krobi sich gestoßen hat. Ein Gate im
    Konsistenz-Audit fängt jeden adapter-eigenen Wortlaut.
20. **Die Claude-Abfrage meldet sich als claude-code** (0.10.0): der Drossel-Eimer des
    Abfrage-Endpunkts hängt an der Absender-Kennung — dreifach community-gemessen
    (Claude-Code-Usage-Monitor #202, claude-code #31021/#31637): claude-code-Kennung = großzügiger
    Eimer (sicher bei 3-Minuten-Takt), jede fremde Kennung — auch unser früheres
    „ioBroker.ai-usage" — = aggressiver Eimer mit dauerhaften Ablehnungen. Versionsnummer =
    npm-Stand zum Bau-Zeitpunkt; der Eimer hängt am Produktnamen, nicht an der exakten Nummer.
    Gleiches Vorgehen wie govee-smart (Govee-App-Kennung). Die Drossel wirkt PRO Zugangs-Token,
    nicht pro Konto (gleiche Quellen) — die 60-s-Untergrenze aus Entscheidung 5 bleibt trotzdem.
21. **Fehlerklasse einer unlesbaren Antwort ist `service`, nicht `network`** (0.10.0): eine Antwort,
    die ankam, aber nicht unserem Schema entspricht, heißt „der Dienst hat geantwortet und ist
    defekt" — vorher lief sie als „keine Verbindung" mit drei tolerierten Versuchen und versteckte
    einen echten Dienst-Defekt hinter der falschen Anzeige (alle fünf Parser betroffen).
22. **`supportedMessages` wird GELÖSCHT, ausgelöst vom bloßen Vorhandensein des Schlüssels**
    (0.11.0, Audit 2026-09-04 — am Live-Objekt gemessen). Die Korrektur aus 0.9.2 schrieb
    `{ stopInstance: false }` und ihr Wächter prüfte `?.stopInstance`: sie sah ihren eigenen
    Zustand nie wieder, und der Schlüssel ist eine **Positivliste** — steht dort ein Objekt ohne
    einen Wert ungleich `false`, sieht der Host `common.messagebox` nicht mehr an, `subscribeMessage`
    unterbleibt, und KEIN `sendTo` erreicht den Adapter, ohne eine Logzeile. Damit waren alle drei
    Anmelde-Flüsse der Konfigseite tot (`ConfigPanel.ask()`). Richtig ist
    `extendForeignObject(id, { common: { supportedMessages: null } })`, ausgelöst von
    `supported === undefined || supported === null`. Polling und `onUnload` waren nie betroffen —
    ohne stopInstance-Unterstützung nimmt der Host den normalen Entlade-Weg. Zwei Mutationen
    verteidigen beide Hälften.
    ⚠️ **Offener Flotten-Punkt, NICHT hier entschieden:** `.claude/rules/coding.md` kennt einen
    zweiten Fall — ein Adapter, der den Schlüssel legitim braucht (`deviceManager: true`), müsste
    nur den einen Eintrag entfernen, weil das Löschen des ganzen Schlüssels gegen das Manifest
    arbeitet, das ihn beim nächsten Start wieder setzt (Neustart-Schleife). Das Konsistenz-Gate
    verlangt die einfache Form (Auslöser = Schlüssel existiert, geschrieben wird `null`), und die
    ist für DIESEN Adapter richtig: er darf den Schlüssel nie deklarieren (Entscheidung 19a, per
    Test festgenagelt). Eine gehärtete Fassung wurde am 2026-09-04 gebaut und wieder
    zurückgenommen — Gate und Regel gehören der Flotte, nicht diesem Adapter. An krobi gemeldet.
23. **Objektnamen kommen aus `admin/i18n`, gelesen OHNE adapter-core** (0.11.0): der Flotten-Standard
    verlangt das volle Übersetzungsobjekt in `common.name`/`desc` für JEDEN Objekttyp (Kernteam,
    nut2 #15) — der Adapter darf nicht selbst in die Systemsprache auflösen, weil das Objekt die
    Sprache überlebt, die beim Anlegen galt. `I18n` aus adapter-core kommt dafür NICHT in Frage:
    schon der Import ruft `process.exit`, wenn kein js-controller danebensteht, und der Baumbauer
    und die Engine sind reine Module, die die Tests ohne all das fahren. `src/lib/i18n.ts` liest die
    elf Dateien deshalb selbst; sein einziger Mehrwert wäre die Sprachwahl gewesen — genau der
    Schritt, der hier nicht passieren darf. Fehlt ein Schlüssel, steht er als Name im Baum: sichtbar
    und greppbar, statt leer. Umfang: 49 Schlüssel × 11 Sprachen, gegengeprüft von
    `i18n.test.ts` (jede Sprache dieselben Schlüssel, `%s` überall gleich oft, und jeder im
    Quelltext benutzte Schlüssel existiert).
24. **Die drei Manifest-Objekte werden im `onReady` per `extendObject` erneuert** (0.11.0):
    js-controller wendet `instanceObjects` selbst an, aber mit `preserve` auf `common.name` — eine
    UMBENENNUNG erreicht sonst nur neue Anlagen, während Manifest und Namens-Gate grün aussehen.
    Ausgeschrieben mit festen Ids, nicht als Schleife über eine Tabelle: ein Leser und das
    Konsistenz-Gate sollen sehen, welche Objekte abgedeckt sind.
25. **Die ChatGPT-Abfrage meldet sich als Codex** (0.11.0, dieselbe Regel wie Entscheidung 20):
    quellverifiziert in openai/codex, `codex-rs/login/src/auth/default_client.rs` —
    `DEFAULT_ORIGINATOR = "codex_cli_rs"`, und `default_headers()` setzt `originator` UND einen
    User-Agent auf JEDER Anfrage; der Backend-Zugang hängt an dieser Kennung (Whitelist
    `codex_cli_rs`/`codex_vscode`/`codex_sdk_ts`/alles mit `Codex`, sonst 403). Vorher schickte der
    Verbrauchs-Aufruf `ioBroker.ai-usage` und gar keinen originator, während der Gutschein-Aufruf auf
    DERSELBEN Route `Codex Desktop` behauptete. Nie an einem echten Konto geprüft — steht so im
    Changelog.
26. **Eine gekappte Seitenwanderung sagt es** (0.11.0): `fetchAllPages` brach nach 12 Seiten ab,
    während der Kommentar mit 31 Tages-Eimern argumentierte, und gab das Teilergebnis wortlos als
    vollständig zurück — bei kleiner Server-Seitengröße wären `costs.month`/`projectedMonth` still
    zu niedrig gewesen. Schranke jetzt 32 (ein Monat plus eins), und wer sie erreicht, meldet es ins
    Protokoll. Beide Report-Anbieter schicken ein explizites `limit=31`; bei Anthropic fehlte es.
27. **Der Name eines Limit-Fensters ist ein SCHLÜSSEL, nicht der Anbieter-Text** (0.11.0):
    `LimitWindow.label` bleibt die ENGLISCHE Fassung für Logzeilen und Warnmeldungen
    (flottenweit englisch), der Objektname kommt aus `labelKey` (+ `labelArg` für den Teil, den
    der Anbieter benannt hat). Claude `session`/`weekly_all` haben feste Schlüssel, ein
    Modell-Fenster wird `nameWindowModelWeek` mit dem Modell als `%s` → im Baum steht
    „Woche (Fable)"; ChatGPT-Zusatzfenster und Googles Modell-Kontingente analog. Deshalb nimmt
    `tName(key, arg)` als Argument auch ein ÜBERSETZUNGSOBJEKT: sonst stünde in der deutschen
    „%s used"-Zeile der englische Fenstername.
    ⚠️ **Gefunden hat das erst das live-tree-Gate NACH dem Deploy** — das statische Rollen-Gate
    sieht diese Namen nicht, weil sie über einen Laufzeitwert (`limit.label`) liefen. Ein
    Adapter, dessen Namen aus Parser-Werten kommen, ist für den statischen Namens-Check blind.
28. **Datei-Existenz ist keine Lebendigkeit** (0.11.0): `signInState` meldete `signed-in`, sobald die
    Token-Datei etwas hergab — ein vom Anbieter abgelehntes Auffrisch-Token ließ also einen grünen
    Haken neben einem gelben „Sign-in rejected" stehen, die exakte Umkehrung von krobis Fund vom
    2026-09-01. Die Engine meldet den `auth`-Zustand jetzt bei jedem Wechsel über `authState` an den
    Adapter (`rejectedTokens`), und die Karte zeigt wieder den Anmelde-Weg. Die Datei bleibt liegen:
    ein Anbieter-Aussetzer darf den Nutzer nicht hinter seinem Rücken abmelden. Nur `auth` zählt —
    Drossel, Dienst-Defekt und Netzfehler nicht.

29. **Der Anbieter-Katalog ist EINE Tabelle** (0.12.0): `PROVIDERS` in `provider.ts` trägt Kennung,
    Anzeigename, Anmelde-Fluss, feste Konto-Id und „braucht Admin-Schlüssel". Vorher lagen dieselben
    Angaben an fünf Stellen (Typ-Union, Kennungs-Liste, Id-Tabelle, Fluss- und Label-Tabelle) — für
    einen neuen Anbieter fünf Änderungen, ohne dass etwas ein Vergessen gefangen hätte. `ProviderKind`
    wird aus der Tabelle abgeleitet, damit `makeProvider` ohne `default`-Zweig vollständig ist. Die
    Kopie im Konfig-Panel bleibt (eigenes Bündel, kein Import möglich), ist aber per Test an die
    Tabelle genagelt: gleiche Anbieter, gleiche Namen, gleiches Admin-Schlüssel-Kennzeichen.
30. **„Nicht angemeldet" ist eine EIGENE Fehlerklasse** (0.12.0, fünfte neben Entscheidung 11):
    `no-credentials` heißt, es liegt keine Anmeldung/kein Schlüssel vor — `auth` heißt, der Anbieter
    hat eine ABGELEHNT. Zusammengeworfen empfing ein neuer Nutzer vor seiner ersten Anmeldung eine
    Warnung, eine ioBroker-Benachrichtigung und ein rotes „the stored sign-in was rejected"; nach
    jedem bewussten Abmelden dasselbe binnen fünf Minuten. Die neue Klasse meldet still (info),
    benachrichtigt nicht und lässt die Karte den Anmelde-Knopf zeigen.
31. **Ein Konto ohne brauchbaren Zugang bekommt trotzdem sein Skelett** (0.12.0): vorher wurde es im
    Engine-Konstruktor übersprungen — kein Objekt, kein Start-Stempel. Ein Konto, dessen Schlüssel
    aus dem Admin-Speicher verschwand, blieb mit altem Wert UND altem (grünem) Status stehen.
    Entscheidung 19c gilt für JEDES Konto, nicht nur für abfragbare: Skelett + `unreach=true` +
    Grundtext, nie eine Abfrage.
32. **Nach jedem `await` im Abfragepfad wird der Stopp erneut geprüft** (0.12.0): `stop()` bricht
    Zeitgeber ab, keine laufende Anfrage. Die späte Antwort schrieb nach `markAllOffline()` wieder
    „online" — genau der Zustand, gegen den Entscheidung 19 gebaut ist. Fenster: bis zu 15 s.
33. **EINE Antwort auf „liefert das Konto"** (0.12.0): `isDelivering(state)`. Symbol und Fehlertext
    lasen den Konto-Zustand, Totals und `info.connection` ein zweites Flag — eine erste Abfrage in
    der Drossel ließ das Konto grün stehen und meldete daneben „0 Konten erreichbar".
34. **`authOn400` steht am AUFRUF, nicht im Helfer** (0.12.0): richtig für die Token-Endpunkte, falsch
    überall sonst. Der ChatGPT-Gerätecode las einen 400 als „noch nicht bestätigt" und wartete sein
    ganzes Fenster ab, Googles Code-Assist-Aufruf verzichtete deshalb auf seinen Zweit-Host.
35. **`is_active` wird angezeigt, entscheidet aber nichts** (0.12.0, Rohantwort gemessen 2026-09-06):
    Anthropic markiert das Fenster, das gerade gilt (Fable 97 % aktiv, Sitzung 8 % und Woche 54 %
    nicht). Der Baum trägt es als `limits.<fenster>.active`; wo ein Anbieter es nicht liefert
    (ChatGPT, Google), markiert der Baumbauer das Fenster, das fürs Konto spricht — gleiche Bedeutung
    überall. **Die Warnung bleibt an den plan-weiten Fenstern** (krobi 2026-09-06: „fable 100% ist das
    fable limit, aber weder das 5h stunden limit noch das wochenlimit").
36. **`locked_reason` ist das echte Gesperrt-Signal** (0.12.0): es sitzt nur an `five_hour`/`seven_day`
    und sagt, dass der Anbieter das Fenster geschlossen hat. `limitReached` hing bis dahin allein an
    `percent >= 100`. Kein eigener Datenpunkt (krobi 2026-09-06) — es speist `limitReached` und eine
    Protokollzeile beim Übergang.
37. **Fenster-Enden werden auf die MINUTE geschrieben** (0.12.0): Anthropic rechnet den Zeitpunkt je
    Anfrage neu (…59.898Z / …00.364Z / …59.539Z). Unverändert übernommen zählte JEDE Abfrage als
    Änderung — 952 Historien-Einträge in fünf Tagen für 17 echte Fenster (am Server gemessen).
38. **`available` liegt unter `credits`** (0.12.0): „reicht das Guthaben noch für Aufrufe" ist eine
    Aussage über das Guthaben; an der Konto-Wurzel stand sie neben `warning`/`limitReached` und las
    sich wie ein dritter konto-weiter Alarm. Der alte Datenpunkt wird beim Start gelöscht
    (`MOVED_STATES`) — der Adapter räumt seinen Bestand selbst auf.
39. **Das Objekt-Inventar kommt aus einem ECHTEN Lauf, ohne Test-Naht im Produktivcode** (0.12.0):
    ai-usage spricht sieben feste Fremd-Adressen — die Flotten-Vorlage füttert ihre Fixtures aber in
    den laufenden Adapter. Lösung: `test/inventory.js` startet den Adapter im Wegwerf-Controller mit
    `NODE_OPTIONS=--require test/fixtures/inventory/fetch-hook.cjs`; der Haken ersetzt im
    ADAPTER-Prozess das globale `fetch` durch die Fixture-Tabelle und WEIST alles andere ab (kein
    Aufruf verlässt die Maschine). Die vier Schlüssel-Konten bekommen echte
    `system.credentials.*`-Objekte — unverschlüsselt, weil `getCredentials` nur entschlüsselt, was in
    `native.encryptedFields` steht. Die drei Abos melden sich über die echte Nachrichtenbox an
    (`sendTo`), der Adapter schreibt seine Token selbst: damit sind der Gerätecode- und der
    Google-Fluss zum ersten Mal automatisiert abgedeckt. Gewartet wird auf
    `total.accountsReachable == 7`, nicht auf „der Baum wächst nicht mehr" — beim ersten Lauf
    schrieb genau das ein Skelett für vier von sieben Konten. Ergebnis: 137 Objekte, zwei Läufe
    byte-gleich. **Der erste Lauf fand sofort einen Fehler:** die Modell-Kanäle trugen den
    Anbieter-Namen als festen String (`nameModel`-Rahmen statt `model.model`) — für das statische
    Namens-Gate unsichtbar, weil Laufzeitwert.
40. **Beschreibungen gibt es nur, wo der Name nicht reicht** (0.12.0, Flotten-Standard): neun
    `desc`-Schlüssel × 11 Sprachen für die Datenpunkte, deren Bedeutung man dem Namen nicht ansieht —
    `info.unreach`/`info.error` (was „leer" und was „Unknown" heißt), `warning`/`limitReached`
    (warum ein Modell-Fenster sie NICHT auslöst), `limits.*.active`, `limits.*.resetAt` (was ein
    leerer Wert bedeutet), `credits.resetCredits`, `costs.projectedMonth` und
    `total.maxLimitPercent` (beide berechnet, nicht vom Anbieter). Die übrigen 45 bleiben LEER —
    „Kosten heute" erklärt sich selbst, und ein Satz, der den Namen wiederholt, ist schlechter als
    keiner. Inventar: 51 von 96 Datenpunkten mit Beschreibung.
42. **Der Konto-Knoten heißt IMMER „<Name> (<Anbieter>)" — auch wenn beides gleich ist** (krobi
    2026-09-06, nach dem 0.12.0-Deploy entschieden): live liest sich das als „Claude (Claude)", und
    das Inventar zeigt, dass die Dopplung der NORMALFALL ist — die Konfigseite setzt bei den drei
    Abos den Namen fest auf den Anbieter-Namen, und ein Schlüssel-Konto trägt den Namen des
    Admin-Speicher-Eintrags, den man üblicherweise nach dem Anbieter benennt. Ich hatte vorgeschlagen,
    die Klammer wegzulassen, sobald Name == Label; krobi hat sich die vier Möglichkeiten angesehen und
    entschieden: **so lassen** („dann macht es auch durchaus sinn"). Der Anbieter steht damit ausnahmslos
    im Namen — auch bei einem frei benannten Zugang („Arbeitskonto (OpenRouter)"). Nicht erneut vorschlagen.
41. **Die Konfigseite ABONNIERT die Statuswerte** (0.12.0): vorher fragte sie alle vier Sekunden je
    Abo eine Nachricht und je Konto zwei Zustände ab, solange sie offen war. `subscribeState` liefert
    den aktuellen Wert beim Abonnieren gleich mit; gepollt wird nur noch der Anmelde-Status — alle
    vier Sekunden ausschließlich während eines laufenden Gerätecode-Flusses, sonst alle 30 s.

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
