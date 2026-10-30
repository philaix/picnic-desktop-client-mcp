import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./session.js";
import * as shop from "./shop.js";

// "Meine Gerichte": the user's own product bundles. They live only on this device, not at Picnic.

/** A product in a dish, with the name, image and price it had when it was added (prices are in cents). */
export type DishItem = {
  productId: string;
  name: string;
  unitQuantity: string;
  image: string | null;
  price: number;
  count: number;
};

/** Nutrition per serving, for tracking; every value is optional. */
export type Macros = {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
};

export type Dish = {
  id: string;
  name: string;
  note: string | null;
  /** How many servings the products make; the macros are per serving. */
  servings: number | null;
  macros: Macros | null;
  /** Cooking instructions in Markdown. */
  recipe: string | null;
  items: DishItem[];
  updatedAt: string;
};

export type DishInput = {
  id?: string | null;
  name: string;
  note?: string | null;
  servings?: number | null;
  macros?: Partial<Macros> | null;
  recipe?: string | null;
  items: DishItem[];
};

const optionalNumber = (value: unknown): number | null => {
  if (typeof value === "string" && !value.trim()) return null;
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.round(number * 10) / 10 : null;
};

function cleanMacros(macros: Partial<Macros> | null | undefined): Macros | null {
  if (!macros) return null;
  const clean = {
    kcal: optionalNumber(macros.kcal),
    protein: optionalNumber(macros.protein),
    carbs: optionalNumber(macros.carbs),
    fat: optionalNumber(macros.fat),
  };
  return Object.values(clean).some((v) => v !== null) ? clean : null;
}

export const dishesFile = () => join(dataDir(), "dishes.json");

export function listDishes(): Dish[] {
  try {
    const dishes: Partial<Dish>[] = JSON.parse(readFileSync(dishesFile(), "utf8"));
    return dishes.map((dish) => ({ servings: null, macros: null, recipe: null, ...dish }) as Dish);
  } catch {
    return [];
  }
}

function writeDishes(dishes: Dish[]): void {
  mkdirSync(dataDir(), { recursive: true });
  const temp = `${dishesFile()}.tmp`;
  writeFileSync(temp, JSON.stringify(dishes, null, 2));
  renameSync(temp, dishesFile());
}

export function saveDish(input: DishInput): Dish {
  const name = input.name?.trim();
  if (!name) throw new Error("Bitte gib dem Gericht einen Namen.");
  const items = new Map<string, DishItem>();
  for (const item of input.items ?? []) {
    const count = Math.max(0, Math.round(item.count));
    if (!count) continue;
    const known = items.get(item.productId);
    if (known) known.count += count;
    else items.set(item.productId, { ...item, count });
  }
  if (items.size === 0) throw new Error("Ein Gericht braucht mindestens ein Produkt.");

  const dishes = listDishes();
  const servings = optionalNumber(input.servings);
  const dish: Dish = {
    id: input.id || randomUUID(),
    name,
    note: input.note?.trim() || null,
    servings: servings ? Math.max(1, Math.round(servings)) : null,
    macros: cleanMacros(input.macros),
    recipe: input.recipe?.trim() || null,
    items: [...items.values()],
    updatedAt: new Date().toISOString(),
  };
  const index = dishes.findIndex((d) => d.id === dish.id);
  if (index >= 0) dishes[index] = dish;
  else dishes.push(dish);
  writeDishes(dishes);
  return dish;
}

/** Finds a dish by id or by name (exact first, then a unique partial match), as Claude may pass either. */
export function findDish(idOrName: string): Dish {
  const dishes = listDishes();
  const wanted = idOrName.trim().toLowerCase();
  const match =
    dishes.find((d) => d.id === idOrName) ??
    dishes.find((d) => d.name.toLowerCase() === wanted) ??
    (() => {
      const partial = dishes.filter((d) => d.name.toLowerCase().includes(wanted));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!match) {
    const names = dishes.map((d) => d.name).join(", ");
    throw new Error(`Kein Gericht „${idOrName}“ gefunden.${names ? ` Vorhanden: ${names}.` : " Es sind noch keine Gerichte gespeichert."}`);
  }
  return match;
}

export function deleteDish(idOrName: string): void {
  const dish = findDish(idOrName);
  writeDishes(listDishes().filter((d) => d.id !== dish.id));
}

export async function addDishToCart(idOrName: string, times = 1) {
  const dish = findDish(idOrName);
  const result = await shop.addToCart(dish.items.map((item) => ({ productId: item.productId, count: item.count * times })));
  return {
    dish: dish.name,
    cart: result.cart,
    failed: result.failed.map((f) => ({ ...f, name: dish.items.find((i) => i.productId === f.productId)?.name ?? null })),
  };
}

/** The current cart as dish items, one per product. */
export async function cartAsDishItems(): Promise<DishItem[]> {
  const cart = await shop.cart();
  return cart.items.map((line) => ({
    productId: line.productId,
    name: line.name,
    unitQuantity: line.unitQuantity,
    image: line.image,
    price: Math.round(line.price / Math.max(1, line.quantity)),
    count: line.quantity,
  }));
}

/** Looks up each product so the dish can show names and images without asking Picnic again. */
export async function dishItemsFromProducts(items: { productId: string; count: number }[]): Promise<DishItem[]> {
  const result: DishItem[] = [];
  for (const { productId, count } of items) {
    const product = await shop.product(productId);
    result.push({
      productId,
      name: product.name,
      unitQuantity: product.quantity,
      image: product.image,
      price: product.price,
      count,
    });
  }
  return result;
}
