// Renders build/icon.svg to the PNGs the app needs. Run with: npx electron scripts/render-icons.mjs
//   build/icon.png (1024 px) – electron-builder makes the .ico and .icns from it
//   app/icon.png   (256 px)  – window and taskbar icon
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "build", "icon.svg"), "utf8");
// Rendered at 512 px with a device scale of 2, so the window fits on any screen and the capture is 1024 px.
const size = 1024;
const css = size / 2;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "2");
// No top-level await: Electron emits "ready" only after the main module has finished loading.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: css,
    height: css,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${css}" height="${css}" style="display:block">
  </body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const captured = await window.webContents.capturePage();
  const { width, height } = captured.getSize();
  if (width !== height) throw new Error(`Capture is ${width}x${height}, expected a square`);
  const image = captured.resize({ width: size, height: size, quality: "best" });
  writeFileSync(join(root, "build", "icon.png"), image.toPNG());
  writeFileSync(join(root, "app", "icon.png"), image.resize({ width: 256, height: 256, quality: "best" }).toPNG());
  console.log("wrote build/icon.png and app/icon.png");
  app.quit();
});
