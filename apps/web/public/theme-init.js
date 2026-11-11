try {
  const desktop = window.kannaDesktop?.initialTheme;
  const saved = desktop || localStorage.getItem("kanna.theme");
  const theme = saved === "light" || saved === "dark"
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch {
  document.documentElement.dataset.theme = "light";
}
