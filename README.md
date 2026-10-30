# Picnic Desktop Client

Ein inoffizieller Desktop-Client für den Lebensmittel-Lieferdienst [Picnic](https://picnic.app) – für Windows und macOS. Mit eingebautem MCP-Server, damit Claude für dich Produkte suchen und den Warenkorb füllen kann.

> Kein Produkt von Picnic. Nutzt die inoffizielle, von der Community nachgebaute App-Schnittstelle ([picnic-api](https://github.com/MRVDH/picnic-api)). Picnic kann sie jederzeit ändern.

## Was die App kann

- Angebote der Woche, Kategorien und „Meine Produkte“ durchstöbern
- Produkte suchen, Details mit Zutaten, Allergenen und Nährwerten ansehen
- Warenkorb bearbeiten und Lieferfenster wählen
- Frühere Bestellungen ansehen und mit einem Klick erneut in den Warenkorb legen
- **Meine Gerichte** (eigene Funktion, nicht von Picnic): Produkte zu Gerichten zusammenstellen und mit einem Klick in den Warenkorb legen. Optional mit Portionen, Makros pro Portion (kcal, Eiweiß, Kohlenhydrate, Fett) und einem Rezept in Markdown. Gerichte entstehen im Editor, aus dem aktuellen Warenkorb oder über „Zu einem Gericht hinzufügen“ in der Produktansicht.
- Claude anbinden: Claude füllt den Warenkorb, die App zeigt die Änderungen sofort an

**Bestellen und bezahlen** machst du weiterhin selbst in der Picnic-App auf dem Handy. Der Warenkorb ist dort schon gefüllt, weil er zu deinem Konto gehört.

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

In der App links auf **Mit Claude verbinden** klicken:

- **Claude Desktop:** „In Claude Desktop eintragen“ klicken und Claude Desktop neu starten.
- **Claude Code:** den angezeigten Befehl einmal im Terminal ausführen.

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

Bewusst nicht enthalten: Bestellen, Bezahlen und Stornieren.

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

Einen Mac-Installer kann man nur auf einem Mac bauen. Das übernimmt der GitHub-Workflow: Ein Versions-Tag pushen, und GitHub baut die Windows- und Mac-Installer und hängt sie an ein Release.

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
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
