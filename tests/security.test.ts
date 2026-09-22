import { describe, it, expect, vi } from "vitest";
import { SecurityGate, type Classifier } from "../src/agent/security.js";
import type { RiskVerdict } from "../src/types.js";

const verdict = (risk: RiskVerdict["risk"]): RiskVerdict => ({
  risk,
  reason: `тестовый вердикт ${risk}`,
  reversible: risk !== "high",
});

// Элемент по умолчанию намеренно нейтральный: иначе он попадает под
// детерминированный пол и ломает тесты, которые проверяют не его.
const args = (overrides: Partial<Parameters<SecurityGate["check"]>[0]> = {}) => ({
  tool: "click",
  element: 'button "Показать ещё"',
  intent: "посмотреть больше товаров",
  url: "https://example.test/catalog",
  title: "Каталог",
  ...overrides,
});

describe("SecurityGate", () => {
  it("пропускает нечитающие состояние инструменты без вызова классификатора", async () => {
    const classifier = vi.fn<Classifier>();
    const gate = new SecurityGate(async () => "n", classifier);

    const decision = await gate.check(args({ tool: "observe" }));

    expect(decision.allowed).toBe(true);
    expect(classifier).not.toHaveBeenCalled();
  });

  it("не мутирующие инструменты вообще не считаются мутирующими", () => {
    const gate = new SecurityGate(async () => "n", vi.fn<Classifier>());
    expect(gate.isMutating("click")).toBe(true);
    expect(gate.isMutating("type_text")).toBe(true);
    expect(gate.isMutating("observe")).toBe(false);
    expect(gate.isMutating("query_page")).toBe(false);
    expect(gate.isMutating("screenshot")).toBe(false);
  });

  it("низкий риск проходит без вопроса человеку", async () => {
    const askHuman = vi.fn(async () => "n");
    const gate = new SecurityGate(askHuman, async () => verdict("low"));

    const decision = await gate.check(args({ intent: "открыть карточку товара" }));

    expect(decision.allowed).toBe(true);
    expect(askHuman).not.toHaveBeenCalled();
  });

  it("высокий риск без подтверждения не выполняется", async () => {
    const gate = new SecurityGate(async () => "n", async () => verdict("high"));

    const decision = await gate.check(args());

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // Агент должен понять, что это отказ человека, а не поломка инструмента.
      expect(decision.reason).toContain("отклонил");
      expect(decision.reason).toContain("не сбой");
    }
  });

  it("высокий риск выполняется после явного y", async () => {
    const gate = new SecurityGate(async () => "y", async () => verdict("high"));
    expect((await gate.check(args())).allowed).toBe(true);
  });

  it("на всё, кроме y, отвечает отказом", async () => {
    for (const answer of ["", "n", "N", "да", "yes", "Y "]) {
      const gate = new SecurityGate(async () => answer, async () => verdict("high"));
      const decision = await gate.check(args());
      const shouldPass = answer.trim().toLowerCase() === "y";
      expect(decision.allowed).toBe(shouldPass);
    }
  });

  it("кеширует вердикт по паре элемент+намерение", async () => {
    const gate = new SecurityGate(async () => "y", async () => verdict("low"));

    await gate.check(args());
    await gate.check(args());
    expect(gate.calls).toBe(1);

    // Другое намерение по тому же элементу - это другой вопрос, кеш не годится.
    await gate.check(args({ intent: "удалить заказ" }));
    expect(gate.calls).toBe(2);
  });

  it("после отказа не даёт обойти запрет действием с другой подписью", async () => {
    // Регрессия из живого прогона: гейт запретил "Очистить корзину" как необратимое,
    // а агент добился того же кнопкой "Уменьшить количество" - классификатор счёл её
    // обратимой, потому что судил подпись в отрыве от задачи. Корзина опустела.
    const answers = ["n", "n"];
    const askHuman = vi.fn(async () => answers.shift() ?? "n");
    const gate = new SecurityGate(askHuman, async (input) =>
      /очистить/i.test(input.element) ? verdict("high") : verdict("medium"),
    );
    gate.beginTask("удали все товары из корзины");

    const cleared = await gate.check(args({ element: 'button "Очистить корзину"', intent: "очистить корзину" }));
    expect(cleared.allowed).toBe(false);

    // Обходной путь: другая кнопка, тот же исход. Классификатор говорит medium.
    const workaround = await gate.check({
      ...args({ element: 'button "Уменьшить количество"', intent: "уменьшить до нуля" }),
    });
    expect(workaround.allowed).toBe(false);
    expect(askHuman).toHaveBeenCalledTimes(2);
  });

  it("явное разрешение снимает режим повышенной строгости", async () => {
    const answers = ["n", "y"];
    const askHuman = vi.fn(async () => answers.shift() ?? "n");
    // Первое действие необратимо, остальные - нет. Строгий режим включает именно отказ.
    let isFirst = true;
    const gate = new SecurityGate(askHuman, async () => {
      if (isFirst) {
        isFirst = false;
        return verdict("high");
      }
      return verdict("medium");
    });
    gate.beginTask("задача");

    // high -> спросили -> "n" -> запрет зафиксирован.
    expect((await gate.check(args({ intent: "первое действие" }))).allowed).toBe(false);
    // medium, но запрет в силе -> всё равно спрашиваем -> "y" -> разрешено.
    expect((await gate.check(args({ intent: "второе действие" }))).allowed).toBe(true);
    // Запрет снят осознанным разрешением, medium снова проходит молча.
    expect((await gate.check(args({ intent: "третье действие" }))).allowed).toBe(true);
    expect(askHuman).toHaveBeenCalledTimes(2);
  });

  it("запреты не переносятся между задачами", async () => {
    const gate = new SecurityGate(async () => "n", async () => verdict("medium"));
    gate.beginTask("первая задача");
    await gate.check(args({ intent: "что-то запретное" }));

    gate.beginTask("вторая задача");
    const fresh = await gate.check(args({ intent: "безобидное действие" }));
    expect(fresh.allowed).toBe(true);
  });

  describe("детерминированный пол", () => {
    // Классификатор на слабой модели плавает: одно и то же подтверждение возраста
    // получало то high, то low на идентичном промпте. Пол не даёт ему опустить
    // оценку ниже категории действия.
    const alwaysLow: Classifier = async () => verdict("low");

    const blocked = async (element: string): Promise<boolean> => {
      const gate = new SecurityGate(async () => "n", alwaysLow);
      gate.beginTask("любая задача");
      return !(await gate.check(args({ element }))).allowed;
    };

    it("останавливает необратимое, даже когда классификатор говорит low", async () => {
      for (const element of [
        'button "Оплатить 1 920 ₽"',
        'button "Отправить отклик"',
        'button "Откликнуться"',
        'button "Очистить корзину"',
        'button "Удалить письмо"',
        'button "Уже есть" (окно "Вам уже есть 18 лет?")',
        'button "Принимаю условия использования"',
        'button "Опубликовать"',
        'button "Pay now"',
        'button "Submit application"',
      ]) {
        expect(await blocked(element), element).toBe(true);
      }
    });

    it("не трогает обычные действия", async () => {
      for (const element of [
        'link "Главная страница"',
        'searchbox "Поиск"',
        'button "В корзину"',
        'button "Пропустить"',
        'button "Показать ещё"',
        'link "Каталог"',
      ]) {
        expect(await blocked(element), element).toBe(false);
      }
    });
  });

  it("падение классификатора закрывает гейт, а не открывает", async () => {
    const boom: Classifier = async () => {
      throw new Error("сеть недоступна");
    };
    const askHuman = vi.fn(async () => "n");

    const decision = await new SecurityGate(askHuman, boom).check(args());

    expect(decision.allowed).toBe(false);
    // Человека всё равно спросили: отказ классификатора не должен быть тихим.
    expect(askHuman).toHaveBeenCalledOnce();
  });

  it("при упавшем классификаторе человек может разрешить действие явно", async () => {
    const boom: Classifier = async () => {
      throw new Error("сеть недоступна");
    };
    expect((await new SecurityGate(async () => "y", boom).check(args())).allowed).toBe(true);
  });
});
