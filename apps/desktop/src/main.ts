import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunningPlatform, startPlatform } from "@kanna/server";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";

const APP_TITLE = "KannaPi";
const SMOKE_TEST = process.argv.includes("--smoke-test");
const moduleDir = dirname(fileURLToPath(import.meta.url));
// Keep the existing data directory stable across dev, unpacked and installed launches.
const smokeDataDir = process.env.KANNAPI_SMOKE_DATA_DIR;
if (SMOKE_TEST && (!smokeDataDir || !isAbsolute(smokeDataDir)))
  throw new Error("Smoke tests require an absolute KANNAPI_SMOKE_DATA_DIR to keep real user data untouched");
const stableUserDataDir = SMOKE_TEST ? resolve(smokeDataDir!) : join(app.getPath("appData"), "@kanna", "desktop");
mkdirSync(stableUserDataDir, { recursive: true });
app.setPath("userData", stableUserDataDir);
type ThemeMode = "light" | "dark";
const themePath = join(stableUserDataDir, "ui-theme.json");
function readSavedTheme(): ThemeMode | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(themePath, "utf8"));
    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}
let savedTheme = readSavedTheme();
let mainWindow: BrowserWindow | undefined;
let platform: RunningPlatform | undefined;
let shutdownStarted = false;

app.enableSandbox();

function developmentRoot(): string {
  return resolve(moduleDir, "..", "..", "..");
}

async function preparePackagedProxy(userDataDir: string): Promise<string> {
  const source = join(process.resourcesPath, "proxy");
  const destination = join(userDataDir, "proxy");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    ["flow_sink.py", "requirements.txt"].map((name) => copyFile(join(source, name), join(destination, name))),
  );
  return destination;
}

async function createMainWindow(): Promise<void> {
  const projectRoot = developmentRoot();
  const userDataDir = app.getPath("userData");
  const defaultWorkspace = SMOKE_TEST
    ? join(userDataDir, "smoke-workspace")
    : join(app.getPath("documents"), "KannaPi Workspace");
  await mkdir(defaultWorkspace, { recursive: true });
  const webRoot = app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(projectRoot, "apps", "web", "dist");
  const proxyDir = app.isPackaged
    ? await preparePackagedProxy(userDataDir)
    : join(projectRoot, "services", "proxy");

  platform = await startPlatform({
    repoRoot: projectRoot,
    defaultWorkspace,
    dataDir: join(userDataDir, "data"),
    proxyDir,
    webRoot,
    host: "127.0.0.1",
    port: 0,
  });

  const localOrigin = `http://127.0.0.1:${platform.port}`;
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f4f6f2",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(moduleDir, "preload.js"),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(localOrigin)) return { action: "allow" };
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(localOrigin)) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });
  mainWindow.webContents.once("did-fail-load", (_event, code, description) => {
    process.exitCode = 1;
    dialog.showErrorBox(APP_TITLE, `界面加载失败 (${code}): ${description}`);
    if (SMOKE_TEST) app.quit();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (SMOKE_TEST) setTimeout(() => app.quit(), 250);
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(`${localOrigin}/`);
}

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const running = platform;
  platform = undefined;
  await running?.close();
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  ipcMain.handle("ui:set-scale", (event, requestedScale: unknown) => {
    const scale = typeof requestedScale === "number" ? requestedScale : Number.NaN;
    if (!Number.isFinite(scale) || scale < 0.8 || scale > 1.4)
      throw new Error("UI scale must be between 80% and 140%");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Desktop window not found");
    window.webContents.setZoomFactor(scale);
    return scale;
  });
  ipcMain.on("ui:get-theme", (event) => {
    event.returnValue = savedTheme;
  });
  ipcMain.handle("ui:set-theme", (_event, requestedTheme: unknown) => {
    if (requestedTheme !== "light" && requestedTheme !== "dark")
      throw new Error("UI theme must be light or dark");
    writeFileSync(themePath, JSON.stringify(requestedTheme), "utf8");
    savedTheme = requestedTheme;
    return savedTheme;
  });
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (shutdownStarted || !platform) return;
    event.preventDefault();
    void shutdown()
      .catch((error) => {
        process.exitCode = 1;
        dialog.showErrorBox(APP_TITLE, error instanceof Error ? error.message : String(error));
      })
      .finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      await createMainWindow();
    })
    .catch((error) => {
      process.exitCode = 1;
      dialog.showErrorBox(APP_TITLE, error instanceof Error ? error.message : String(error));
      app.quit();
    });
}
