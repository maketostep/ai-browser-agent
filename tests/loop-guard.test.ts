import { describe, it, expect } from "vitest";
import { actionSignature, LOOP_WINDOW, LOOP_WARN_AT, LOOP_STOP_AT } from "../src/agent/loop.js";

/**
 * Регрессия из живого прогона по Яндекс.Почте: восемь шагов подряд агент кликал по
 * одному письму, оно открывало постороннюю вкладку, агент возвращался и кликал снова.
 * Каждый клик формально УСПЕШЕН, поэтому счётчик неудач сбрасывался и цикл не ловился.
 */
describe("обнаружение цикла", () => {
  it("подпись игнорирует формулировку намерения", () => {
    // Агент любит переписывать intent теми же словами наизнанку. Действие от этого
    // не меняется, и подпись меняться не должна.
    const a = actionSignature("click", { ref: "e58", intent: "открыть письмо" });
    const b = actionSignature("click", { ref: "e58", intent: "открываю письмо, чтобы прочитать" });
    expect(a).toBe(b);
  });

  it("различает действия по существу", () => {
    expect(actionSignature("click", { ref: "e58" })).not.toBe(actionSignature("click", { ref: "e57" }));
    expect(actionSignature("click", { ref: "e58" })).not.toBe(actionSignature("go_back", {}));
    expect(actionSignature("switch_tab", { index: 0 })).not.toBe(actionSignature("switch_tab", { index: 1 }));
    expect(actionSignature("navigate", { url: "https://a.test" })).not.toBe(
      actionSignature("navigate", { url: "https://b.test" }),
    );
  });

  it("ловит цикл из живого прогона: клик, возврат, клик, возврат", () => {
    // Воспроизводим ровно ту последовательность, включая чередование с switch_tab,
    // которое сбивало бы наивный счётчик "подряд идущих одинаковых действий".
    const steps = [
      actionSignature("click", { ref: "e58", intent: "открыть письмо" }),
      actionSignature("switch_tab", { index: 0 }),
      actionSignature("click", { ref: "e58", intent: "открыть письмо ещё раз" }),
      actionSignature("switch_tab", { index: 0 }),
      actionSignature("click", { ref: "e58", intent: "попробую снова" }),
    ];

    const window: string[] = [];
    const repeatsPerStep = steps.map((signature) => {
      window.push(signature);
      if (window.length > LOOP_WINDOW) window.shift();
      return window.filter((s) => s === signature).length;
    });

    // На третьем клике по тому же письму агент должен получить предупреждение.
    expect(repeatsPerStep[4]).toBe(LOOP_WARN_AT);
    expect(repeatsPerStep[4]).toBeGreaterThanOrEqual(LOOP_WARN_AT);
  });

  it("окно не даёт срабатывать на давние совпадения", () => {
    const window: string[] = [];
    const push = (s: string): number => {
      window.push(s);
      if (window.length > LOOP_WINDOW) window.shift();
      return window.filter((x) => x === s).length;
    };

    push("click|ref=e1");
    for (let i = 0; i < LOOP_WINDOW; i++) push(`click|ref=e${i + 10}`);
    // Первое действие давно вытеснено из окна, повтор считается первым.
    expect(push("click|ref=e1")).toBe(1);
  });

  it("пороги расставлены осмысленно", () => {
    expect(LOOP_WARN_AT).toBeLessThan(LOOP_STOP_AT);
    expect(LOOP_STOP_AT).toBeLessThanOrEqual(LOOP_WINDOW);
  });
});
