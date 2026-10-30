import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import * as checkout from "./core/checkout.js";
import * as auth from "./core/client.js";
import { claudeSetup, connectClaude } from "./core/claude-setup.js";
import * as dishes from "./core/dishes.js";
import { paymentOverview } from "./core/payments.js";
import { cartVersionFile, type CountryCode } from "./core/session.js";
import { loadSettings, saveSettings, type Settings } from "./core/settings.js";
import * as shop from "./core/shop.js";

const appRoot = app.getAppPath();
let window: BrowserWindow | null = null;

/** The cart-version value written by this app's own changes, so only Claude's changes are announced. */
let ownCartVersion: string | null = null;
const readCartVersion = () => {
  try {
    return readFileSync(cartVersionFile(), "utf8");
  } catch {
    return null;
  }
};
const changingCart =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A) => {
    const result = await fn(...args);
    ownCartVersion = readCartVersion();
    return result;
  };

const api: Record<string, (...args: any[]) => unknown> = {
  status: shop.status,
  login: (email: string, password: string, countryCode: CountryCode) => auth.login(email, password, countryCode),
  verifyCode: (code: string) => auth.verifyCode(code),
  resendCode: () => auth.resendCode(),
  logout: () => auth.logout(),
  search: (query: string, limit?: number) => shop.search(query, limit),
  categories: () => shop.categories(),
  openCategory: (id: string, kind: "subcategories" | "products" | "promotions") => shop.openCategory(id, kind),
  promotions: () => shop.promotions(),
  promotionGroup: (id: string) => shop.promotionGroup(id),
  favorites: () => shop.favorites(),
  favoritesAisle: (id: string) => shop.favoritesAisle(id),
  product: (id: string) => shop.product(id),
  cart: () => shop.cart(),
  addToCart: changingCart(shop.addToCart),
  setQuantity: changingCart(shop.setQuantity),
  clearCart: changingCart(shop.clearCart),
  deliverySlots: () => shop.deliverySlots(),
  selectSlot: changingCart(shop.selectSlot),
  deliveries: (limit?: number) => shop.deliveries(limit),
  delivery: (id: string) => shop.delivery(id),
  dishes: () => dishes.listDishes(),
  saveDish: (dish: dishes.DishInput) => dishes.saveDish(dish),
  deleteDish: (id: string) => dishes.deleteDish(id),
  addDishToCart: changingCart((id: string, times?: number) => dishes.addDishToCart(id, times)),
  cartAsDishItems: () => dishes.cartAsDishItems(),
  orderSummary: () => checkout.orderSummary(),
  placeOrder: (confirmation: string, resolveKey?: string) => checkout.placeOrder(confirmation, resolveKey),
  orderStatus: changingCart((orderId: string, transactionId?: string) => checkout.orderStatus(orderId, transactionId)),
  cancelPayment: (transactionId: string) => checkout.cancelPayment(transactionId),
  openPaymentPage: (url: string) => {
    // Only real payment pages; the renderer never gets to open arbitrary links.
    if (!/^https:\/\//.test(String(url))) throw new Error("Ungültige Zahlungsadresse.");
    return shell.openExternal(url);
  },
  payments: () => paymentOverview(),
  settings: () => loadSettings(),
  saveSettings: (changes: Partial<Settings>) => saveSettings(changes),
  claudeSetup: () => claudeSetup(appRoot),
  connectClaude: () => connectClaude(appRoot),
  copy: (text: string) => clipboard.writeText(String(text)),
};

ipcMain.handle("picnic", async (_event, method: string, args: unknown[]) => {
  if (!Object.hasOwn(api, method)) return { ok: false, error: `Unbekannte Aktion: ${method}` };
  try {
    return { ok: true, data: await api[method](...(Array.isArray(args) ? args : [])) };
  } catch (error) {
    return { ok: false, error: auth.describeError(error), expired: auth.isSessionExpired(error) };
  }
});

function createWindow() {
  window = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1040,
    minHeight: 640,
    title: "Desktop-Client für Picnic",
    icon: join(appRoot, "app", "icon.png"),
    backgroundColor: "#F1F3EE",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(appRoot, "app", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => (window = null));
  void window.loadFile(join(appRoot, "app", "index.html"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  void app.whenReady().then(() => {
    createWindow();
    // The MCP server writes this file after each cart change; tell the window so it shows Claude's work right away.
    watchFile(cartVersionFile(), { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) return;
      const version = readCartVersion();
      if (version && version !== ownCartVersion) window?.webContents.send("cart-changed");
    });
    // Dishes Claude saved or deleted show up while the dishes view is open.
    watchFile(dishes.dishesFile(), { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs) window?.webContents.send("dishes-changed");
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
