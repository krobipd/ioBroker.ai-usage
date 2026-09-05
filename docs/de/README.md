# ioBroker.ai-usage

Überwacht Verbrauch, Limits und Kosten deiner KI-Konten und schreibt sie in
schreibgeschützte ioBroker-Datenpunkte. Der Adapter **liest nur** — er ruft nie ein
Modell auf, ändert beim Anbieter nichts und schickt deine Daten nirgendwohin.

---

## Was er überwachen kann

| Konto                               | Was du bekommst                                                                                                            | Wie es verbunden wird                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude-Abo** (Pro / Max)          | 5-Stunden- und Wochen-Fenster mit Prozent und Reset-Zeit, Modell-Fenster, Extra-Guthaben und die dafür ausgegebenen Kosten | Anmeldung mit deinem eigenen Anthropic-Konto: Link öffnen, anmelden, Code zurück einfügen                                                                                                                 |
| **ChatGPT-Abo** (Plus / Pro, Codex) | 5-Stunden- und Wochen-Fenster, zusätzliche Fenster je Oberfläche, Guthaben, kaufbare Limit-Reset-Gutscheine                | Der Adapter zeigt einen kurzen Code, den du auf der OpenAI-Seite eintippst. Deine eigene Codex-Anmeldung wird nicht angefasst                                                                             |
| **Google-Gemini-Abo** (Pro / Ultra) | Die Modell-Kontingente, die Google meldet                                                                                  | Link öffnen und anmelden. Google leitet auf `localhost` zurück, **dein Browser zeigt also eine Fehlerseite — das ist so gewollt**. Die komplette Adresse aus der Adresszeile kopieren und zurück einfügen |
| **OpenRouter**                      | Verbrauchtes Guthaben, Grenze, Rest, Prozent                                                                               | Gespeicherten Schlüssel aus dem zentralen Admin-Speicher wählen                                                                                                                                           |
| **DeepSeek**                        | Guthaben (gewährt und aufgeladen getrennt) und ob es noch für Anfragen reicht                                              | Gespeicherten Schlüssel wählen                                                                                                                                                                            |
| **OpenAI-Organisation**             | Kosten heute und diesen Monat, Monatsend-Prognose, heutige Token je Modell                                                 | Braucht einen **Admin-Schlüssel** deiner Organisation                                                                                                                                                     |
| **Anthropic-Organisation**          | Kosten heute und diesen Monat, Monatsend-Prognose, heutige Token                                                           | Braucht einen **Admin-Schlüssel** deiner Organisation                                                                                                                                                     |

Die drei Abo-Endpunkte sind die, die auch die Programme der Anbieter selbst benutzen. Sie
sind **nicht offiziell dokumentiert** und können sich jederzeit ändern. Claude wurde an
einem echten Abo getestet; ChatGPT und Google sind quellen-belegt gebaut, liefen aber nie
an einem echten Konto — melde dich bitte über ein Issue, wenn etwas nicht stimmt.

---

## Voraussetzungen

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- **ioBroker Admin >= 8.0.11** — der Adapter liest API-Schlüssel aus dem zentralen
  Zugangsdaten-Speicher des Admin, statt sie noch einmal abzufragen

---

## Einrichten

1. Adapter installieren und die Instanz-Einstellungen öffnen.
2. Die Seite zeigt **eine Liste**: zuerst die drei Abos, danach eine Zeile pro
   KI-Schlüssel, den du unter **Admin → Einstellungen → Zugangsdaten** hinterlegt hast.
3. Einschalten, was überwacht werden soll. Jede Zeile hat ihre eigene **Warnschwelle**
   (10–100 %, Standard 80 %).
4. Bei einem Abo klappt unter der Zeile der Anmelde-Bereich auf und führt durch genau den
   Weg, den dieser Anbieter erzwingt. **Vorher speichern** — die Anmeldung läuft über die
   laufende Instanz.
5. Nach erfolgreicher Anmeldung wird das Konto sofort abgefragt; du musst nicht auf den
   nächsten Zyklus warten.

### Optionen

| Option                 | Wirkung                                                                                                               | Standard |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| **Abfrage-Intervall**  | Wie oft jedes Konto abgefragt wird, in Sekunden. Minimum 60 s                                                         | 300 s    |
| **Benachrichtigungen** | Eine ioBroker-Meldung, wenn ein Konto seine Warnschwelle überschreitet oder die Zugangsdaten nicht mehr funktionieren | ein      |

Die Konten werden zeitlich versetzt abgefragt. Antwortet ein Anbieter mit „zu viele
Anfragen", geht genau dieses Konto in einen wachsenden Backoff (10 Minuten, verdoppelnd
bis zu einer Stunde) — die zuletzt gelesenen Werte bleiben dabei stehen.

---

## Der Objektbaum

Ein Geräte-Knoten pro Konto, bei jedem Anbieter gleich benannt:

```
ai-usage.0
├─ info.connection            mindestens ein Konto liefert Daten
├─ <konto>                    z. B. claude, chatgpt, gemini, <name>-api
│  ├─ info.unreach            das Offline-Kennzeichen; steuert das Symbol im Objektbaum
│  ├─ info.error              der Grund im Klartext; leer, solange alles läuft
│  ├─ info.lastUpdate         letzte erfolgreiche Abfrage
│  ├─ warning                 über der Warnschwelle des Kontos
│  ├─ limitReached            bei 100 %
│  ├─ limits.<fenster>.percent     Auslastung eines Limit-Fensters
│  ├─ limits.<fenster>.resetAt     wann es zurückgesetzt wird (leer, wenn keins läuft)
│  ├─ credits.*               verbraucht / Grenze / Rest / Prozent, gewährt / aufgeladen
│  ├─ costs.*                 heute / Monat / gesamt / Monatsend-Prognose
│  ├─ tokens.*                Eingabe- und Ausgabe-Token heute
│  └─ models.<modell>.*       Token und Kosten je Modell
└─ total
   ├─ costs.today / month / projectedMonth      summiert über alle USD-Konten
   ├─ maxLimitPercent         das vollste Konto (Limit-Fenster oder Budget)
   ├─ warningsActive          Konten über ihrer Schwelle
   ├─ limitReached            irgendein Konto bei 100 %
   ├─ accountsReachable       Konten, die gerade liefern
   └─ accounts                Konten, die du eingeschaltet hast
```

**Einmal angelegte Datenpunkte bleiben.** Lässt ein Anbieter ein Feld zeitweise weg,
verschwindet der Datenpunkt nicht — Zeitstempel werden stattdessen leer geschrieben.
Entfernt wird nur ein ganzes Fenster oder Modell, das der Anbieter gar nicht mehr meldet;
und ein ausgeschaltetes Konto verliert seinen Knoten vollständig.

**`total.costs` summiert nur echtes Geld gleicher Währung** — Stück-Zähler
(Anfrage-Guthaben, Reset-Gutscheine) und Fremdwährungen bleiben bewusst draußen.

---

## Warnungen — und was fürs Konto spricht

Nur ein **plan-weites** Fenster löst die Warnung eines Kontos aus. Ein Modell-Kontingent
bekommt eigene Datenpunkte, aber nie den Alarm: ein Modell, das du nie anfasst, kann
dauerhaft auf 100 % stehen, und ein Alarm, der nie ausgeht, ist schlimmer als keiner.
Google ist die Ausnahme — dort gibt es überhaupt kein plan-weites Fenster, also spricht
das vollste Modell-Kontingent fürs Konto, und die Meldung nennt das Modell.

Das gewährte Budget konkurriert mit den Fenstern: ein Konto, dessen Geld fast verbraucht
ist, steht genauso still wie eines mit vollem Zeitfenster. Die höhere der beiden Seiten
gibt der Warnung ihre Beschriftung.

---

## Online-Status

`info.unreach` heißt **„dieses Konto liefert nicht"** und steuert das Verbindungssymbol
neben dem Konto im Objektbaum:

| Lage                                                    | Symbol                                 | `info.error`                         |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| Alles läuft                                             | grün                                   | leer                                 |
| Vom Anbieter gedrosselt                                 | grün — die letzten Werte gelten weiter | sagt es, mit der Wartezeit           |
| Anmeldung abgelehnt                                     | rot                                    | „Sign-in rejected — …"               |
| Der Dienst meldet einen Defekt                          | rot                                    | „The AI service reports a fault — …" |
| Gar nicht erreichbar                                    | rot, nach drei Versuchen               | „Not reachable after N attempts — …" |
| Instanz gestoppt, oder gestartet und noch nicht gefragt | rot                                    | `Unknown`                            |

---

## Datenschutz und Zugangsdaten

- Abo-Token gehören dem Adapter allein: sie liegen verschlüsselt im Instanz-Datenordner,
  nur für den Eigentümer lesbar. Der Adapter liest und schreibt **niemals** die Dateien
  deiner eigenen Programme (`~/.codex/auth.json`, `oauth_creds.json`) — deren
  Auffrisch-Token rotieren, zwei Erneuerer würden sich gegenseitig abmelden.
- API-Schlüssel kommen aus dem zentralen Admin-Speicher und werden nicht kopiert.
- Die Claude-Anmeldung fragt nur das Profil-Recht ab — das Token kann keine API-Schlüssel
  anlegen und keine Modelle aufrufen.
- Der Adapter spricht mit den KI-Anbietern und mit sonst niemandem.

---

## Wenn etwas klemmt

**Der Anmelde-Knopf tut nichts / die Zeile dreht sich endlos.**
Erst speichern, und sicherstellen, dass die Instanz läuft — die Anmeldung ist ein Gespräch
mit dem laufenden Adapter.

**Google zeigt nach der Anmeldung eine Fehlerseite.**
Das ist so gewollt und der Grund, warum der Weg überhaupt funktioniert. Die **komplette
Adresse** aus der Adresszeile kopieren und in das Feld einfügen.

**„Nicht angemeldet", obwohl du dich angemeldet hast.**
Die gespeicherte Anmeldung wurde vom Anbieter abgelehnt (zurückgezogenes oder abgelaufenes
Auffrisch-Token). Melde dich neu an — die Zeile sagt es dir, statt eine Verbindung
vorzutäuschen.

**Ein OpenAI- oder Anthropic-Konto liefert nichts.**
Diese Berichte brauchen einen **Organisations-Admin-Schlüssel**. Ein Privatkonto ohne
Organisation kann sie gar nicht erzeugen — nimm dafür das Claude-Abo.

**Claude antwortet mit „zu viele Anfragen".**
Intervall erhöhen. Der Adapter meldet sich so an, wie es Claudes eigene Werkzeuge tun, und
bremst sich selbst — bei sehr kurzen Intervallen über mehrere Programme hinweg kann es
trotzdem zusammenkommen.

---

## Unterstützung

Fragen, Fehler und Ideen: <https://github.com/krobipd/ioBroker.ai-usage/issues>
