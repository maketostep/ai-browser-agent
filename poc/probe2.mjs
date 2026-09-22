import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext("./.profile-poc", {
  channel: "chrome", headless: false, viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

// 1) what snapshot-ish APIs actually exist on Page?
const proto = Object.getPrototypeOf(page);
const names = new Set();
for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of Object.getOwnPropertyNames(o)) if (/snap|aria|accessib/i.test(k)) names.add(k);
}
console.log("Page snapshot-ish members:", [...names].join(", ") || "(none)");

await page.goto("https://lavka.yandex.ru", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

const before = await page.locator("body").ariaSnapshot();
console.log("aria WITH modal open :", before.length, "chars");

// 2) dismiss whatever modal is trapping the a11y tree - generic, no hardcoded selector
const dlg = page.locator('[role="dialog"]').first();
if (await dlg.count()) {
  const closer = dlg.getByRole("button").last();
  try { await closer.click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(1500);
}

const after = await page.locator("body").ariaSnapshot();
console.log("aria AFTER dismiss   :", after.length, "chars");

// 3) how many interactive nodes does the page actually have?
const counts = await page.evaluate(() => {
  const q = (s) => document.querySelectorAll(s).length;
  return { all: q("*"), interactive: q('a,button,input,select,textarea,[role="button"],[role="link"],[onclick],[tabindex]') };
});
console.log("DOM nodes:", counts.all, "| interactive:", counts.interactive);
console.log("\n--- aria after dismiss (first 1500) ---\n" + after.slice(0, 1500));
await ctx.close();
