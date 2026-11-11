export {};

declare global {
  interface Window {
    kannaDesktop?: {
      initialTheme?: "light" | "dark";
      setTheme(theme: "light" | "dark"): Promise<"light" | "dark">;
      setUiScale(scale: number): Promise<number>;
    };
  }
}
