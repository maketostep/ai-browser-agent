/**
 * Открывает браузер на персистентном профиле агента и ждёт, пока его закроют.
 * Модель не вызывается ни разу.
 *
 * Нужен для ручной подготовки, которую ТЗ прямо допускает: войти в аккаунт,
 * указать адрес доставки, принять куки. Всё это останется в профиле и переживёт
 * перезапуск, поэтому агенту потом не придётся делать это самому.
 *
 *   npx tsx scripts/open-browser.ts [url]
 */
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://lavka.yandex.ru";

const ctx = await chromium.launchPersistentContext(".profile", {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled", "--no-default-browser-check"],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log("Браузер открыт на профиле .profile");
console.log("Сделай что нужно руками (адрес, вход в аккаунт) и просто закрой окно.");
console.log("Ожидаю закрытия...");

await new Promise<void>((resolve) => {
  ctx.on("close", () => resolve());
  page.on("close", () => {
    if (ctx.pages().length === 0) resolve();
  });
});

await ctx.close().catch(() => {});
console.log("Профиль сохранён.");
