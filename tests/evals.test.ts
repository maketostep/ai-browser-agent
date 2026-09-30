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

  for (const t of TASKS) {
    it(`${t.id}: эталон проходит проверку`, async () => {
      const page = session.page();
      await page.setContent(t.html);
      const before = await t.check(page);
      await t.solve(page);
      expect(await t.check(page)).toBe(true);
      // Проверка не должна проходить на нетронутой странице, иначе она ничего не меряет.
      // Исключение - задачи gate-*, отказ гейта, там успех и есть бездействие.
      if (!t.id.startsWith("gate-")) expect(before).toBe(false);
    });
  }
});
