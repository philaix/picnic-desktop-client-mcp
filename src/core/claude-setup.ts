import { spawnSync } from "node:child_process";
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

/** Claude Code's user-scope config, which its terminal sessions and the desktop app's Code tab read. */
const claudeCodeConfigFile = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");

/**
 * The Claude Code CLI. Apps started from the Dock or Start menu don't get the shell's PATH, so the
 * usual install locations are checked before asking the system.
 */
function findClaudeCli(): string | null {
  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [join(home, ".local", "bin", "claude.exe")]
      : [
          join(home, ".local", "bin", "claude"),
          join(home, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ];
  const found = candidates.find((file) => existsSync(file));
  if (found) return found;
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
  const fromPath = lookup.status === 0 ? lookup.stdout.split(/\r?\n/).find((line) => line.trim()) : undefined;
  // npm's claude.cmd can only run through a shell, which would mangle the JSON argument; skip it.
  return fromPath && !/\.(cmd|bat)$/i.test(fromPath) ? fromPath.trim() : null;
}

const hasOurServer = (config: Record<string, any>, entry: ReturnType<typeof mcpServerEntry>) =>
  config.mcpServers?.picnic?.args?.[0] === entry.args[0];

export function claudeSetup(appRoot: string) {
  const entry = mcpServerEntry(appRoot);
  const inDesktop = claudeDesktopConfigFiles().some((file) => {
    try {
      return hasOurServer(readConfig(file), entry);
    } catch {
      return false;
    }
  });
  let inCode = false;
  try {
    inCode = hasOurServer(readConfig(claudeCodeConfigFile()), entry);
  } catch {
    // Unreadable config counts as not connected.
  }
  return {
    inDesktop,
    inCode,
    claudeCodeFound: findClaudeCli() !== null,
    desktopJson: JSON.stringify({ mcpServers: { picnic: entry } }, null, 2),
    claudeCodeCommand: `claude mcp add --env ELECTRON_RUN_AS_NODE=1 --transport stdio --scope user picnic -- "${entry.command}" "${entry.args[0]}"`,
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

/**
 * Adds the server to Claude Code at user scope through its own CLI (`claude mcp add-json`), the way
 * its docs describe; writing ~/.claude.json directly could race with a running Claude Code.
 */
export function connectClaudeCode(appRoot: string): { ok: true } | { ok: false; reason: string } {
  const cli = findClaudeCli();
  if (!cli) return { ok: false, reason: "Claude Code ist auf diesem Rechner nicht installiert." };
  const run = (args: string[]) => spawnSync(cli, args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
  // Replaces an older entry, e.g. from a previous install location.
  run(["mcp", "remove", "picnic", "--scope", "user"]);
  const added = run(["mcp", "add-json", "picnic", JSON.stringify(mcpServerEntry(appRoot)), "--scope", "user"]);
  if (added.status === 0) return { ok: true };
  return { ok: false, reason: (added.stderr || added.stdout || added.error?.message || "Unbekannter Fehler").trim() };
}

/** Connects Claude Desktop (chat) and Claude Code (Code tab and terminal) in one go. */
export function connectClaude(appRoot: string) {
  let desktop: { ok: true; files: string[] } | { ok: false; reason: string };
  try {
    desktop = { ok: true, files: connectClaudeDesktop(appRoot) };
  } catch (error) {
    desktop = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { desktop, code: connectClaudeCode(appRoot) };
}
