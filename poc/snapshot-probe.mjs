import { chromium } from "playwright";

const URL = process.argv[2] ?? "https://lavka.yandex.ru";
const ctx = await chromium.launchPersistentContext("./.profile-poc", {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

const html = await page.content();
const aria = await page.locator("body").ariaSnapshot();

const hasSnapForAI = typeof page._snapshotForAI === "function";
let snapForAI = null;
if (hasSnapForAI) {
  try { snapForAI = await page._snapshotForAI(); } catch (e) { snapForAI = "ERR: " + e.message; }
}

const kb = (s) => (s == null ? "-" : (s.length / 1024).toFixed(1) + " KB / " + s.length + " chars");
console.log("=== URL:", page.url());
console.log("title:", await page.title());
console.log("raw HTML       :", kb(html));
console.log("ariaSnapshot   :", kb(aria));
console.log("_snapshotForAI :", hasSnapForAI ? kb(snapForAI) : "NOT AVAILABLE");
console.log("\n--- ariaSnapshot head ---\n" + aria.slice(0, 900));
if (snapForAI) console.log("\n--- _snapshotForAI head ---\n" + String(snapForAI).slice(0, 1200));

await ctx.close();
