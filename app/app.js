// Renderer of the desktop client. Talks to Picnic only through the main process (window.picnic.call).

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euro = (cents) => (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const dayFormat = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });
const shortDayFormat = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric" });
const timeFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
const timeRange = (start, end) => `${timeFormat.format(new Date(start))}–${timeFormat.format(new Date(end))} Uhr`;

const icons = {
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-9-9.5C2 6.9 4.4 4 7.5 4c2 0 3.5 1.1 4.5 2.6C13 5.1 14.5 4 16.5 4 19.6 4 22 6.9 21 10.5 19.5 15.4 12 20 12 20Z"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  pot: '<path d="M4 10h16v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-5Z"/><path d="M2 10h20M9 6c0-1 1-1.5 1-2.5M14 6c0-1 1-1.5 1-2.5"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const paintIcons = (root = document) => $$("[data-icon]", root).forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

const main = $("#main");
const cartEl = $("#cart");
const modal = $("#modal");
const state = {
  cart: null,
  quantities: new Map(),
  history: [],
  current: null,
  token: null,
  orderItems: [],
  copies: [],
  dishes: [],
  /** The dish being edited: { id, name, note, servings, macros, recipe, items }. */
  editor: null,
  editorResults: [],
  /** The product shown in the product modal, as a dish item. */
  modalProduct: null,
};

// ---------- Talking to the main process ----------

async function api(method, ...args) {
  const result = await window.picnic.call(method, ...args);
  if (!result.ok) {
    if (result.expired) showLogin(result.error);
    throw new Error(result.error);
  }
  return result.data;
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

// Cart changes run one after another, so quick clicks can't overwrite each other.
// Resolves to true when the task worked; on failure it shows the error and reloads the real cart.
let queue = Promise.resolve();
function cartTask(task) {
  const run = queue.then(task).then(
    (cart) => {
      if (cart) applyCart(cart);
      return true;
    },
    (error) => {
      toast(error.message, "error");
      return api("cart").then(applyCart, () => {}).then(() => false);
    },
  );
  queue = run;
  return run;
}

// ---------- Rendering helpers ----------

function viewHeader(title, subtitle = "") {
  const back = state.history.length ? `<button class="back" data-back>${icon("back")}Zurück</button>` : "";
  return `<header class="view-head">${back}<h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</header>`;
}

function priceHtml(p) {
  return `<span class="price">${euro(p.price)}</span>${p.originalPrice ? `<s>${euro(p.originalPrice)}</s>` : ""}`;
}

function stepper(productId, small = false) {
  const quantity = state.quantities.get(productId) ?? 0;
  const id = esc(productId);
  const inner =
    quantity === 0
      ? `<button class="add" data-inc="${id}" aria-label="In den Warenkorb">${icon("plus")}</button>`
      : `<button data-dec="${id}" aria-label="Eins weniger">${icon("minus")}</button><span class="qty">${quantity}</span><button data-inc="${id}" aria-label="Eins mehr">${icon("plus")}</button>`;
  return `<div class="stepper${quantity ? " has-qty" : ""}${small ? " small" : ""}" data-stepper="${id}" data-small="${small}">${inner}</div>`;
}

function tile(p) {
  const id = esc(p.id);
  const label = p.labels?.[0];
  const meta = [p.brand, p.quantity].filter(Boolean).join(", ");
  return `<article class="tile${p.unavailable ? " is-unavailable" : ""}">
    <button class="tile-open" data-product="${id}" aria-label="${esc(p.name)} ansehen">
      ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ""}
    </button>
    ${label ? `<span class="tag">${esc(label)}</span>` : ""}
    <div class="tile-body">
      <h3 class="tile-name"><button data-product="${id}">${esc(p.name)}</button></h3>
      ${meta ? `<p class="tile-meta">${esc(meta)}</p>` : ""}
      ${p.boughtBefore ? `<p class="tile-known">Schon mal gekauft</p>` : ""}
      <div class="tile-foot">
        <div class="tile-price">${priceHtml(p)}${p.unitPrice ? `<small>${esc(p.unitPrice)}</small>` : ""}</div>
        ${p.unavailable ? `<span class="soldout">Nicht lieferbar</span>` : stepper(p.id)}
      </div>
    </div>
  </article>`;
}

/** A product thumbnail on a white tile, zoomed past the wide margins of Picnic product photos. */
const thumb = (src, lazy = true) =>
  `<span class="thumb">${src ? `<img src="${esc(src)}" alt=""${lazy ? " loading=\"lazy\"" : ""}>` : ""}</span>`;

const grid = (products) =>
  products.length ? `<div class="grid">${products.map(tile).join("")}</div>` : `<p class="empty">Hier gibt es gerade keine Produkte.</p>`;

const section = (title, body, action = "") =>
  `<section class="section">${title || action ? `<div class="section-head"><h2>${esc(title ?? "")}</h2>${action}</div>` : ""}${body}</section>`;

function categoryTiles(entries) {
  const openable = entries.filter((entry) => entry.kind !== "page" && entry.categoryId);
  return `<div class="cat-grid">${openable
    .map(
      (entry) => `<button class="cat" data-cat="${esc(entry.categoryId)}" data-kind="${esc(entry.kind)}" data-title="${esc(entry.name)}">
        ${entry.image ? `<img src="${esc(entry.image)}" alt="" loading="lazy">` : ""}
        <strong>${esc(entry.name)}</strong>${entry.label ? `<small>${esc(entry.label)}</small>` : ""}
      </button>`,
    )
    .join("")}</div>`;
}

/** Picnic texts carry a little markdown and color markup; keep bold and line breaks, drop the rest. */
function richText(text) {
  return esc(text)
    .replace(/#\([^)]*\)/g, "")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** A small Markdown renderer for dish recipes: headings, lists, quotes, rules, bold, italic, code and https links. */
function markdown(source) {
  const inline = (text) =>
    esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const html = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const openList = (type) => {
    flushParagraph();
    if (list !== type) {
      closeList();
      html.push(`<${type}>`);
      list = type;
    }
  };
  for (const line of String(source ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    let match;
    if (!line.trim()) {
      flushParagraph();
      closeList();
    } else if ((match = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flushParagraph();
      closeList();
      const level = match[1].length + 2;
      html.push(`<h${level}>${inline(match[2])}</h${level}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr>");
    } else if ((match = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      openList("ul");
      html.push(`<li>${inline(match[1])}</li>`);
    } else if ((match = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      openList("ol");
      html.push(`<li>${inline(match[1])}</li>`);
    } else if ((match = /^>\s?(.*)$/.exec(line))) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(match[1])}</blockquote>`);
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html.join("");
}

const number = (value) => Number(value).toLocaleString("de-DE", { maximumFractionDigits: 1 });
const macroFields = [
  ["kcal", "kcal", ""],
  ["protein", "Eiweiß", " g"],
  ["carbs", "Kohlenhydrate", " g"],
  ["fat", "Fett", " g"],
];

function macroStrip(dish) {
  const cells = macroFields
    .filter(([key]) => dish.macros?.[key] != null)
    .map(([key, label, unit]) => `<div><strong>${number(dish.macros[key])}${unit}</strong><span>${label}</span></div>`);
  return cells.length ? `<div class="macros">${cells.join("")}<small>pro Portion</small></div>` : "";
}

const dishPrice = (dish) => dish.items.reduce((sum, item) => sum + item.price * item.count, 0);

function dishMeta(dish) {
  const parts = [`${dish.items.length} Produkte`, `etwa ${euro(dishPrice(dish))}`];
  if (dish.servings) parts.push(`${dish.servings} ${dish.servings === 1 ? "Portion" : "Portionen"}`);
  return parts.join(", ");
}

const deliveryStatus = { CURRENT: "Geplant", COMPLETED: "Geliefert", CANCELLED: "Storniert" };

// ---------- Views ----------

const views = {
  async promotions() {
    const sections = await api("promotions");
    if (!sections.length) return viewHeader("Angebote") + `<p class="empty">Gerade gibt es keine Angebote.</p>`;
    return (
      viewHeader("Angebote", "Die Aktionen dieser Woche") +
      sections
        .map((s) => {
          const deals = s.groups.length
            ? `<div class="deals">${s.groups
                .map(
                  (g) => `<button class="deal" data-group="${esc(g.id)}" data-title="${esc(g.name)}">
                    <strong>${esc(g.label ?? g.name)}</strong><span>${esc(g.label ? g.name : (g.example ?? ""))}</span>
                  </button>`,
                )
                .join("")}</div>`
            : "";
          return section(s.title, deals + (s.products.length ? grid(s.products) : ""));
        })
        .join("")
    );
  },

  async group({ id, title }) {
    const group = await api("promotionGroup", id);
    return viewHeader(title || group.title, `${group.products.length} Produkte in dieser Aktion`) + grid(group.products);
  },

  async categories() {
    const sections = await api("categories");
    return (
      viewHeader("Kategorien") +
      sections
        .filter((s) => s.entries.some((e) => e.kind !== "page"))
        .map((s) => section(s.title, categoryTiles(s.entries)))
        .join("")
    );
  },

  async category({ id, kind, title }) {
    const page = await api("openCategory", id, kind);
    const head = viewHeader(page.title || title);
    if (page.kind === "subcategories") {
      const openable = page.entries.filter((e) => e.kind !== "page" && e.categoryId);
      // Subcategories with pictures get tiles; plain ones (as German pages send them) get chips.
      if (openable.some((e) => e.image)) return head + categoryTiles(openable);
      if (!openable.length) return head + `<p class="empty">Diese Kategorie ist gerade leer.</p>`;
      return (
        head +
        `<div class="chips">${openable
          .map((e) => `<button class="chip" data-cat="${esc(e.categoryId)}" data-kind="${esc(e.kind)}" data-title="${esc(e.name)}">${esc(e.name)}</button>`)
          .join("")}</div>`
      );
    }
    if (!page.sections.length) return head + `<p class="empty">In dieser Kategorie gibt es gerade keine Produkte.</p>`;
    return head + page.sections.map((s) => section(s.title, grid(s.products))).join("");
  },

  async favorites() {
    const aisles = await api("favorites");
    if (!aisles.length) {
      return viewHeader("Meine Produkte") + `<p class="empty">Hier erscheinen die Produkte, die du regelmäßig kaufst – sobald du ein paar Mal bestellt hast.</p>`;
    }
    return (
      viewHeader("Meine Produkte", "Was du regelmäßig kaufst, sortiert nach Gang") +
      aisles
        .map((a) =>
          section(
            a.title,
            grid(a.products),
            a.complete ? "" : `<button class="link" data-aisle="${esc(a.id)}" data-title="${esc(a.title)}">Alle anzeigen</button>`,
          ),
        )
        .join("")
    );
  },

  async dishes() {
    state.dishes = await api("dishes");
    const head = viewHeader("Meine Gerichte", "Deine eigenen Zusammenstellungen. Ein Klick legt alle Produkte in den Warenkorb.");
    const actions = `<div class="dish-actions">
      <button class="primary" data-dish-new>Neues Gericht</button>
      ${state.cart?.items.length ? `<button class="secondary" data-dish-from-cart>Warenkorb als Gericht speichern</button>` : ""}
    </div>`;
    if (!state.dishes.length) {
      return head + actions + `<p class="empty">Noch keine Gerichte. Leg eins an, oder füll den Warenkorb und speichere ihn als Gericht.</p>`;
    }
    return (
      head +
      actions +
      `<div class="dishes">${state.dishes
        .map(
          (dish) => `<article class="dish">
            <button class="dish-open" data-dish-open="${esc(dish.id)}">
              <span class="dish-thumbs">${dish.items
                .slice(0, 6)
                .map((item) => thumb(item.image))
                .join("")}</span>
              <h2>${esc(dish.name)}</h2>
              ${dish.note ? `<span class="dish-note">${esc(dish.note)}</span>` : ""}
              <span class="dish-meta">${esc(dishMeta(dish))}${dish.recipe ? ", mit Rezept" : ""}</span>
            </button>
            ${macroStrip(dish)}
            <div class="dish-buttons">
              <button class="primary" data-dish-cart="${esc(dish.id)}">In den Warenkorb</button>
              <button class="secondary" data-dish-edit="${esc(dish.id)}">Bearbeiten</button>
            </div>
          </article>`,
        )
        .join("")}</div>`
    );
  },

  async aisle({ id, title }) {
    const products = await api("favoritesAisle", id);
    return viewHeader(title, `${products.length} Produkte`) + grid(products);
  },

  async search({ query }) {
    const result = await api("search", query, 80);
    const subtitle = result.correctedQuery
      ? `Gesucht wurde nach „${result.correctedQuery}“`
      : `${result.products.length} Produkte`;
    if (!result.products.length) {
      return viewHeader(`Ergebnisse für „${query}“`) + `<p class="empty">Nichts gefunden. Versuch es mit einem allgemeineren Begriff, z. B. „Joghurt“ statt einer Marke.</p>`;
    }
    return viewHeader(`Ergebnisse für „${query}“`, subtitle) + grid(result.products);
  },

  async orders() {
    const list = await api("deliveries", 40);
    if (!list.length) return viewHeader("Bestellungen") + `<p class="empty">Noch keine Bestellungen.</p>`;
    return (
      viewHeader("Bestellungen") +
      `<div class="orders">${list
        .map((d) => {
          const when = d.start ? dateFormat.format(new Date(d.start)) : dateFormat.format(new Date(d.orderedAt));
          return `<button class="order-row" data-order="${esc(d.deliveryId)}">
            <strong>${esc(when)}</strong>
            <span class="status ${d.status === "CURRENT" ? "current" : ""}">${esc(deliveryStatus[d.status] ?? d.status)}</span>
            <span>${d.itemCount} Artikel</span>
            <span class="price">${euro(d.total)}</span>
          </button>`;
        })
        .join("")}</div>`
    );
  },

  async order({ id }) {
    const d = await api("delivery", id);
    state.orderItems = d.items.filter((item) => !item.unavailable);
    const when = d.start ? `${dateFormat.format(new Date(d.start))}, ${timeRange(d.start, d.end)}` : "";
    const products = d.items.map((item) => ({
      id: item.productId,
      name: item.name,
      brand: null,
      quantity: `${item.quantity} × ${item.unitQuantity}`,
      price: item.price,
      originalPrice: item.originalPrice,
      unitPrice: null,
      labels: [],
      unavailable: false,
      image: item.image,
    }));
    return (
      viewHeader(`Bestellung vom ${d.start ? shortDayFormat.format(new Date(d.start)) : ""}`, `${when} – ${euro(d.total)}`) +
      `<p><button class="primary" data-reorder>Alles erneut in den Warenkorb</button></p>` +
      section("Produkte", grid(products))
    );
  },

  async claude() {
    const [setup, settings] = await Promise.all([api("claudeSetup"), api("settings")]);
    state.copies = [setup.claudeCodeCommand, setup.desktopJson];
    return (
      viewHeader("Mit Claude verbinden", "Dann kann Claude für dich Produkte suchen und den Warenkorb füllen. Bestellen tust du weiterhin selbst.") +
      (setup.warning ? `<p class="note panel">${esc(setup.warning)}</p>` : "") +
      `<section class="panel">
        <h2>Verbinden</h2>
        <p>Trägt den Picnic-Zugang in Claude ein: in den Chat von Claude Desktop und in Claude Code, das der Code-Tab der Desktop-App und das Terminal nutzen.</p>
        <ul class="connect-status">
          <li class="${setup.inDesktop ? "ok" : ""}"><strong>Claude Desktop, Chat:</strong> ${setup.inDesktop ? "eingetragen" : "noch nicht eingetragen"}</li>
          <li class="${setup.inCode ? "ok" : ""}"><strong>Claude Code, Code-Tab und Terminal:</strong> ${
            setup.inCode ? "eingetragen" : setup.claudeCodeFound ? "noch nicht eingetragen" : "Claude Code ist nicht installiert, der Chat reicht aber"
          }</li>
        </ul>
        <button class="primary" data-connect-claude>${setup.inDesktop && (setup.inCode || !setup.claudeCodeFound) ? "Erneut verbinden" : "Mit Claude verbinden"}</button>
      </section>
      <section class="panel">
        <h2>Bestellen durch Claude</h2>
        <p>Claude kann den Warenkorb immer füllen. Bestellungen auslösen darf Claude nur, wenn du es hier erlaubst. Vorher zeigt Claude dir Summe und Lieferfenster und fragt nach, und die Zahlung bestätigst du selbst auf der Zahlungsseite.</p>
        <label class="toggle"><input type="checkbox" data-setting="claudeMayOrder"${settings.claudeMayOrder ? " checked" : ""}> Claude darf Bestellungen auslösen</label>
        <label class="field limit-field">Höchstbetrag pro Bestellung in Euro<input type="number" min="1" step="1" data-setting="claudeOrderLimit" value="${Math.round(settings.claudeOrderLimit / 100)}"></label>
      </section>
      <section class="panel">
        <h2>Danach</h2>
        <ul class="examples">
          <li><strong>Chat:</strong> Claude Desktop ganz beenden, auch im Tray bzw. in der Menüleiste, und neu starten. Den Picnic-Zugang findest du dann über das „+“ unten links im Eingabefeld → Konnektoren → „Konnektoren verwalten“.</li>
          <li><strong>Code-Tab:</strong> eine neue Session starten. Laufende Sessions sehen den Zugang erst nach einem Neustart.</li>
        </ul>
      </section>
      <details class="panel">
        <summary>Von Hand einrichten</summary>
        <p>Claude Code im Terminal:</p>
        <pre>${esc(setup.claudeCodeCommand)}</pre>
        <button class="secondary" data-copy="0">Befehl kopieren</button>
        <p>Claude Desktop oder andere MCP-Programme: diesen Eintrag in die Server-Liste übernehmen.</p>
        <pre>${esc(setup.desktopJson)}</pre>
        <button class="secondary" data-copy="1">JSON kopieren</button>
      </details>
      <section class="panel">
        <h2>Das kannst du Claude dann sagen</h2>
        <ul class="examples">
          <li>„Pack mir alles für Spaghetti Bolognese für vier Personen in den Picnic-Warenkorb.“</li>
          <li>„Speichere den Warenkorb als Gericht ‚Bolognese‘, trag die Makros pro Portion ein und schreib ein kurzes Rezept dazu.“</li>
          <li>„Leg mein Gericht Bolognese zweimal in den Warenkorb.“</li>
          <li>„Leg meine letzte Bestellung nochmal in den Warenkorb, aber ohne Getränke.“</li>
          <li>„Welche Angebote gibt es diese Woche bei Milchprodukten?“</li>
          <li>„Such mir ein Lieferfenster am Freitagabend aus.“</li>
          <li>„Bestell den Warenkorb.“ (wenn oben erlaubt)</li>
        </ul>
      </section>`
    );
  },
};

const navRoot = { group: "promotions", category: "categories", aisle: "favorites", order: "orders" };

/** Shows a view. Top-level navigation passes `reset`; going back passes `push: false`. */
async function go(view, params = {}, { push = true, reset = false } = {}) {
  if (reset) state.history = [];
  else if (push && state.current) state.history.push(state.current);
  state.current = { view, params };
  const root = navRoot[view] ?? view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.nav === root));
  const token = Symbol(view);
  state.token = token;
  main.innerHTML = `<p class="loading">Lädt …</p>`;
  main.scrollTop = 0;
  try {
    const html = await views[view](params);
    if (state.token === token) main.innerHTML = html;
  } catch (error) {
    if (state.token === token) main.innerHTML = viewHeader("Das hat nicht geklappt") + `<p class="error-block">${esc(error.message)}</p>`;
  }
}

function back() {
  const previous = state.history.pop();
  if (previous) go(previous.view, previous.params, { push: false });
}

// ---------- Cart ----------

function applyCart(cart) {
  state.cart = cart;
  state.quantities = new Map();
  for (const item of cart.items) state.quantities.set(item.productId, (state.quantities.get(item.productId) ?? 0) + item.quantity);
  renderCart();
  refreshSteppers();
}

function refreshSteppers(onlyId) {
  $$("[data-stepper]").forEach((el) => {
    if (onlyId && el.dataset.stepper !== onlyId) return;
    el.outerHTML = stepper(el.dataset.stepper, el.dataset.small === "true");
  });
}

function slotLabel(slot) {
  if (!slot?.start) return { small: "Lieferung", text: "Lieferfenster wählen" };
  const text = `${shortDayFormat.format(new Date(slot.start))}, ${timeRange(slot.start, slot.end)}`;
  return { small: slot.chosenByUser ? "Lieferung" : "Vorgeschlagene Lieferung", text };
}

function renderCart() {
  const cart = state.cart;
  if (!cart) {
    cartEl.innerHTML = `<div class="receipt-head"><h2>Warenkorb</h2></div><p class="cart-empty">Lädt …</p>`;
    return;
  }
  const slot = slotLabel(cart.slot);
  const lines = cart.items.length
    ? `<ul class="lines">${cart.items
        .map(
          (item) => `<li class="line">
            ${thumb(item.image, false)}
            <div>
              <button class="line-name" data-product="${esc(item.productId)}">${esc(item.name)}</button>
              <span class="line-sub">${esc(item.unitQuantity)}</span>
              ${item.unavailable ? `<span class="line-warn">${esc(item.unavailableReason ?? "Nicht lieferbar")}</span>` : ""}
            </div>
            <div class="line-side">
              <span class="line-price">${euro(item.price)}</span>
              ${stepper(item.productId, true)}
            </div>
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="cart-empty">Noch leer. Leg Produkte hinein – oder bitte Claude, deinen Einkaufszettel abzuarbeiten.</p>`;

  const rows = [];
  if (cart.discount > 0) rows.push(`<div><span>Rabatt</span><span>−${euro(cart.discount)}</span></div>`);
  if (cart.depositTotal > 0) rows.push(`<div><span>Pfand</span><span>${euro(cart.depositTotal)}</span></div>`);
  for (const fee of cart.fees) rows.push(`<div><span>${esc(fee.name)}</span><span>${euro(fee.amount)}</span></div>`);

  const missing = cart.minimumOrderValue ? cart.minimumOrderValue - cart.total : 0;
  const mov =
    cart.items.length && missing > 0
      ? `<div class="mov"><progress max="${cart.minimumOrderValue}" value="${cart.total}"></progress>Noch ${euro(missing)} bis zum Mindestbestellwert von ${euro(cart.minimumOrderValue)}</div>`
      : "";

  cartEl.innerHTML = `
    <div class="receipt-head"><h2>Warenkorb</h2><span>${cart.totalCount} Artikel</span></div>
    <button class="slot-btn" data-slots>
      <small>${esc(slot.small)}</small><strong>${esc(slot.text)}</strong><span class="change">Lieferfenster ändern</span>
    </button>
    <hr class="rule">
    ${lines}
    <hr class="rule">
    <div class="totals">${rows.join("")}<div class="sum"><span>Summe</span><strong>${euro(cart.total)}</strong></div></div>
    ${mov}
    <div class="receipt-foot">
      ${cart.items.length ? `<button class="primary order-btn" data-checkout${missing > 0 ? " disabled" : ""}>Bestellen</button>` : ""}
      <p>${
        !cart.items.length
          ? "Bestellen kannst du hier oder wie gewohnt in der Picnic-App."
          : missing > 0
            ? "Bestellen geht ab dem Mindestbestellwert."
            : "Oder wie gewohnt in der Picnic-App, der Warenkorb ist dort schon gefüllt."
      }</p>
      ${
        cart.items.length
          ? `<div class="receipt-links"><button class="link" data-dish-save-cart>Als Gericht speichern</button><button class="link danger" data-clear>Warenkorb leeren</button></div>`
          : ""
      }
    </div>`;
}

function changeQuantity(productId, delta) {
  const next = Math.max(0, (state.quantities.get(productId) ?? 0) + delta);
  state.quantities.set(productId, next);
  refreshSteppers(productId);
  cartTask(async () => {
    if (delta > 0) {
      const result = await api("addToCart", [{ productId, count: delta }]);
      if (result.failed.length) toast(result.failed[0].error, "error");
      return result.cart;
    }
    return api("setQuantity", productId, next);
  });
}

// ---------- Modals ----------

function openModal(html, narrow = false) {
  $(".modal-card", modal).classList.toggle("narrow", narrow);
  $(".modal-body", modal).innerHTML = html;
  modal.hidden = false;
  $(".modal-card", modal).scrollTop = 0;
}

function closeModal() {
  modal.hidden = true;
  $(".modal-body", modal).innerHTML = "";
}

async function openProduct(id) {
  openModal(`<p class="loading">Lädt …</p>`);
  try {
    const p = await api("product", id);
    state.modalProduct = { productId: p.id, name: p.name, unitQuantity: p.quantity, image: p.image, price: p.price, count: 1 };
    const tags = [
      ...(p.promotion ? [`<span class="promo">${esc(p.promotion)}</span>`] : []),
      ...[...p.labels, ...p.tags].filter((t) => t && t !== p.promotion).map((t) => `<span>${esc(t)}</span>`),
    ];
    const allergens = [
      p.allergens.contains.length ? `<p><strong>Enthält:</strong> ${esc(p.allergens.contains.join(", "))}</p>` : "",
      p.allergens.mayContain.length ? `<p><strong>Kann enthalten:</strong> ${esc(p.allergens.mayContain.join(", "))}</p>` : "",
    ].join("");
    const nutrition = p.nutrition.length
      ? `<details><summary>Nährwerte</summary><div><table class="nutrition">${p.nutrition
          .map((row) => `<tr class="${row.isCategory ? "" : "sub"}"><td>${esc(row.label)}</td><td>${esc(row.value ?? "")}</td></tr>`)
          .join("")}</table></div></details>`
      : "";
    const info = p.info
      .filter((s) => s.content && !/^(Nährwerte|Voedingswaarde)/i.test(s.title))
      .map((s) => `<details><summary>${esc(s.title)}</summary><div>${richText(s.content)}</div></details>`)
      .join("");
    const similar = p.similar.length
      ? `<div class="similar"><h3>Ähnliche Produkte</h3>${grid(
          p.similar.slice(0, 8).map((s) => ({ ...s, brand: null, originalPrice: null, unitPrice: null, labels: [], unavailable: false })),
        )}</div>`
      : "";
    openModal(`
      <div class="pd">
        <div>
          ${p.images[0] ? `<img class="pd-main" src="${esc(p.images[0])}" alt="">` : ""}
          ${p.images.length > 1 ? `<div class="pd-thumbs">${p.images.map((src) => `<button data-img="${esc(src)}"><img src="${esc(src)}" alt=""></button>`).join("")}</div>` : ""}
        </div>
        <div>
          ${p.brand ? `<p class="pd-brand">${esc(p.brand)}</p>` : ""}
          <h2>${esc(p.name)}</h2>
          <p class="pd-meta">${esc([p.quantity, p.unitPrice].filter(Boolean).join(", "))}</p>
          ${tags.length ? `<div class="pd-tags">${tags.join("")}</div>` : ""}
          <div class="pd-buy"><div class="pd-price">${priceHtml(p)}</div>${stepper(p.id)}</div>
          <div class="pd-dish" id="pd-dish"><button class="link" data-to-dish>Zu einem Gericht hinzufügen</button></div>
          <div class="pd-text">
            ${p.highlights.length ? `<ul class="pd-highlights">${p.highlights.map((h) => `<li>${richText(h).replace(/<\/?p>/g, "")}</li>`).join("")}</ul>` : ""}
            ${p.description ? richText(p.description) : ""}
            ${allergens}
          </div>
          ${info}${nutrition}
        </div>
      </div>
      ${similar}`);
  } catch (error) {
    openModal(`<p class="error-block">${esc(error.message)}</p>`, true);
  }
}

async function openSlots() {
  openModal(`<p class="loading">Lädt …</p>`, true);
  try {
    const { slots } = await api("deliverySlots");
    const available = slots.filter((slot) => slot.available);
    const days = new Map();
    for (const slot of available) {
      const day = dayFormat.format(new Date(slot.start));
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(slot);
    }
    const body = available.length
      ? [...days]
          .map(
            ([day, list]) => `<div class="slot-day"><h3>${esc(day)}</h3><div class="slot-list">${list
              .map(
                (slot) => `<button class="slot${slot.selected ? " is-selected" : ""}" data-slot="${esc(slot.slotId)}">
                  <strong>${timeFormat.format(new Date(slot.start))}–${timeFormat.format(new Date(slot.end))}</strong>
                  <small>bestellen bis ${esc(shortDayFormat.format(new Date(slot.orderBefore)))}, ${timeFormat.format(new Date(slot.orderBefore))}</small>
                  ${slot.minimumOrderValue ? `<small>ab ${euro(slot.minimumOrderValue)}</small>` : ""}
                  ${slot.greenChoice ? `<small class="green">Grüne Wahl</small>` : ""}
                </button>`,
              )
              .join("")}</div></div>`,
          )
          .join("")
      : `<p class="empty">Gerade sind keine Lieferfenster frei.</p>`;
    openModal(`<div class="slots"><h2>Lieferfenster wählen</h2><p>„Grüne Wahl“ sind Fenster, in denen Picnic ohnehin in deiner Nähe liefert.</p>${body}</div>`, true);
  } catch (error) {
    openModal(`<p class="error-block">${esc(error.message)}</p>`, true);
  }
}

// ---------- Checkout ----------

/** The payment in progress; polling stops when it is cleared. */
const payment = { transactionId: null, paymentUrl: null, expiresAt: null, timer: null };

function checkoutModal(html) {
  openModal(`<div class="checkout">${html}</div>`, true);
}

async function openCheckout() {
  checkoutModal(`<p class="loading">Lädt …</p>`);
  try {
    const summary = await api("orderSummary");
    state.orderConfirmation = summary.confirmation;
    const slot = summary.slot?.start
      ? `${shortDayFormat.format(new Date(summary.slot.start))}, ${timeRange(summary.slot.start, summary.slot.end)}`
      : "noch keins gewählt";
    checkoutModal(`
      <h2>Bestellung prüfen</h2>
      <dl class="checkout-facts">
        <div><dt>Artikel</dt><dd>${summary.itemCount}</dd></div>
        <div><dt>Lieferung</dt><dd>${esc(slot)} <button class="link" data-slots>ändern</button>${
          summary.slot?.suggested ? `<small class="fact-note">Von Picnic vorgeschlagen, wird mit der Bestellung bestätigt.</small>` : ""
        }</dd></div>
        <div><dt>Bezahlung</dt><dd>${esc(summary.paymentMethod ?? "deine bei Picnic hinterlegte Zahlungsart")}</dd></div>
      </dl>
      ${summary.unavailable.length ? `<p class="note">Nicht lieferbar, wird weggelassen: ${esc(summary.unavailable.join(", "))}</p>` : ""}
      ${summary.problems.length ? `<ul class="checkout-problems">${summary.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      <div class="checkout-total"><span>Gesamt</span><strong>${euro(summary.total)}</strong></div>
      <button class="primary order-now" data-place-order${summary.ready ? "" : " disabled"}>Zahlungspflichtig bestellen</button>
      <p class="hint">Danach öffnet sich die Zahlungsseite im Browser, zum Beispiel PayPal. Dort bestätigst du die Zahlung.</p>`);
  } catch (error) {
    checkoutModal(`<p class="error-block">${esc(error.message)}</p>`);
  }
}

async function placeOrder(resolveKey) {
  checkoutModal(`<h2>Bestellung wird angelegt</h2><p class="checkout-wait"><span class="spinner"></span>Einen Moment …</p>`);
  try {
    const result = await api("placeOrder", state.orderConfirmation, resolveKey);
    if (result.status === "issue") {
      const { issue } = result;
      return checkoutModal(`
        <h2>${esc(issue.title || "Bitte bestätigen")}</h2>
        <p>${esc(issue.message)}</p>
        <div class="dish-buttons">
          ${!issue.blocking && issue.resolveKey ? `<button class="primary" data-resolve-issue="${esc(issue.resolveKey)}">Bestätigen und weiter</button>` : ""}
          <button class="secondary" data-close>Abbrechen</button>
        </div>`);
    }
    Object.assign(payment, { transactionId: result.transactionId, paymentUrl: result.paymentUrl, expiresAt: result.expiresAt });
    if (result.paymentUrl) api("openPaymentPage", result.paymentUrl).catch((error) => toast(error.message, "error"));
    checkoutModal(`
      <h2>Zahlung bestätigen</h2>
      <p>${result.paymentUrl ? "Im Browser ist die Zahlungsseite offen. Bestätige dort die Zahlung, danach geht es hier von allein weiter." : "Picnic verarbeitet die Zahlung."}</p>
      <div class="checkout-total"><span>Betrag</span><strong>${euro(result.total)}</strong></div>
      <p class="checkout-wait"><span class="spinner"></span>Warte auf die Bestätigung von Picnic …</p>
      <div class="dish-buttons">
        ${result.paymentUrl ? `<button class="secondary" data-open-payment>Zahlungsseite erneut öffnen</button>` : ""}
        <button class="link danger" data-cancel-payment>Bestellung abbrechen</button>
      </div>`);
    pollPayment();
  } catch (error) {
    checkoutModal(`<h2>Das hat nicht geklappt</h2><p class="error-block">${esc(error.message)}</p><button class="secondary" data-checkout>Erneut prüfen</button>`);
  }
}

function pollPayment() {
  clearTimeout(payment.timer);
  const transactionId = payment.transactionId;
  if (!transactionId) return;
  payment.timer = setTimeout(async () => {
    if (payment.transactionId !== transactionId) return;
    if (payment.expiresAt && Date.now() > Date.parse(payment.expiresAt) + 60_000) {
      payment.transactionId = null;
      return checkoutModal(`<h2>Zeit abgelaufen</h2><p>Die Zahlung wurde nicht rechtzeitig bestätigt. Der Warenkorb ist unverändert, du kannst es erneut versuchen.</p><button class="secondary" data-checkout>Erneut prüfen</button>`);
    }
    try {
      const status = await api("orderStatus", transactionId);
      if (payment.transactionId !== transactionId) return;
      if (status.state === "placed") return finishOrder();
      if (status.state === "failed") {
        payment.transactionId = null;
        return checkoutModal(`<h2>Nicht bezahlt</h2><p>Die Zahlung wurde nicht abgeschlossen (${esc(status.detail)}). Es wurde nichts bestellt.</p><button class="secondary" data-checkout>Erneut prüfen</button>`);
      }
    } catch {
      // A failed status check is retried on the next round.
    }
    pollPayment();
  }, 3000);
}

async function finishOrder() {
  payment.transactionId = null;
  cartTask(() => api("cart"));
  const [latest] = await api("deliveries", 1).catch(() => []);
  const when = latest?.start ? `${dateFormat.format(new Date(latest.start))}, ${timeRange(latest.start, latest.end)}` : null;
  checkoutModal(`
    <h2>Bestellt</h2>
    <p>${when ? `Picnic liefert ${esc(when)}.` : "Picnic hat die Bestellung angenommen."}</p>
    <button class="primary" data-nav="orders">Zu meinen Bestellungen</button>`);
  toast("Bestellung abgeschlossen");
}

async function cancelPayment() {
  const transactionId = payment.transactionId;
  payment.transactionId = null;
  clearTimeout(payment.timer);
  if (!transactionId) return closeModal();
  try {
    await api("cancelPayment", transactionId);
    toast("Bestellung abgebrochen, es wurde nichts bestellt");
  } catch (error) {
    toast(error.message, "error");
  }
  closeModal();
}

// ---------- Dishes ----------

async function loadDishes() {
  state.dishes = await api("dishes");
  return state.dishes;
}

const findDish = (id) => state.dishes.find((dish) => dish.id === id);

function refreshDishesView() {
  if (state.current?.view === "dishes") go("dishes", {}, { push: false });
}

function openDish(id) {
  const dish = findDish(id);
  if (!dish) return;
  const lines = dish.items
    .map(
      (item) => `<li class="dish-line">
        ${thumb(item.image)}
        <div><button class="line-name" data-product="${esc(item.productId)}">${esc(item.name)}</button><span class="line-sub">${item.count} × ${esc(item.unitQuantity)}</span></div>
        <span class="line-price">${euro(item.price * item.count)}</span>
      </li>`,
    )
    .join("");
  openModal(`
    <div class="dish-detail">
      <h2>${esc(dish.name)}</h2>
      ${dish.note ? `<p class="dish-note">${esc(dish.note)}</p>` : ""}
      <p class="dish-meta">${esc(dishMeta(dish))}</p>
      ${macroStrip(dish)}
      <div class="dish-buttons">
        <button class="primary" data-dish-cart="${esc(dish.id)}">In den Warenkorb</button>
        <button class="secondary" data-dish-edit="${esc(dish.id)}">Bearbeiten</button>
      </div>
      <div class="dish-detail-grid">
        <section><h3>Produkte</h3><ul class="dish-lines">${lines}</ul></section>
        <section class="recipe">
          <h3>Rezept</h3>
          ${dish.recipe ? `<div class="markdown">${markdown(dish.recipe)}</div>` : `<p class="empty">Noch kein Rezept. Unter „Bearbeiten“ kannst du eins eintragen.</p>`}
        </section>
      </div>
    </div>`);
}

function openDishEditor(dish) {
  state.editor = dish
    ? structuredClone(dish)
    : { id: null, name: "", note: "", servings: null, macros: null, recipe: "", items: [] };
  state.editorResults = [];
  const e = state.editor;
  openModal(`
    <form class="dish-editor" id="dish-form">
      <h2>${e.id ? "Gericht bearbeiten" : "Neues Gericht"}</h2>
      <div class="field-row">
        <label class="field grow">Name<input name="name" placeholder="z. B. Spaghetti Bolognese" required></label>
        <label class="field narrow">Portionen<input name="servings" type="number" min="1" max="50" step="1"></label>
      </div>
      <label class="field">Notiz<input name="note" placeholder="z. B. schnell, für unter der Woche"></label>
      <fieldset class="macro-fields">
        <legend>Makros pro Portion, optional</legend>
        ${macroFields.map(([key, label, unit]) => `<label class="field">${label}${unit ? ` (${unit.trim()})` : ""}<input name="${key}" type="number" min="0" step="any"></label>`).join("")}
      </fieldset>
      <h3>Produkte</h3>
      <ul class="dish-lines" id="dish-lines"></ul>
      <div class="dish-search">
        <input type="search" id="dish-search" placeholder="Produkt suchen, z. B. Spaghetti" autocomplete="off">
        <button type="button" class="secondary" data-ed-search>Suchen</button>
      </div>
      <ul class="dish-results" id="dish-results"></ul>
      <div class="recipe-field">
        <div class="recipe-head">
          <h3>Rezept, optional</h3>
          <div class="tabs">
            <button type="button" class="tab is-active" data-recipe-tab="write">Schreiben</button>
            <button type="button" class="tab" data-recipe-tab="preview">Vorschau</button>
          </div>
        </div>
        <textarea name="recipe" rows="10" placeholder="## Zubereitung&#10;1. Zwiebeln würfeln und anschwitzen&#10;2. Hackfleisch dazugeben&#10;&#10;**Tipp:** Mit Parmesan servieren."></textarea>
        <div class="markdown recipe-preview" hidden></div>
        <small class="hint">Markdown: # Überschrift, **fett**, *kursiv*, - Liste, 1. Schritt</small>
      </div>
      <p class="form-error" hidden></p>
      <div class="dish-editor-foot">
        <button class="primary" type="submit">Gericht speichern</button>
        ${e.id ? `<button type="button" class="link danger" data-ed-delete>Gericht löschen</button>` : ""}
      </div>
    </form>`);
  const form = $("#dish-form");
  $("[name=name]", form).value = e.name;
  $("[name=note]", form).value = e.note ?? "";
  $("[name=servings]", form).value = e.servings ?? "";
  $("[name=recipe]", form).value = e.recipe ?? "";
  for (const [key] of macroFields) $(`[name=${key}]`, form).value = e.macros?.[key] ?? "";
  renderEditorLines();
  $("[name=name]", form).focus();
}

function renderEditorLines() {
  const list = $("#dish-lines");
  if (!list) return;
  const items = state.editor.items;
  list.innerHTML = items.length
    ? items
        .map(
          (item, index) => `<li class="dish-line">
            ${thumb(item.image)}
            <div><span class="line-name">${esc(item.name)}</span><span class="line-sub">${esc(item.unitQuantity)}, ${euro(item.price)}</span></div>
            <div class="stepper small has-qty">
              <button type="button" data-ed-dec="${index}" aria-label="Eins weniger">${icon("minus")}</button>
              <span class="qty">${item.count}</span>
              <button type="button" data-ed-inc="${index}" aria-label="Eins mehr">${icon("plus")}</button>
            </div>
          </li>`,
        )
        .join("")
    : `<li class="empty-line">Noch keine Produkte. Such unten nach Produkten und füg sie hinzu.</li>`;
}

function renderEditorResults() {
  const list = $("#dish-results");
  if (!list) return;
  list.innerHTML = state.editorResults
    .map((p, index) => {
      const inDish = state.editor.items.find((item) => item.productId === p.id)?.count ?? 0;
      return `<li class="dish-line">
        ${thumb(p.image)}
        <div><span class="line-name">${esc(p.name)}</span><span class="line-sub">${esc([p.brand, p.quantity].filter(Boolean).join(", "))}, ${euro(p.price)}</span></div>
        <button type="button" class="secondary small-btn" data-ed-add="${index}">${inDish ? `Noch einmal (${inDish})` : "Hinzufügen"}</button>
      </li>`;
    })
    .join("");
}

function addToEditor(product) {
  const known = state.editor.items.find((item) => item.productId === product.productId);
  if (known) known.count += 1;
  else state.editor.items.push({ ...product, count: 1 });
  renderEditorLines();
  renderEditorResults();
}

async function runEditorSearch() {
  const query = $("#dish-search").value.trim();
  if (!query) return;
  $("#dish-results").innerHTML = `<li class="empty-line">Sucht …</li>`;
  try {
    state.editorResults = (await api("search", query, 12)).products.filter((p) => !p.unavailable);
    renderEditorResults();
    if (!state.editorResults.length) $("#dish-results").innerHTML = `<li class="empty-line">Nichts gefunden.</li>`;
  } catch (error) {
    $("#dish-results").innerHTML = `<li class="empty-line">${esc(error.message)}</li>`;
  }
}

async function saveEditor(form) {
  const value = (name) => $(`[name=${name}]`, form).value;
  const dish = {
    id: state.editor.id,
    name: value("name"),
    note: value("note"),
    servings: value("servings") || null,
    macros: Object.fromEntries(macroFields.map(([key]) => [key, value(key) === "" ? null : value(key)])),
    recipe: value("recipe"),
    items: state.editor.items,
  };
  const saved = await api("saveDish", dish);
  closeModal();
  toast(`„${saved.name}“ gespeichert`);
  await loadDishes();
  refreshDishesView();
}

function cartItemsForDish() {
  const items = new Map();
  for (const line of state.cart?.items ?? []) {
    const known = items.get(line.productId);
    if (known) known.count += line.quantity;
    else
      items.set(line.productId, {
        productId: line.productId,
        name: line.name,
        unitQuantity: line.unitQuantity,
        image: line.image,
        price: Math.round(line.price / Math.max(1, line.quantity)),
        count: line.quantity,
      });
  }
  return [...items.values()];
}

function addDishToCart(id) {
  return cartTask(async () => {
    const result = await api("addDishToCart", id, 1);
    toast(
      result.failed.length
        ? `„${result.dish}“ liegt im Warenkorb, aber ${result.failed.length} Produkte sind gerade nicht lieferbar: ${result.failed.map((f) => f.name).join(", ")}`
        : `„${result.dish}“ liegt im Warenkorb`,
      result.failed.length ? "error" : "info",
    );
    return result.cart;
  });
}

async function showDishChooser() {
  const box = $("#pd-dish");
  if (!box) return;
  const dishes = await loadDishes();
  box.innerHTML = `<p>Zu welchem Gericht?</p><div class="chips">${dishes
    .map((dish) => `<button class="chip" data-to-dish-id="${esc(dish.id)}">${esc(dish.name)}</button>`)
    .join("")}<button class="chip" data-to-dish-new>Neues Gericht</button></div>`;
}

async function addProductToDish(id) {
  const dish = findDish(id);
  const product = state.modalProduct;
  if (!dish || !product) return;
  const known = dish.items.find((item) => item.productId === product.productId);
  const items = known
    ? dish.items.map((item) => (item === known ? { ...item, count: item.count + 1 } : item))
    : [...dish.items, product];
  await api("saveDish", { ...dish, items });
  $("#pd-dish").innerHTML = `<p class="ok">Liegt jetzt in „${esc(dish.name)}“.</p>`;
  await loadDishes();
  refreshDishesView();
}

// ---------- Login ----------

const loginEl = $("#login");
const loginForm = $("#login-form");
const codeForm = $("#code-form");

function showError(form, message) {
  const el = $(".form-error", form);
  el.textContent = message ?? "";
  el.hidden = !message;
}

function showLogin(message) {
  loginEl.hidden = false;
  codeForm.hidden = true;
  loginForm.hidden = false;
  showError(loginForm, message);
  $("input[name=email]", loginForm).focus();
}

async function withBusy(form, task) {
  const buttons = $$("button", form);
  buttons.forEach((b) => (b.disabled = true));
  try {
    await task();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(loginForm);
  withBusy(loginForm, async () => {
    try {
      showError(loginForm, null);
      const outcome = await api("login", data.get("email"), data.get("password"), data.get("country"));
      $("input[name=password]", loginForm).value = "";
      if (outcome.status === "codeSent") {
        loginForm.hidden = true;
        codeForm.hidden = false;
        showError(codeForm, null);
        $("input[name=code]", codeForm).focus();
      } else {
        await start();
      }
    } catch (error) {
      showError(loginForm, error.message);
    }
  });
});

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = new FormData(codeForm).get("code");
  withBusy(codeForm, async () => {
    try {
      await api("verifyCode", code);
      codeForm.reset();
      await start();
    } catch (error) {
      showError(codeForm, error.message);
    }
  });
});

// ---------- Events ----------

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) {
    if (event.target === modal) closeModal();
    return;
  }
  const d = target.dataset;
  if (d.nav) {
    if (!modal.hidden) closeModal();
    return go(d.nav, {}, { reset: true });
  }
  if (d.checkout !== undefined) return openCheckout();
  if (d.placeOrder !== undefined) return placeOrder();
  if (d.resolveIssue) return placeOrder(d.resolveIssue);
  if (d.openPayment !== undefined) return payment.paymentUrl && api("openPaymentPage", payment.paymentUrl);
  if (d.cancelPayment !== undefined) return cancelPayment();
  if (d.back !== undefined) return back();
  if (d.inc) return changeQuantity(d.inc, 1);
  if (d.dec) return changeQuantity(d.dec, -1);
  if (d.product) return openProduct(d.product);
  if (d.cat) {
    closeModal();
    return go("category", { id: d.cat, kind: d.kind, title: d.title });
  }
  if (d.group) return go("group", { id: d.group, title: d.title });
  if (d.aisle) return go("aisle", { id: d.aisle, title: d.title });
  if (d.order) return go("order", { id: d.order });
  if (d.img) return ($(".pd-main", modal).src = d.img);
  if (d.close !== undefined) return closeModal();
  if (d.slots !== undefined) return openSlots();
  if (d.slot) {
    closeModal();
    return cartTask(() => api("selectSlot", d.slot)).then((ok) => ok && toast("Lieferfenster gewählt"));
  }
  if (d.clear !== undefined) {
    if (confirm("Alle Produkte aus dem Warenkorb entfernen?")) cartTask(() => api("clearCart"));
    return;
  }
  if (d.reorder !== undefined) {
    const items = state.orderItems.map((item) => ({ productId: item.productId, count: item.quantity }));
    target.disabled = true;
    return cartTask(async () => {
      const result = await api("addToCart", items);
      toast(
        result.failed.length
          ? `${items.length - result.failed.length} Produkte hinzugefügt, ${result.failed.length} gerade nicht verfügbar`
          : "Alle Produkte liegen im Warenkorb",
      );
      return result.cart;
    }).finally(() => (target.disabled = false));
  }
  if (d.copy !== undefined) {
    return api("copy", state.copies[Number(d.copy)]).then(() => toast("Kopiert"));
  }
  if (d.connectClaude !== undefined) {
    target.disabled = true;
    return api("connectClaude")
      .then(({ desktop, code }) => {
        if (desktop.ok) toast("In Claude Desktop eingetragen. Beende Claude Desktop ganz und starte es neu.");
        else toast(`Claude Desktop: ${desktop.reason}`, "error");
        if (code.ok) toast("In Claude Code eingetragen. Neue Code-Sessions haben den Zugang.");
        else if (!/nicht installiert/.test(code.reason)) toast(`Claude Code: ${code.reason}`, "error");
        return go("claude", {}, { reset: true });
      })
      .catch((error) => toast(error.message, "error"))
      .finally(() => (target.disabled = false));
  }
  if (d.logout !== undefined) {
    return api("logout").then(() => {
      state.cart = null;
      state.quantities = new Map();
      showLogin();
    });
  }
  if (d.resend !== undefined) {
    return api("resendCode")
      .then(() => toast("Neuer Code ist unterwegs"))
      .catch((error) => showError(codeForm, error.message));
  }
  if (d.restart !== undefined) return showLogin();

  // Dishes
  if (d.dishNew !== undefined) return openDishEditor(null);
  if (d.dishFromCart !== undefined) {
    openDishEditor(null);
    state.editor.items = cartItemsForDish();
    return renderEditorLines();
  }
  if (d.dishOpen) return openDish(d.dishOpen);
  if (d.dishEdit) return openDishEditor(findDish(d.dishEdit));
  if (d.dishCart) {
    target.disabled = true;
    return addDishToCart(d.dishCart).finally(() => (target.disabled = false));
  }
  if (d.edInc || d.edDec) {
    const item = state.editor.items[Number(d.edInc ?? d.edDec)];
    item.count += d.edInc ? 1 : -1;
    if (item.count <= 0) state.editor.items.splice(state.editor.items.indexOf(item), 1);
    renderEditorLines();
    return renderEditorResults();
  }
  if (d.edAdd) {
    const p = state.editorResults[Number(d.edAdd)];
    return addToEditor({ productId: p.id, name: p.name, unitQuantity: p.quantity, image: p.image, price: p.price });
  }
  if (d.edSearch !== undefined) return runEditorSearch();
  if (d.edDelete !== undefined) {
    if (!confirm(`„${state.editor.name}“ löschen?`)) return;
    return api("deleteDish", state.editor.id).then(async () => {
      closeModal();
      toast("Gericht gelöscht");
      await loadDishes();
      refreshDishesView();
    });
  }
  if (d.recipeTab) {
    const form = $("#dish-form");
    const preview = d.recipeTab === "preview";
    $$("[data-recipe-tab]", form).forEach((tab) => tab.classList.toggle("is-active", tab === target));
    $("[name=recipe]", form).hidden = preview;
    const view = $(".recipe-preview", form);
    view.hidden = !preview;
    if (preview) view.innerHTML = markdown($("[name=recipe]", form).value) || `<p class="empty">Noch kein Rezept.</p>`;
    return;
  }
  if (d.toDish !== undefined) return showDishChooser();
  if (d.toDishId) return addProductToDish(d.toDishId).catch((error) => toast(error.message, "error"));
  if (d.toDishNew !== undefined) {
    const product = state.modalProduct;
    openDishEditor(null);
    state.editor.items = [{ ...product, count: 1 }];
    return renderEditorLines();
  }
  if (d.dishSaveCart !== undefined) {
    go("dishes", {}, { reset: true });
    openDishEditor(null);
    state.editor.items = cartItemsForDish();
    return renderEditorLines();
  }
});

// Settings on the "Mit Claude verbinden" page save as soon as they change.
document.addEventListener("change", (event) => {
  const key = event.target.dataset?.setting;
  if (!key) return;
  const value = key === "claudeMayOrder" ? event.target.checked : Math.round(Number(event.target.value) * 100);
  api("saveSettings", { [key]: value })
    .then((settings) =>
      toast(
        key === "claudeMayOrder"
          ? settings.claudeMayOrder
            ? "Claude darf jetzt Bestellungen auslösen"
            : "Claude darf keine Bestellungen mehr auslösen"
          : `Höchstbetrag: ${euro(settings.claudeOrderLimit)}`,
      ),
    )
    .catch((error) => toast(error.message, "error"));
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "dish-form") return;
  event.preventDefault();
  const form = event.target;
  const error = $(".form-error", form);
  error.hidden = true;
  saveEditor(form).catch((e) => {
    error.textContent = e.message;
    error.hidden = false;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) closeModal();
  if (event.key === "Enter" && event.target.id === "dish-search") {
    event.preventDefault();
    runEditorSearch();
  }
});

// Claude saved or deleted a dish through the MCP server.
window.picnic.onDishesChanged?.(() => {
  if (modal.hidden) refreshDishesView();
});

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = new FormData(event.target).get("q").trim();
  if (query) go("search", { query });
});

// Claude changed the cart through the MCP server.
window.picnic.onCartChanged(() => {
  if (!loginEl.hidden) return;
  cartTask(() => api("cart")).then((ok) => {
    if (!ok) return;
    cartEl.classList.remove("flash");
    void cartEl.offsetWidth;
    cartEl.classList.add("flash");
    toast("Claude hat den Warenkorb geändert");
  });
});

// Changes made in the phone app.
setInterval(() => {
  if (document.visibilityState === "visible" && loginEl.hidden && state.cart) cartTask(() => api("cart"));
}, 60_000);

// ---------- Start ----------

async function start() {
  const status = await api("status");
  if (!status.loggedIn) return showLogin();
  loginEl.hidden = true;
  $("#account-name").textContent = status.userName ?? "Angemeldet";
  renderCart();
  cartTask(() => api("cart"));
  go("promotions", {}, { reset: true });
}

paintIcons();
start().catch((error) => showLogin(error.message));
