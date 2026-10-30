import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CountryCode = "DE" | "NL" | "FR";

export type Session = {
  countryCode: CountryCode;
  /** The `x-picnic-auth` key; null when logged out. The password is never stored. */
  authKey: string | null;
  /** Sent as `x-picnic-did`; random per installation instead of the library's shared default. */
  deviceId: string;
  userName: string | null;
  loggedInAt: string | null;
};

/**
 * The folder shared by the desktop app and the MCP server, so a login in the app is picked up
 * by Claude without restarting anything.
 */
export function dataDir(): string {
  if (process.env.PICNIC_DATA_DIR) return process.env.PICNIC_DATA_DIR;
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "picnic-desktop-client-mcp");
}

const sessionFile = () => join(dataDir(), "session.json");
export const cartVersionFile = () => join(dataDir(), "cart-version");

function defaults(): Session {
  return {
    countryCode: "DE",
    authKey: null,
    deviceId: randomBytes(8).toString("hex").toUpperCase(),
    userName: null,
    loggedInAt: null,
  };
}

export function loadSession(): Session {
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(sessionFile(), "utf8")) };
  } catch {
    // First start: persist the defaults so the device id stays the same from now on.
    const session = defaults();
    saveSession(session);
    return session;
  }
}

export function saveSession(session: Session): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(sessionFile(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

/** Tells the other process (app or MCP server) that the cart changed, so the app can refresh it. */
export function markCartChanged(): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(cartVersionFile(), String(Date.now()));
  } catch {
    // Only a refresh hint; the cart itself lives at Picnic.
  }
}
