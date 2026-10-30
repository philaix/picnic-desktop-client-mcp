import PicnicClient from "picnic-api";
import { extractFavorites, extractFavoritesInAisle } from "picnic-api/lib/domains/catalog/favorites.js";
import { extractPromotions } from "picnic-api/lib/domains/catalog/promotions.js";
import { getClient } from "./client.js";
import { fusionLinks, fusionProductNames, fusionSections, loadFusionPage, type FusionLink } from "./fusion.js";
import { loadSession, markCartChanged } from "./session.js";

type ProductTile = PicnicClient.Types.catalog.ProductTile;
type SearchProductResults = PicnicClient.Types.catalog.SearchProductResults;
type CategoryLink = PicnicClient.Types.catalog.CategoryLink;
type RawCart = PicnicClient.Types.cart.Cart;
type CartLineItem = PicnicClient.Types.cart.CartLineItem;
type ImageSize = PicnicClient.Types.common.ImageSize;

// All amounts below are in cents, as Picnic sends them. The MCP server turns them into euros.

export type Tile = {
  id: string;
  name: string;
  brand: string | null;
  quantity: string;
  price: number;
  originalPrice: number | null;
  unitPrice: string | null;
  labels: string[];
  unavailable: boolean;
  image: string | null;
  boughtBefore?: boolean;
};

export type Section = { title: string | null; products: Tile[] };

export type CategoryEntry = {
  name: string;
  label: string | null;
  image: string | null;
  /** What opening the entry shows; `page` entries link to app pages this client doesn't show. */
  kind: "subcategories" | "products" | "promotions" | "page";
  categoryId: string | null;
};

export type CartItem = {
  productId: string;
  name: string;
  quantity: number;
  unitQuantity: string;
  price: number;
  originalPrice: number | null;
  maxCount: number;
  labels: string[];
  unavailable: boolean;
  unavailableReason: string | null;
  image: string | null;
};

export type CartView = {
  /** The cart's modification timestamp (`mts`); checkout only works for the cart in this state. */
  version: number;
  items: CartItem[];
  totalCount: number;
  total: number;
  discount: number;
  depositTotal: number;
  fees: { name: string; amount: number }[];
  minimumOrderValue: number | null;
  slot: { slotId: string; start: string | null; end: string | null; chosenByUser: boolean } | null;
};

function image(imageId: string | null | undefined, size: ImageSize = "small"): string | null {
  return imageId ? getClient().catalog.getImageUrl(imageId, size) : null;
}

function toTile(tile: ProductTile, boughtBefore = false): Tile {
  return {
    id: tile.id,
    name: [tile.namePrefix, tile.name].filter(Boolean).join(" "),
    brand: tile.brand,
    quantity: tile.unitQuantity,
    price: tile.displayPrice,
    originalPrice: tile.originalPrice,
    unitPrice: tile.unitPrice,
    labels: tile.labels.map((label) => label.text).filter((text): text is string => !!text),
    unavailable: tile.isUnavailable,
    image: image(tile.imageId),
    ...(boughtBefore && { boughtBefore }),
  };
}

function toSections(results: SearchProductResults): Section[] {
  return results.sections
    .filter((section) => section.products.length > 0)
    .map((section) => ({ title: section.title, products: section.products.map((p) => toTile(p, section.type === "RFY")) }));
}

function toCategoryEntry(link: CategoryLink): CategoryEntry {
  return {
    name: link.name,
    label: link.label,
    image: image(link.imageId),
    kind: link.target.type,
    categoryId: "categoryId" in link.target ? link.target.categoryId : null,
  };
}

function toCartItem(line: CartLineItem): CartItem {
  return {
    productId: line.productId,
    name: line.name,
    quantity: line.quantity,
    unitQuantity: line.unitQuantity,
    price: line.displayPrice,
    originalPrice: line.originalPrice,
    maxCount: line.maxCount,
    labels: line.labels.map((label) => label.text),
    unavailable: line.isUnavailable,
    unavailableReason: line.unavailableReason,
    image: image(line.imageId),
  };
}

function toCartView(cart: RawCart): CartView {
  return {
    version: cart.mts,
    items: cart.items.map(toCartItem),
    totalCount: cart.totalCount,
    total: cart.totalPrice,
    discount: cart.discount,
    depositTotal: cart.depositTotal,
    fees: cart.fees.map((fee) => ({ name: fee.name, amount: fee.amount })),
    minimumOrderValue: cart.minimumOrderValue,
    slot: cart.selectedSlot && {
      slotId: cart.selectedSlot.slotId,
      start: cart.selectedSlot.windowStart,
      end: cart.selectedSlot.windowEnd,
      chosenByUser: cart.selectedSlot.isExplicitSelection,
    },
  };
}

export function status() {
  const session = loadSession();
  return { loggedIn: !!session.authKey, userName: session.userName, countryCode: session.countryCode };
}

/** Pages Picnic served as Fusion in this process, so later calls skip the RSC attempt. */
const fusionPages = new Set<string>();

async function withFusionFallback<T>(page: string, rsc: () => Promise<T>, fusion: () => Promise<T>): Promise<T> {
  if (!fusionPages.has(page)) {
    try {
      return await rsc();
    } catch (error) {
      if (!PicnicClient.isUnexpectedPageFormatError(error)) throw error;
      fusionPages.add(page);
    }
  }
  return fusion();
}

const isCategoryPage = (pageId: string) => /^L\d-/.test(pageId);

function toFusionCategoryEntry(link: FusionLink): CategoryEntry {
  return {
    name: link.name,
    label: null,
    image: image(link.imageId),
    kind: /promotion/i.test(link.pageId) ? "promotions" : link.pageId.startsWith("L1-") ? "subcategories" : "products",
    // Fusion categories are opened by their page id, e.g. "L2-category-page-root?category_id=19374".
    categoryId: link.pageId,
  };
}

export async function search(query: string, limit = 40) {
  const client = getClient();
  return withFusionFallback(
    "search",
    async () => {
      const results = await client.catalog.getSearchResults(query);
      const products = new Map<string, Tile>();
      for (const section of results.products?.sections ?? []) {
        for (const product of section.products) {
          const known = products.get(product.id);
          if (known) {
            if (section.type === "RFY") known.boughtBefore = true;
          } else {
            products.set(product.id, toTile(product, section.type === "RFY"));
          }
        }
      }
      return { query, correctedQuery: results.correctedQuery, products: [...products.values()].slice(0, limit) };
    },
    async () => {
      const page = await loadFusionPage(client, `search-page-results?search_term=${encodeURIComponent(query)}`);
      const products = fusionSections(page).flatMap((section) => section.products);
      return { query, correctedQuery: null as string | null, products: products.slice(0, limit).map((p) => toTile(p)) };
    },
  );
}

export async function categories() {
  const client = getClient();
  return withFusionFallback(
    "categories",
    async () => {
      const sections = await client.catalog.getCategories();
      return sections.map((section) => ({ title: section.title, entries: section.links.map(toCategoryEntry) }));
    },
    async () => {
      const links = fusionLinks(await loadFusionPage(client, "category-tree-root"));
      return [{ title: null, entries: links.filter((link) => isCategoryPage(link.pageId)).map(toFusionCategoryEntry) }];
    },
  );
}

export async function openCategory(categoryId: string, kind: "subcategories" | "products" | "promotions") {
  const client = getClient();
  const catalog = client.catalog;
  if (isCategoryPage(categoryId)) {
    const page = await loadFusionPage(client, categoryId);
    const sections = fusionSections(page).map((s) => ({ title: s.title, products: s.products.map((p) => toTile(p)) }));
    const entries = fusionLinks(page)
      .filter((link) => isCategoryPage(link.pageId) && link.pageId !== categoryId)
      .map(toFusionCategoryEntry);
    return { kind: sections.length ? kind : "subcategories", title: "", entries, sections };
  }
  if (kind === "subcategories") {
    const page = await catalog.getSubcategories(categoryId);
    return { kind, title: page.title, entries: page.links.map(toCategoryEntry), sections: [] as Section[] };
  }
  const page =
    kind === "products" ? await catalog.getCategoryProducts(categoryId) : await catalog.getCategoryPromotions(categoryId);
  return { kind, title: page.title, entries: [] as CategoryEntry[], sections: toSections(page.results) };
}

/**
 * Loads a Fusion page that picnic-api reads itself, and returns its reading with the full product
 * names (see fusion.ts) and a tile mapper that applies them.
 */
async function readFusionWithNames<T>(pageId: string, extract: (page: unknown) => T) {
  const page = await loadFusionPage(getClient(), pageId);
  const names = fusionProductNames(page);
  const tile = (p: ProductTile) => toTile(names.has(p.id) ? { ...p, name: names.get(p.id)!, namePrefix: null } : p);
  return { result: extract(page), tile };
}

export async function promotions() {
  const { result, tile } = await readFusionWithNames("promo-page-root", extractPromotions);
  return result.sections
    .filter((section) => section.products.length > 0 || section.groups.length > 0)
    .map((section) => ({
      title: section.title,
      products: section.products.map(tile),
      groups: section.groups.map((group) => ({ id: group.id, name: group.name, example: group.example, label: group.label })),
    }));
}

export async function promotionGroup(groupId: string) {
  const client = getClient();
  return withFusionFallback(
    "promotionGroup",
    async () => {
      const group = await client.catalog.getPromotionGroup(groupId);
      return { title: group.name, products: group.products.map((p) => toTile(p)) };
    },
    async () => {
      const sections = fusionSections(await loadFusionPage(client, `promo-group-deep-dive?promo_group_id=${encodeURIComponent(groupId)}`));
      return { title: sections[0]?.title ?? "Aktion", products: sections.flatMap((s) => s.products).map((p) => toTile(p)) };
    },
  );
}

export async function favorites() {
  const { result, tile } = await readFusionWithNames("purchases-page-root", extractFavorites);
  return result.aisles
    .filter((aisle) => aisle.products.length > 0)
    .map((aisle) => ({ id: aisle.id, title: aisle.title, products: aisle.products.map(tile), complete: aisle.complete }));
}

export async function favoritesAisle(aisleId: string) {
  const { result, tile } = await readFusionWithNames(`aisle-deep-dive?aisle_id=${encodeURIComponent(aisleId)}`, extractFavoritesInAisle);
  return result.map(tile);
}

export async function product(productId: string) {
  const p = await getClient().catalog.getProduct(productId);
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    quantity: p.unitQuantity,
    price: p.displayPrice,
    originalPrice: p.originalPrice,
    unitPrice: p.unitPrice,
    maxCount: p.maxCount,
    labels: p.labels.map((label) => label.text),
    tags: p.tags.map((tag) => tag.text),
    promotion: p.promotion?.label ?? null,
    description: p.description,
    highlights: p.highlightItems.map((item) => item.text),
    allergens: {
      contains: p.allergenGroups.contains.map((a) => a.text),
      mayContain: p.allergenGroups.mayContain.map((a) => a.text),
    },
    info: p.infoSections.map((section) => ({ title: section.title, content: section.content })),
    nutrition: p.nutritionRows.map((row) => ({ label: row.label, value: row.value, isCategory: row.isCategory })),
    image: image(p.imageIds[0]),
    images: p.imageIds.map((id) => image(id, "large")).filter((url): url is string => !!url),
    similar: p.similarProducts.map((s) => ({
      id: s.id,
      name: s.name,
      quantity: s.unitQuantity,
      price: s.displayPrice,
      image: image(s.imageId),
    })),
  };
}

export async function cart(): Promise<CartView> {
  return toCartView(await getClient().cart.getCart());
}

export async function addToCart(items: { productId: string; count: number }[]) {
  const client = getClient();
  const failed: { productId: string; error: string }[] = [];
  let latest: RawCart | null = null;
  // One after another: parallel mutations of the same cart can overwrite each other.
  for (const item of items) {
    try {
      latest = await client.cart.addProductToCart(item.productId, item.count);
    } catch (error) {
      failed.push({ productId: item.productId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (latest) markCartChanged();
  return { cart: toCartView(latest ?? (await client.cart.getCart())), failed };
}

/** Sets the total quantity of a product in the cart; 0 removes it. */
export async function setQuantity(productId: string, quantity: number): Promise<CartView> {
  const client = getClient();
  const current = (await client.cart.getCart()).items
    .filter((line) => line.productId === productId)
    .reduce((sum, line) => sum + line.quantity, 0);
  const diff = quantity - current;
  if (diff === 0) return cart();
  const updated =
    diff > 0
      ? await client.cart.addProductToCart(productId, diff)
      : await client.cart.removeProductFromCart(productId, -diff);
  markCartChanged();
  return toCartView(updated);
}

export async function clearCart(): Promise<CartView> {
  const updated = await getClient().cart.clearCart();
  markCartChanged();
  return toCartView(updated);
}

export async function deliverySlots() {
  const { slots, selectedSlot } = await getClient().cart.getDeliverySlots();
  return {
    selectedSlotId: selectedSlot?.slotId ?? null,
    slots: slots.map((slot) => ({
      slotId: slot.slotId,
      start: slot.windowStart,
      end: slot.windowEnd,
      orderBefore: slot.cutOffTime,
      available: slot.isAvailable,
      selected: slot.isSelected,
      greenChoice: slot.isGreenChoice,
      minimumOrderValue: slot.minimumOrderValue,
    })),
  };
}

export async function selectSlot(slotId: string): Promise<CartView> {
  const updated = await getClient().cart.setDeliverySlot(slotId);
  markCartChanged();
  return toCartView(updated);
}

export async function deliveries(limit = 15) {
  const summaries = await getClient().delivery.getDeliverySummaries();
  return summaries.slice(0, limit).map((d) => ({
    deliveryId: d.id,
    status: d.status,
    orderedAt: d.creationTime,
    start: d.windowStart,
    end: d.windowEnd,
    total: d.totalPrice,
    itemCount: d.itemCount,
  }));
}

export async function delivery(deliveryId: string) {
  const d = await getClient().delivery.getDelivery(deliveryId);
  return {
    deliveryId: d.id,
    status: d.status,
    orderedAt: d.creationTime,
    start: d.windowStart,
    end: d.windowEnd,
    total: d.totalPrice,
    items: d.orders.flatMap((order) => order.items).map(toCartItem),
  };
}
