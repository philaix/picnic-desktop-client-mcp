# Picnic Desktop Client

Ein inoffizieller Desktop-Client für den Lebensmittel-Lieferdienst [Picnic](https://picnic.app) – für Windows und macOS. Mit eingebautem MCP-Server, damit Claude für dich Produkte suchen, den Warenkorb füllen und auf Wunsch bestellen kann.

> Kein Produkt von Picnic. Nutzt die inoffizielle, von der Community nachgebaute App-Schnittstelle ([picnic-api](https://github.com/MRVDH/picnic-api)). Picnic kann sie jederzeit ändern.

## Was die App kann

- Angebote der Woche, Kategorien und „Meine Produkte“ durchstöbern
- Produkte suchen, Details mit Zutaten, Allergenen und Nährwerten ansehen
- Warenkorb bearbeiten und Lieferfenster wählen
- Frühere Bestellungen ansehen und mit einem Klick erneut in den Warenkorb legen
- **Meine Gerichte** (eigene Funktion, nicht von Picnic): Produkte zu Gerichten zusammenstellen und mit einem Klick in den Warenkorb legen. Optional mit Portionen, Makros pro Portion (kcal, Eiweiß, Kohlenhydrate, Fett) und einem Rezept in Markdown. Gerichte entstehen im Editor, aus dem aktuellen Warenkorb oder über „Zu einem Gericht hinzufügen“ in der Produktansicht.
- **Bestellen:** „Bestellen“ im Warenkorb zeigt Summe, Lieferfenster und Zahlungsart. „Zahlungspflichtig bestellen“ bestellt verbindlich, Picnic bucht über deine hinterlegte Zahlungsart ab. Verlangt sie eine Bestätigung (z. B. 3-D Secure), öffnet sich dafür eine Seite im Browser. Die App wartet und meldet die Bestellung.
- Claude anbinden: Claude füllt den Warenkorb, die App zeigt die Änderungen sofort an

Bestellen geht weiterhin auch in der Picnic-App auf dem Handy; der Warenkorb ist dort derselbe, weil er zu deinem Konto gehört.

**Standard-Zahlungsart:** Picnic bucht die bei deinem Konto als Standard gewählte Zahlungsart ab. Ist keine gesetzt (z. B. weil PayPal länger nicht benutzt wurde), lehnt Picnic die Zahlung ab; die App erkennt das vorab und sperrt den Bestell-Button. Dann einmal in der Picnic-App zur Kasse gehen, die Zahlungsart auswählen und abbrechen. Bei PayPal öffnet sich nach „Zahlungspflichtig bestellen“ die PayPal-Seite; meldet der Browser danach, dass er einen Link nicht öffnen kann, ist das normal, die App schließt die Bestellung selbst ab.

### Bestellen durch Claude

Claude darf nur bestellen, wenn du es in der App unter **Mit Claude verbinden** erlaubst (standardmäßig aus), und nur bis zum dort eingestellten Höchstbetrag (Standard 150 €). Dann läuft es immer so: Claude ruft `prepare_order` auf, zeigt dir Summe, Lieferfenster und Zahlungsart und fragt nach. Erst nach deinem Ja ruft es `place_order` mit dem Bestätigungscode auf. Der Code gilt nur für den Warenkorb in genau diesem Zustand. Die Bestellung ist dann verbindlich: Picnic bucht über deine hinterlegte Zahlungsart ab (bei hinterlegtem PayPal oder Lastschrift ohne weitere Rückfrage). Nur wenn die Zahlungsart eine Bestätigung verlangt, etwa 3-D Secure, öffnet sich dafür eine Seite im Browser.

## Installation

Lade die passende Datei unter [Releases](../../releases) herunter:

| System | Datei |
| --- | --- |
| Windows | `Picnic Desktop Client Setup x.y.z.exe` |
| Mac mit Apple-Chip (M1 bis M4) | `Picnic Desktop Client-x.y.z-arm64.dmg` |
| Mac mit Intel-Chip | `Picnic Desktop Client-x.y.z.dmg` |

**Windows:** Die Installationsdatei ist nicht signiert. Wenn SmartScreen warnt: „Weitere Informationen“, dann „Trotzdem ausführen“.

**macOS:** Die App ist nicht von Apple beglaubigt (dafür bräuchte es ein kostenpflichtiges Apple-Entwicklerkonto). So startest du sie trotzdem:

1. `.dmg` öffnen und die App in den Ordner **Programme** ziehen.
2. Einmal im Terminal ausführen, damit macOS die Download-Sperre aufhebt:

   ```bash
   xattr -cr "/Applications/Picnic Desktop Client.app"
   ```

3. App ganz normal öffnen.

Ohne Schritt 2 meldet macOS auf Macs mit Apple-Chip, die App sei „beschädigt“. Das stimmt nicht, es fehlt nur die Beglaubigung durch Apple.

## Anmelden

Beim ersten Start meldest du dich mit deinem Picnic-Konto an (E-Mail und Passwort, danach den SMS-Code). Das Passwort wird nicht gespeichert. Auf dem Gerät bleibt nur der Anmeldeschlüssel, und zwar hier:

- Windows: `%APPDATA%\picnic-desktop-client-mcp\session.json`
- macOS: `~/Library/Application Support/picnic-desktop-client-mcp/session.json`

„Abmelden“ in der App löscht den Schlüssel wieder. Deine Gerichte liegen im selben Ordner in `dishes.json`.

## Mit Claude verbinden

In der App links auf **Mit Claude verbinden** und dort auf den gleichnamigen Button klicken. Er trägt den Zugang an zwei Stellen ein, die Claude getrennt liest:

- **Claude Desktop, Chat** (`claude_desktop_config.json`): Danach Claude Desktop ganz beenden (auch im Tray bzw. in der Menüleiste) und neu starten. Der Zugang steht dann über das „+“ im Eingabefeld → Konnektoren → „Konnektoren verwalten“.
- **Claude Code**, also der Code-Tab der Desktop-App und das Terminal (`~/.claude.json`, über `claude mcp add-json --scope user`): Neue Code-Sessions haben den Zugang. Ist Claude Code nicht installiert, wird dieser Teil übersprungen.

Wer es lieber von Hand macht, findet den Befehl und den JSON-Eintrag in der App unter „Von Hand einrichten“.

Danach kannst du Claude zum Beispiel sagen:

- „Pack mir alles für Spaghetti Bolognese für vier Personen in den Picnic-Warenkorb.“
- „Leg meine letzte Bestellung nochmal in den Warenkorb, aber ohne Getränke.“
- „Such mir ein Lieferfenster am Freitagabend aus.“
- „Speichere den Warenkorb als Gericht ‚Bolognese‘ und trag die Makros pro Portion ein.“
- „Leg mein Gericht Bolognese zweimal in den Warenkorb.“

Die App muss dafür nicht geöffnet sein, nur einmal angemeldet. Ist sie offen, siehst du jede Änderung von Claude sofort im Warenkorb.

### MCP-Werkzeuge

| Werkzeug | Was es tut |
| --- | --- |
| `picnic_status` | Anmeldestatus |
| `search_products` | Produkte suchen |
| `get_product` | Produktdetails, Zutaten, Allergene, Nährwerte |
| `list_categories`, `open_category` | Sortiment durchstöbern |
| `get_promotions` | Angebote der Woche |
| `get_favorites` | Regelmäßig gekaufte Produkte |
| `get_cart` | Warenkorb ansehen |
| `add_to_cart` | Ein oder mehrere Produkte hinzufügen |
| `set_cart_quantity` | Menge ändern oder entfernen |
| `clear_cart` | Warenkorb leeren |
| `get_delivery_slots`, `select_delivery_slot` | Lieferfenster ansehen und wählen |
| `get_order_history`, `get_order` | Frühere Bestellungen |
| `list_dishes`, `get_dish` | Eigene Gerichte ansehen, inklusive Makros und Rezept |
| `save_dish` | Gericht anlegen oder ändern (aus Produkten oder dem Warenkorb; einzelne Felder wie Makros oder Rezept lassen sich nachtragen) |
| `add_dish_to_cart` | Alle Produkte eines Gerichts in den Warenkorb, optional mehrfach |
| `delete_dish` | Gericht löschen |
| `prepare_order` | Zusammenfassung vor dem Bestellen: Summe, Lieferfenster, Zahlungsart, Probleme, Bestätigungscode |
| `place_order` | Bestellung auslösen und Zahlungsseite öffnen (nur mit Erlaubnis in der App, Bestätigungscode und unter dem Höchstbetrag) |
| `get_order_status`, `cancel_order` | Prüfen, ob die Zahlung bestätigt ist, oder die Bestellung vorher abbrechen |

Bewusst nicht enthalten: Stornieren bereits bestellter Lieferungen; das geht in der Picnic-App.

## Entwicklung

Voraussetzung: Node.js 22 oder neuer.

```bash
npm install
```

```bash
npm start
```

Installer lokal bauen (landen in `release/`):

```bash
npm run dist
```

Einen Mac-Installer kann man nur auf einem Mac bauen. Das übernimmt der GitHub-Workflow: Version erhöhen (das legt auch den passenden Tag an) und pushen, dann baut GitHub die Windows- und Mac-Installer und hängt sie an ein Release.

```bash
npm version patch
```

```bash
git push --follow-tags
```

### Aufbau

- `src/core/` – Anmeldung, Sitzung, Shop-Funktionen und Gerichte; von App und MCP-Server gemeinsam genutzt
- `src/core/fusion.ts` – liest Seiten, die Picnic im älteren „Fusion“-Format schickt (in Deutschland Suche und Kategorien)
- `src/mcp.ts` – MCP-Server (stdio)
- `src/main.ts` – Electron-Hauptprozess
- `app/` – Oberfläche (HTML, CSS, JavaScript), Logo `app/logo.svg`
- `build/icon.svg` – App-Icon; nach Änderungen mit `npx electron scripts/render-icons.mjs` neu als PNG rendern

Claude startet den MCP-Server mit dem Electron-Programm der App im Node-Modus (`ELECTRON_RUN_AS_NODE=1`). Deshalb braucht auf dem Rechner niemand Node.js zu installieren.

## Lizenz

MIT
