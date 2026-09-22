/**
 * Дымовой прогон продового кода наблюдения на живом сайте, без обращения к модели.
 * Проверяет то, чего не поймают тесты на фикстуре: фреймы, попапы, реальный объём.
 *
 *   npx tsx scripts/smoke-observe.ts https://lavka.yandex.ru
 */
import { BrowserSession } from "../src/browser/session.js";
import { Actions } from "../src/browser/actions.js";

const url = process.argv[2] ?? "https://lavka.yandex.ru";
const profileDir = process.argv[3] ?? ".profile";

// Headed по умолчанию: продукт работает только так, и headless ловит антибот
// (Лавка отдаёт 403). Проверять надо ровно в той конфигурации, в которой работаем.
const session = new BrowserSession(async () => "n", { profileDir, headless: process.env["SMOKE_HEADLESS"] === "1" });
await session.start("about:blank");
const actions = new Actions(session);

const navigated = await actions.navigate(url);
console.log(`navigate ok=${navigated.ok}: ${navigated.message}`);

const page = session.page();
const rawHtml = await page.content();
const observation = await actions.observe();
const formatted = JSON.stringify(observation).length;
const elementCount = (observation.elements.match(/^\[(?:f\d+:)?e\d+\]/gm) ?? []).length;

console.log("");
console.log(`url            : ${observation.url}`);
console.log(`title          : ${observation.title}`);
console.log(`raw HTML       : ${rawHtml.length} симв.`);
console.log(`наблюдение     : ${formatted} симв.`);
console.log(`элементов      : ${elementCount}`);
console.log(`сжатие         : ${(rawHtml.length / formatted).toFixed(0)}x`);
console.log(`вкладок        : ${observation.tabs}`);
if (observation.note) console.log(`заметка        : ${observation.note}`);
console.log("");
console.log(observation.elements.split("\n").slice(0, 15).join("\n"));

await session.close();
