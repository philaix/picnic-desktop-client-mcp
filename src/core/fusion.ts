import type PicnicClient from "picnic-api";
import { isFusionProductTile, readFusionProductTile } from "picnic-api/lib/domains/catalog/tiles.js";

// Picnic serves some pages as RSC in one country and as Fusion (a JSON component tree) in another.
// picnic-api reads search and categories only as RSC, which German accounts don't get, so these
// read the Fusion versions: links to other pages, and product tiles under their headings.

type ProductTile = PicnicClient.Types.catalog.ProductTile;
type Node = Record<string, any>;

export type FusionLink = { name: string; pageId: string; imageId: string | null };
export type FusionSection = { title: string | null; products: ProductTile[] };

export async function loadFusionPage(client: PicnicClient, pageId: string): Promise<unknown> {
  const loaded = (await client.app.getPage(pageId)) as { format?: string; page?: unknown };
  if (loaded.format !== "fusion") throw new Error(`Die Seite „${pageId}“ kam in einem unbekannten Format.`);
  return loaded.page;
}

/** `app.picnic://store/page;id=L2-category-page-root,category_id=19374` → `L2-category-page-root?category_id=19374`. */
export function pageIdFromTarget(target: string): string | null {
  const match = /\/page;id=([^,;]+)(?:,(.*))?$/.exec(target);
  if (!match) return null;
  const [, id, params] = match;
  return params ? `${id}?${params.split(",").join("&")}` : id;
}

const plainText = (markdown: string) => markdown.replace(/#\([^)]*\)/g, "").replace(/\*\*/g, "").trim();

function firstOf(node: unknown, test: (n: Node) => boolean): Node | null {
  if (!node || typeof node !== "object") return null;
  if (!Array.isArray(node) && test(node as Node)) return node as Node;
  for (const value of Object.values(node)) {
    const found = firstOf(value, test);
    if (found) return found;
  }
  return null;
}

/** The links to other pages, in page order, each page once. */
export function fusionLinks(page: unknown): FusionLink[] {
  const links = new Map<string, FusionLink>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Node;
    const target = n.type === "TOUCHABLE" ? n.onPress?.target : undefined;
    const pageId = typeof target === "string" ? pageIdFromTarget(target) : null;
    if (pageId && !links.has(pageId)) {
      const text = firstOf(n, (c) => c.type === "RICH_TEXT" && typeof c.markdown === "string");
      const name = (n.accessibilityLabel as string | undefined) ?? (text ? plainText(text.markdown) : "");
      const image = firstOf(n, (c) => c.type === "IMAGE" && typeof c.source?.id === "string");
      if (name) links.set(pageId, { name, pageId, imageId: image?.source.id ?? null });
      return;
    }
    for (const value of Object.values(n)) walk(value);
  };
  walk(page);
  return [...links.values()];
}

/**
 * Reads a product tile with its full name: German tiles split the name into colored parts
 * ("Bio" + "Fettarme H-Milch") and picnic-api keeps only the first. The tile's productName has it
 * whole; tiles without one have the selling unit's name, which starts with the brand.
 */
function readTile(node: Node): ProductTile | null {
  const tile = readFusionProductTile(node as never);
  if (!tile) return null;
  let fullName: string | undefined = firstOf(node, (c) => typeof c.productName === "string")?.productName;
  if (!fullName) {
    const unitName: string | undefined = firstOf(node, (c) => c.id === tile.id && typeof c.name === "string")?.name;
    fullName = unitName && tile.brand && unitName.startsWith(`${tile.brand} `) ? unitName.slice(tile.brand.length + 1) : unitName;
  }
  return fullName ? { ...tile, name: fullName, namePrefix: null } : tile;
}

/** The full product names on a page, for fixing tiles that picnic-api read itself (promotions, favorites). */
export function fusionProductNames(page: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (isFusionProductTile(node as never)) {
      const tile = readTile(node as Node);
      if (tile) names.set(tile.id, tile.name);
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(page);
  return names;
}

/** The product tiles grouped under the plain-text heading shown above them. */
export function fusionSections(page: unknown): FusionSection[] {
  const sections: FusionSection[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  let current: FusionSection | null = null;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Node;
    if (isFusionProductTile(n as never)) {
      const tile = readTile(n);
      if (tile && !seen.has(tile.id)) {
        seen.add(tile.id);
        if (!current || current.title !== heading) {
          current = { title: heading, products: [] };
          sections.push(current);
        }
        current.products.push(tile);
      }
      return;
    }
    if (n.type === "RICH_TEXT" && typeof n.markdown === "string") heading = plainText(n.markdown) || heading;
    for (const value of Object.values(n)) walk(value);
  };
  walk(page);
  return sections;
}
