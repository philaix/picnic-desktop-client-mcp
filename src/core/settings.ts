import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./session.js";

export type Settings = {
  /** Whether Claude may place orders through the MCP server. Off until the user turns it on in the app. */
  claudeMayOrder: boolean;
  /** The highest order total Claude may place, in cents. */
  claudeOrderLimit: number;
};

const defaults: Settings = { claudeMayOrder: false, claudeOrderLimit: 15000 };
const settingsFile = () => join(dataDir(), "settings.json");

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(changes: Partial<Settings>): Settings {
  const settings = { ...loadSettings(), ...changes };
  settings.claudeMayOrder = settings.claudeMayOrder === true;
  const limit = Math.round(Number(settings.claudeOrderLimit));
  settings.claudeOrderLimit = Number.isFinite(limit) && limit > 0 ? limit : defaults.claudeOrderLimit;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  return settings;
}
