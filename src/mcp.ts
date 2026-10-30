import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as checkout from "./core/checkout.js";
import { describeError } from "./core/client.js";
import * as dishes from "./core/dishes.js";
import { loadSettings } from "./core/settings.js";
import * as shop from "./core/shop.js";

const AMOUNT_KEYS = new Set(["price", "originalPrice", "total", "discount", "depositTotal", "amount", "minimumOrderValue", "estimatedTotal", "orderLimit"]);
const TIME_KEYS = new Set(["start", "end", "orderBefore", "orderedAt", "expiresAt"]);

const euro = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const berlinTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Prices in euros, times in German local time, and no image URLs, which only cost tokens. */
function toText(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (key === "image" || key === "images" || key === "version") return undefined;
    if (AMOUNT_KEYS.has(key) && typeof v === "number") return euro(v);
    if (TIME_KEYS.has(key) && typeof v === "string" && !Number.isNaN(Date.parse(v))) return berlinTime.format(new Date(v));
    return v;
  });
}

function tool<T>(run: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return { content: [{ type: "text" as const, text: toText(await run(args)) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: describeError(error) }], isError: true };
    }
  };
}

/** The app icon, sent in serverInfo so clients can show it next to the connector. */
function appIcons() {
  try {
    const png = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "app", "icon.png"));
    return [{ src: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png", sizes: ["256x256"] }];
  } catch {
    return undefined;
  }
}

const server = new McpServer(
  { name: "picnic", title: "Picnic", version: "0.1.0", icons: appIcons() },
  {
    instructions: [
      "Zugriff auf das Picnic-Konto des Nutzers (Online-Supermarkt mit Lieferung).",
      "Du kannst Produkte suchen und durchstöbern, den Warenkorb füllen und ein Lieferfenster wählen.",
      "Bestellen geht nur, wenn der Nutzer es im Picnic Desktop Client erlaubt hat, und immer so: prepare_order aufrufen, dem Nutzer Summe, Lieferfenster und Zahlungsart zeigen, seine ausdrückliche Zustimmung abwarten, dann place_order mit dem Bestätigungscode. place_order ist verbindlich: Picnic bucht sofort über die hinterlegte Zahlungsart ab; nur wenn sie eine Bestätigung verlangt (z. B. 3-D Secure), öffnet sich eine Seite im Browser. Danach get_order_status.",
      "Ohne Erlaubnis oder ohne Zustimmung: sag dem Nutzer, dass der Warenkorb bereitliegt und er in der App bestellen kann.",
      "Wenn ein Produkt mehrdeutig ist (Marke, Größe, Bio), nimm bevorzugt Produkte mit boughtBefore=true oder frag nach.",
      "'Meine Gerichte' sind eigene Zusammenstellungen des Nutzers (Produkte, optional Portionen, Makros pro Portion und ein Rezept in Markdown); sie liegen nur auf diesem Gerät.",
      "Wenn die Anmeldung fehlt oder abgelaufen ist, bitte den Nutzer, sich im Picnic Desktop Client anzumelden.",
    ].join(" "),
  },
);

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const changesCart = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

server.registerTool(
  "picnic_status",
  {
    title: "Anmeldestatus",
    description: "Zeigt, ob und mit welchem Konto der Picnic Desktop Client angemeldet ist.",
    annotations: readOnly,
  },
  tool(async () => shop.status()),
);

server.registerTool(
  "search_products",
  {
    title: "Produkte suchen",
    description:
      "Sucht Produkte im Picnic-Sortiment. Liefert id, Name, Marke, Packungsgröße, Preis, Grundpreis, Aktions-Labels und boughtBefore (schon einmal gekauft).",
    inputSchema: {
      query: z.string().min(1).describe("Suchbegriff, z. B. 'Hafermilch' oder 'Bio Bananen'"),
      limit: z.number().int().min(1).max(60).optional().describe("Maximale Anzahl Treffer (Standard 15)"),
    },
    annotations: readOnly,
  },
  tool(async ({ query, limit }: { query: string; limit?: number }) => shop.search(query, limit ?? 15)),
);

server.registerTool(
  "get_product",
  {
    title: "Produktdetails",
    description: "Zeigt Details zu einem Produkt: Beschreibung, Zutaten, Allergene, Nährwerte, Aktion, ähnliche Produkte.",
    inputSchema: { product_id: z.string().describe("Produkt-id, z. B. 's1001524'") },
    annotations: readOnly,
  },
  tool(async ({ product_id }: { product_id: string }) => shop.product(product_id)),
);

server.registerTool(
  "list_categories",
  {
    title: "Kategorien",
    description:
      "Listet die Hauptkategorien des Sortiments. Jeder Eintrag hat kind und categoryId; öffne ihn mit open_category.",
    annotations: readOnly,
  },
  tool(async () => shop.categories()),
);

server.registerTool(
  "open_category",
  {
    title: "Kategorie öffnen",
    description:
      "Öffnet eine Kategorie aus list_categories oder einer Unterkategorie: kind 'subcategories' liefert Unterkategorien, 'products' die Produkte, 'promotions' die Angebote darin.",
    inputSchema: {
      category_id: z.string(),
      kind: z.enum(["subcategories", "products", "promotions"]),
    },
    annotations: readOnly,
  },
  tool(async ({ category_id, kind }: { category_id: string; kind: "subcategories" | "products" | "promotions" }) =>
    shop.openCategory(category_id, kind),
  ),
);

server.registerTool(
  "get_promotions",
  {
    title: "Angebote",
    description: "Zeigt die aktuellen Angebote der Woche, nach Bereichen gruppiert (pro Bereich gekürzt).",
    inputSchema: {
      per_section: z.number().int().min(1).max(40).optional().describe("Produkte pro Bereich (Standard 8)"),
    },
    annotations: readOnly,
  },
  tool(async ({ per_section }: { per_section?: number }) =>
    (await shop.promotions()).map((section) => ({ ...section, products: section.products.slice(0, per_section ?? 8) })),
  ),
);

server.registerTool(
  "get_favorites",
  {
    title: "Meine Produkte",
    description:
      "Zeigt die Produkte, die der Nutzer regelmäßig kauft, nach Gang (Molkerei, Obst, ...). Mit aisle_id die vollständige Liste eines Gangs.",
    inputSchema: { aisle_id: z.string().optional().describe("id eines Gangs aus der Übersicht, z. B. 'DAIRY'") },
    annotations: readOnly,
  },
  tool(async ({ aisle_id }: { aisle_id?: string }) => (aisle_id ? shop.favoritesAisle(aisle_id) : shop.favorites())),
);

server.registerTool(
  "get_cart",
  {
    title: "Warenkorb",
    description: "Zeigt den aktuellen Warenkorb mit Mengen, Preisen, Summe, Mindestbestellwert und gewähltem Lieferfenster.",
    annotations: readOnly,
  },
  tool(async () => shop.cart()),
);

server.registerTool(
  "add_to_cart",
  {
    title: "In den Warenkorb",
    description:
      "Legt ein oder mehrere Produkte in den Warenkorb (erhöht die Menge, falls schon vorhanden). Für Einkaufslisten alle Produkte in einem Aufruf übergeben.",
    inputSchema: {
      items: z
        .array(
          z.object({
            product_id: z.string(),
            count: z.number().int().min(1).max(50).default(1),
          }),
        )
        .min(1),
    },
    annotations: changesCart,
  },
  tool(async ({ items }: { items: { product_id: string; count: number }[] }) =>
    shop.addToCart(items.map((item) => ({ productId: item.product_id, count: item.count }))),
  ),
);

server.registerTool(
  "set_cart_quantity",
  {
    title: "Menge ändern",
    description: "Setzt die Gesamtmenge eines Produkts im Warenkorb. 0 entfernt es.",
    inputSchema: {
      product_id: z.string(),
      quantity: z.number().int().min(0).max(99),
    },
    annotations: changesCart,
  },
  tool(async ({ product_id, quantity }: { product_id: string; quantity: number }) => shop.setQuantity(product_id, quantity)),
);

server.registerTool(
  "clear_cart",
  {
    title: "Warenkorb leeren",
    description: "Entfernt alle Produkte aus dem Warenkorb. Nur verwenden, wenn der Nutzer das ausdrücklich möchte.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  tool(async () => shop.clearCart()),
);

server.registerTool(
  "get_delivery_slots",
  {
    title: "Lieferfenster",
    description:
      "Listet die Lieferfenster mit slotId, Zeitraum, Bestellschluss (orderBefore), Verfügbarkeit und Mindestbestellwert.",
    inputSchema: {
      only_available: z.boolean().optional().describe("Nur buchbare Fenster (Standard true)"),
    },
    annotations: readOnly,
  },
  tool(async ({ only_available }: { only_available?: boolean }) => {
    const result = await shop.deliverySlots();
    return only_available === false ? result : { ...result, slots: result.slots.filter((slot) => slot.available) };
  }),
);

server.registerTool(
  "select_delivery_slot",
  {
    title: "Lieferfenster wählen",
    description: "Wählt ein Lieferfenster für den Warenkorb (slotId aus get_delivery_slots).",
    inputSchema: { slot_id: z.string() },
    annotations: changesCart,
  },
  tool(async ({ slot_id }: { slot_id: string }) => shop.selectSlot(slot_id)),
);

server.registerTool(
  "get_order_history",
  {
    title: "Bestellungen",
    description: "Listet frühere und laufende Lieferungen (neueste zuerst). Details mit get_order.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Anzahl (Standard 10)") },
    annotations: readOnly,
  },
  tool(async ({ limit }: { limit?: number }) => shop.deliveries(limit ?? 10)),
);

server.registerTool(
  "get_order",
  {
    title: "Bestellung ansehen",
    description:
      "Zeigt die Produkte einer Lieferung – nützlich, um eine frühere Bestellung erneut in den Warenkorb zu legen.",
    inputSchema: { delivery_id: z.string() },
    annotations: readOnly,
  },
  tool(async ({ delivery_id }: { delivery_id: string }) => shop.delivery(delivery_id)),
);

const dishSummary = (dish: dishes.Dish) => ({
  dishId: dish.id,
  name: dish.name,
  note: dish.note,
  servings: dish.servings,
  macrosPerServing: dish.macros,
  hasRecipe: !!dish.recipe,
  estimatedTotal: dish.items.reduce((sum, item) => sum + item.price * item.count, 0),
  items: dish.items.map((item) => ({ productId: item.productId, name: item.name, count: item.count })),
});

server.registerTool(
  "list_dishes",
  {
    title: "Meine Gerichte",
    description: "Listet die gespeicherten Gerichte des Nutzers mit Produkten, Portionen, Makros und geschätztem Preis.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => dishes.listDishes().map(dishSummary)),
);

server.registerTool(
  "get_dish",
  {
    title: "Gericht ansehen",
    description: "Zeigt ein Gericht vollständig, inklusive Rezept (Markdown).",
    inputSchema: { dish: z.string().describe("dishId oder Name des Gerichts") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ dish }: { dish: string }) => {
    const found = dishes.findDish(dish);
    return { ...dishSummary(found), recipe: found.recipe, items: found.items };
  }),
);

const macrosSchema = z
  .object({
    kcal: z.number().nonnegative().optional(),
    protein: z.number().nonnegative().optional().describe("Eiweiß in g"),
    carbs: z.number().nonnegative().optional().describe("Kohlenhydrate in g"),
    fat: z.number().nonnegative().optional().describe("Fett in g"),
  })
  .describe("Nährwerte pro Portion");

type SaveDishArgs = {
  dish_id?: string;
  name?: string;
  note?: string;
  servings?: number;
  macros?: Partial<dishes.Macros>;
  recipe?: string;
  items?: { product_id: string; count: number }[];
  from_cart?: boolean;
};

server.registerTool(
  "save_dish",
  {
    title: "Gericht speichern",
    description:
      "Legt ein Gericht an oder ändert eines (mit dish_id). Produkte kommen aus items oder mit from_cart=true aus dem aktuellen Warenkorb. Beim Ändern bleiben weggelassene Felder unverändert, z. B. nur macros oder recipe übergeben.",
    inputSchema: {
      dish_id: z.string().optional().describe("dishId oder Name eines bestehenden Gerichts zum Ändern"),
      name: z.string().optional(),
      note: z.string().optional().describe("Kurze Notiz, z. B. 'für 4 Personen'"),
      servings: z.number().int().min(1).max(50).optional(),
      macros: macrosSchema.optional(),
      recipe: z.string().optional().describe("Zubereitung in Markdown"),
      items: z.array(z.object({ product_id: z.string(), count: z.number().int().min(1).max(50).default(1) })).optional(),
      from_cart: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  tool(async (args: SaveDishArgs) => {
    const existing = args.dish_id ? dishes.findDish(args.dish_id) : null;
    const items = args.items?.length
      ? await dishes.dishItemsFromProducts(args.items.map((item) => ({ productId: item.product_id, count: item.count })))
      : args.from_cart
        ? await dishes.cartAsDishItems()
        : (existing?.items ?? []);
    const saved = dishes.saveDish({
      id: existing?.id,
      name: args.name ?? existing?.name ?? "",
      note: args.note ?? existing?.note,
      servings: args.servings ?? existing?.servings,
      macros: args.macros ? { ...existing?.macros, ...args.macros } : existing?.macros,
      recipe: args.recipe ?? existing?.recipe,
      items,
    });
    return dishSummary(saved);
  }),
);

server.registerTool(
  "add_dish_to_cart",
  {
    title: "Gericht in den Warenkorb",
    description: "Legt alle Produkte eines Gerichts in den Warenkorb, optional mehrfach (times).",
    inputSchema: {
      dish: z.string().describe("dishId oder Name des Gerichts"),
      times: z.number().int().min(1).max(10).optional().describe("Wie oft (Standard 1)"),
    },
    annotations: changesCart,
  },
  tool(async ({ dish, times }: { dish: string; times?: number }) => dishes.addDishToCart(dish, times ?? 1)),
);

server.registerTool(
  "delete_dish",
  {
    title: "Gericht löschen",
    description: "Löscht ein gespeichertes Gericht. Nur auf ausdrücklichen Wunsch des Nutzers.",
    inputSchema: { dish: z.string().describe("dishId oder Name des Gerichts") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  tool(async ({ dish }: { dish: string }) => {
    dishes.deleteDish(dish);
    return { deleted: dish };
  }),
);

/** Opens the payment page in the user's browser, where they approve the payment themselves. */
function openInBrowser(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

const ordersOffHint =
  "Bestellen durch Claude ist ausgeschaltet. Der Nutzer kann es im Picnic Desktop Client unter „Mit Claude verbinden“ erlauben oder selbst in der App bestellen.";

server.registerTool(
  "prepare_order",
  {
    title: "Bestellung vorbereiten",
    description:
      "Prüft, ob der Warenkorb bestellt werden kann: Artikelzahl, Summe, Lieferfenster, Zahlungsart, nicht lieferbare Artikel und Probleme, dazu ein Bestätigungscode für place_order. Zeig dem Nutzer Summe, Lieferfenster und Zahlungsart und frag ausdrücklich, ob bestellt werden soll. Ist slot.suggested true, hat Picnic das Fenster nur vorgeschlagen; sag das dem Nutzer, place_order bestätigt es.",
    annotations: readOnly,
  },
  tool(async () => {
    const settings = loadSettings();
    return {
      ...(await checkout.orderSummary()),
      claudeMayOrder: settings.claudeMayOrder,
      orderLimit: settings.claudeOrderLimit,
      ...(!settings.claudeMayOrder && { note: ordersOffHint }),
    };
  }),
);

server.registerTool(
  "place_order",
  {
    title: "Bestellung auslösen",
    description:
      "Bestellt den Warenkorb verbindlich; Picnic bucht über die hinterlegte Zahlungsart ab. Nur aufrufen, nachdem der Nutzer die Zusammenfassung aus prepare_order ausdrücklich bestätigt hat. Verlangt die Zahlungsart eine Bestätigung, öffnet sich dafür eine Seite im Browser des Nutzers. Danach get_order_status mit der orderId. Meldet Picnic einen Hinweis (z. B. Altersprüfung), zeig ihn dem Nutzer und ruf nach seiner Zustimmung erneut mit resolve_key auf.",
    inputSchema: {
      confirmation: z.string().describe("Bestätigungscode aus prepare_order"),
      resolve_key: z.string().optional().describe("Aus einem Hinweis, dem der Nutzer zugestimmt hat"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ confirmation, resolve_key }: { confirmation: string; resolve_key?: string }) => {
    const settings = loadSettings();
    if (!settings.claudeMayOrder) throw new Error(ordersOffHint);
    const summary = await checkout.orderSummary();
    if (summary.total > settings.claudeOrderLimit) {
      throw new Error(
        `Die Bestellung über ${euro(summary.total)} liegt über dem erlaubten Höchstbetrag von ${euro(settings.claudeOrderLimit)}. Der Nutzer kann den Betrag in der App erhöhen oder selbst bestellen.`,
      );
    }
    const result = await checkout.placeOrder(confirmation, resolve_key);
    if (result.status === "issue") {
      return { ...result, next: "Zeig dem Nutzer den Hinweis. Stimmt er zu und ist blocking=false, place_order mit resolve_key erneut aufrufen." };
    }
    return {
      ...result,
      paymentPageOpened: result.paymentUrl ? openInBrowser(result.paymentUrl) : false,
      next: result.paymentUrl
        ? "Die Zahlungsart verlangt eine Bestätigung: Der Nutzer bestätigt sie auf der Seite im Browser (paymentUrl). Danach get_order_status mit orderId."
        : "Picnic bucht ab. get_order_status mit orderId aufrufen, bis die Bestellung angenommen ist.",
    };
  }),
);

server.registerTool(
  "get_order_status",
  {
    title: "Bestellstatus",
    description: "Prüft, ob eine mit place_order ausgelöste Bestellung bezahlt und von Picnic angenommen ist.",
    inputSchema: { order_id: z.string().describe("orderId aus place_order") },
    annotations: readOnly,
  },
  tool(async ({ order_id }: { order_id: string }) => {
    const status = await checkout.orderStatus(order_id);
    if (status.state !== "placed") return status;
    const [delivery] = await shop.deliveries(1);
    return { ...status, delivery };
  }),
);

server.registerTool(
  "cancel_order",
  {
    title: "Bestellung abbrechen",
    description:
      "Bricht eine mit place_order gestartete Bestellung ab, solange die Zahlung noch auf die Bestätigung des Nutzers wartet (nur wenn place_order eine paymentUrl geliefert hat).",
    inputSchema: { transaction_id: z.string().describe("transactionId aus place_order") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  tool(async ({ transaction_id }: { transaction_id: string }) => {
    await checkout.cancelPayment(transaction_id);
    return { cancelled: true };
  }),
);

await server.connect(new StdioServerTransport());
