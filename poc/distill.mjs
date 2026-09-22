import { chromium } from "playwright";

const DISTILL = () => {
  const out = [];
  let n = 0;
  const seen = new WeakSet();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (t === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (t === "button") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio" || ty === "submit" || ty === "button") return ty;
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    return null;
  };
  const nameOf = (el) => {
    const cands = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("alt"),
      el.getAttribute("title"),
      el.getAttribute("value"),
      (el.innerText || "").trim(),
    ];
    const name = cands.find((c) => c && c.trim()) || "";
    return name.replace(/\s+/g, " ").trim().slice(0, 80);
  };
  const isInteractive = (el) => {
    const t = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea"].includes(t)) return true;
    const r = el.getAttribute("role");
    if (r && /button|link|tab|checkbox|radio|menuitem|option|searchbox|textbox|combobox|switch/.test(r)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.getAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    return false;
  };

  const walk = (root) => {
    const els = root.querySelectorAll("*");
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!isInteractive(el) || !vis(el)) continue;
      const role = roleOf(el);
      if (!role || role === "generic") continue;
      const ref = "e" + ++n;
      el.setAttribute("data-agent-ref", ref);
      const name = nameOf(el);
      const state = [];
      if (el.disabled) state.push("disabled");
      if (el.checked) state.push("checked");
      if (el.value && role.includes("box")) state.push(`value=${JSON.stringify(String(el.value).slice(0, 40))}`);
      out.push(`[${ref}] ${role} ${JSON.stringify(name)}${state.length ? " [" + state.join(",") + "]" : ""}`);
    }
  };
  document.querySelectorAll("[data-agent-ref]").forEach((e) => e.removeAttribute("data-agent-ref"));
  walk(document);
  const text = (document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return { elements: out.join("\n"), count: n, text: text.slice(0, 4000), textFull: text.length };
};

const ctx = await chromium.launchPersistentContext("./.profile-poc", {
  channel: "chrome", headless: false, viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://lavka.yandex.ru", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

const html = await page.content();
const aria = await page.locator("body").ariaSnapshot();
const d = await page.evaluate(DISTILL);

console.log("raw HTML        :", html.length, "chars");
console.log("ariaSnapshot    :", aria.length, "chars");
console.log("our distillation:", d.elements.length, "chars |", d.count, "interactive elements");
console.log("page innerText  :", d.textFull, "chars");
console.log("\n--- distilled elements (first 30) ---");
console.log(d.elements.split("\n").slice(0, 30).join("\n"));

// PROVE the round trip: find a searchbox purely from the distilled view, act on its ref
const line = d.elements.split("\n").find((l) => /searchbox|textbox/.test(l));
console.log("\nchosen line:", line);
const ref = line.match(/\[(e\d+)\]/)[1];
await page.locator(`[data-agent-ref="${ref}"]`).click({ timeout: 5000 });
await page.locator(`[data-agent-ref="${ref}"]`).fill("хот-дог");
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
console.log("URL after acting on", ref, "->", page.url());

const d2 = await page.evaluate(DISTILL);
console.log("after nav: elements", d2.count, "| distill", d2.elements.length, "chars");
await ctx.close();
