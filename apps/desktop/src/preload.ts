import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kannaDesktop", {
  initialTheme: ipcRenderer.sendSync("ui:get-theme") as "light" | "dark" | undefined,
  setTheme(theme: "light" | "dark"): Promise<"light" | "dark"> {
    return ipcRenderer.invoke("ui:set-theme", theme) as Promise<"light" | "dark">;
  },
  setUiScale(scale: number): Promise<number> {
    return ipcRenderer.invoke("ui:set-scale", scale) as Promise<number>;
  },
});
