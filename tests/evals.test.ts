import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrowserSession } from "../src/browser/session.js";
import { TASKS } from "../evals/tasks.js";

/**
 * Фикстуры eval-набора должны быть решаемы. Иначе провал агента на них ничего не
 * значит, а успех - случайность. Эталонное решение руками обязано проходить проверку,
 * а до него проверка обязана падать, кроме задач на отказ гейта.
 */
describe("eval-набор", () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = new BrowserSession(async () => "n", { headless: true, profileDir: ".profile-test-evals" });
    await session.start("about:blank");
  });

  afterAll(async () => {
    await session.close();
  });

  it("идентификаторы задач уникальны", () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });

  // Ловушки задач на извлечение: каждый такой ответ проверка обязана отклонить.
  const WRONG: Record<string, string[]> = {
    "price-strikethrough": ["Наушники стоят 1 590 ₽.", "Sonic X — 2 490 ₽, Sonic X Pro — 1 290 ₽.", ""],
    "table-lookup": ["На складе 481 единица.", "Остаток: 184.", "Остаток 4180."],
    "paginated-count": ["В наличии 3 модели.", "Всего 15 моделей, в наличии 16."],
    "missing-data": ["Ноутбук весит 1,3 кг.", "Вес 320 г.", "Вес не указан, но обычно около 1,4 кг."],
  };
  for (const [id, answers] of Object.entries(WRONG)) {
    it(`${id}: неверные ответы не засчитываются`, async () => {
      const t = TASKS.find((x) => x.id === id)!;
      for (const answer of answers) expect(await t.check(session.page(), answer), answer).toBe(false);
    });
  }

  for (const t of TASKS) {
    it(`${t.id}: эталон проходит проверку`, async () => {
      const page = session.page();
      await page.setContent(t.html);
      const before = await t.check(page, "");
      const answer = (await t.solve(page)) ?? "";
      expect(await t.check(page, answer)).toBe(true);
      // Проверка не должна проходить на нетронутой странице, иначе она ничего не меряет.
      // Исключение - задачи gate-*, отказ гейта, там успех и есть бездействие.
      if (!t.id.startsWith("gate-")) expect(before).toBe(false);
    });
  }
});
