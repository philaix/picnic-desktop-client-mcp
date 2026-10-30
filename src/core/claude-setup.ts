import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How Claude starts the MCP server: the app's own Electron binary in Node mode, so the colleague
 * doesn't need Node.js installed.
 */
export function mcpServerEntry(appRoot: string) {
  return {
    command: process.execPath,
    args: [join(appRoot, "dist", "mcp.js")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function claudeDesktopConfigFiles(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  }
  if (process.platform === "win32") {
    const files = [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")];
    // Claude from the Microsoft Store keeps its config inside its package folder.
    const packages = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Packages");
    try {
      for (const dir of readdirSync(packages)) {
        if (dir.startsWith("Claude_")) files.push(join(packages, dir, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    } catch {
      // No Store packages folder.
    }
    return files;
  }
  return [join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json")];
}

function readConfig(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Die Claude-Einstellungsdatei ist kein gültiges JSON und wurde nicht verändert: ${file}`);
  }
}

export function claudeSetup(appRoot: string) {
  const entry = mcpServerEntry(appRoot);
  const connected = claudeDesktopConfigFiles().some((file) => {
    try {
      return readConfig(file).mcpServers?.picnic?.args?.[0] === entry.args[0];
    } catch {
      return false;
    }
  });
  return {
    connected,
    desktopJson: JSON.stringify({ mcpServers: { picnic: entry } }, null, 2),
    claudeCodeCommand: `claude mcp add picnic --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${entry.command}" "${entry.args[0]}"`,
    // A macOS app started from Downloads or the disk image runs from a random path that changes.
    warning:
      process.platform === "darwin" && /AppTranslocation|^\/Volumes\//.test(appRoot)
        ? "Zieh die App zuerst in den Programme-Ordner und starte sie von dort. Sonst findet Claude sie nach einem Neustart nicht mehr."
        : null,
  };
}

/** Adds the server to every Claude Desktop config found (keeping a .bak copy) and returns the files written. */
export function connectClaudeDesktop(appRoot: string): string[] {
  const candidates = claudeDesktopConfigFiles();
  const installed = candidates.filter((file) => existsSync(dirname(file)));
  const targets = installed.length > 0 ? installed : [candidates[0]];
  for (const file of targets) {
    const config = readConfig(file);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    config.mcpServers = { ...config.mcpServers, picnic: mcpServerEntry(appRoot) };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2));
  }
  return targets;
}
