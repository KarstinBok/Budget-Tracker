// 🌓 Light or dark mode, chosen per device: Auto (follow the phone), Light or Dark.
// Loaded in each page's <head> so the page never flashes the wrong colours; it also adds
// a 🌓 button to the top bar.
(() => {
  const KEY = "theme";
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; } };
  const DARK_BG = "#15130f", LIGHT_ACCENT = "#bc002d";
  function apply(mode) {
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else delete root.dataset.theme;
    const dark = mode === "dark" || (mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? DARK_BG : LIGHT_ACCENT);
  }
  apply(read());
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => apply(read()));

  const OPTIONS = [["auto", "🌓", "Auto (follow phone)"], ["light", "☀️", "Light"], ["dark", "🌙", "Dark"]];
  const icon = (mode) => OPTIONS.find((o) => o[0] === mode)?.[1] ?? "🌓";

  function addButton() {
    const bar = document.querySelector(".top-actions") ?? document.querySelector(".topbar");
    if (!bar || document.querySelector(".theme-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost theme-btn";
    btn.title = "Light or dark mode";
    btn.setAttribute("aria-label", "Light or dark mode");
    btn.setAttribute("aria-haspopup", "menu");
    btn.textContent = icon(read());
    bar.prepend(btn);

    let menu = null;
    const close = () => { menu?.remove(); menu = null; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu) return close();
      menu = document.createElement("div");
      menu.className = "theme-menu";
      menu.setAttribute("role", "menu");
      const now = read();
      menu.innerHTML = OPTIONS.map(([m, i, label]) => `<button type="button" role="menuitemradio" aria-checked="${m === now}" data-mode="${m}"><span>${i}</span>${label}</button>`).join("");
      document.body.append(menu);
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
      btn.setAttribute("aria-expanded", "true");
      menu.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-mode]");
        if (!b) return;
        try { localStorage.setItem(KEY, b.dataset.mode); } catch { /* private mode */ }
        apply(b.dataset.mode);
        btn.textContent = icon(b.dataset.mode);
        close();
      });
      menu.querySelector('[aria-checked="true"]')?.focus();
    });
    document.addEventListener("click", (e) => { if (menu && !menu.contains(e.target)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
  else addButton();
  // Other tabs: follow a change made there.
  addEventListener("storage", (e) => { if (e.key === KEY) { apply(read()); const b = document.querySelector(".theme-btn"); if (b) b.textContent = icon(read()); } });
})();
