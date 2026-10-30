import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describeError } from "./core/client.js";
import * as dishes from "./core/dishes.js";
import * as shop from "./core/shop.js";

const AMOUNT_KEYS = new Set(["price", "originalPrice", "total", "discount", "depositTotal", "amount", "minimumOrderValue", "estimatedTotal"]);
const TIME_KEYS = new Set(["start", "end", "orderBefore", "orderedAt"]);

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
    if (key === "image" || key === "images") return undefined;
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
      "Bestellen und bezahlen kann nur der Nutzer selbst in der Picnic-App – sag ihm am Ende, dass der Warenkorb bereitliegt.",
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

await server.connect(new StdioServerTransport());
