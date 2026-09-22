import type Anthropic from "@anthropic-ai/sdk";
import type { Actions } from "../browser/actions.js";
import type { SecurityGate } from "./security.js";
import { queryPage } from "./subagents.js";
import { formatObservation } from "./context.js";
import type { AskHuman, ToolResult } from "../types.js";
import * as ui from "../ui/render.js";

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
});

const REF_DESC = "Реф элемента из ПОСЛЕДНЕГО наблюдения, например e12 или f1:e3";
const INTENT_DESC =
  "Одной фразой: что ты делаешь этим действием и обратимо ли это. Обязательно.";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Перейти по адресу. Адрес бери из задачи пользователя или из href на странице.",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "go_back",
    description: "Вернуться на предыдущую страницу.",
    input_schema: obj({}, []),
  },
  {
    name: "observe",
    description: "Пересобрать наблюдение текущей страницы. Нужно после ожидания или если страница могла измениться сама.",
    input_schema: obj({}, []),
  },
  {
    name: "click",
    description: "Кликнуть по элементу.",
    input_schema: obj(
      { ref: { type: "string", description: REF_DESC }, intent: { type: "string", description: INTENT_DESC } },
      ["ref", "intent"],
    ),
  },
  {
    name: "type_text",
    description: "Ввести текст в поле. Существующее содержимое заменяется.",
    input_schema: obj(
      {
        ref: { type: "string", description: REF_DESC },
        text: { type: "string" },
        press_enter: { type: "boolean", description: "Нажать Enter после ввода" },
        intent: { type: "string", description: INTENT_DESC },
      },
      ["ref", "text", "press_enter", "intent"],
    ),
  },
  {
    name: "select_option",
    description: "Выбрать вариант в выпадающем списке по значению или видимой подписи.",
    input_schema: obj(
      {
        ref: { type: "string", description: REF_DESC },
        value: { type: "string" },
        intent: { type: "string", description: INTENT_DESC },
      },
      ["ref", "value", "intent"],
    ),
  },
  {
    name: "scroll",
    description: "Прокрутить страницу или подскроллить к элементу.",
    input_schema: obj(
      {
        direction: { type: "string", enum: ["up", "down"] },
        ref: { type: "string", description: "Необязательно: подскроллить к этому элементу" },
      },
      ["direction"],
    ),
  },
  {
    name: "wait",
    description: "Подождать загрузки или анимации. Максимум 15 секунд.",
    input_schema: obj({ seconds: { type: "number" }, reason: { type: "string" } }, ["seconds", "reason"]),
  },
  {
    name: "screenshot",
    description:
      "Получить картинку вьюпорта. Бери, когда дело в вёрстке и это надо увидеть глазами: " +
      "перекрытая кнопка, капча, картиночное меню. Стоит токенов, не злоупотребляй.",
    input_schema: obj({ reason: { type: "string" } }, ["reason"]),
  },
  {
    name: "query_page",
    description:
      "Задать вопрос суб-агенту, который читает страницу подробнее, чем сжатое наблюдение. " +
      "Для деталей: перечислить позиции с ценами, разобрать таблицу, понять состояние счётчика.",
    input_schema: obj({ question: { type: "string" } }, ["question"]),
  },
  {
    name: "list_tabs",
    description: "Показать открытые вкладки.",
    input_schema: obj({}, []),
  },
  {
    name: "switch_tab",
    description: "Переключиться на вкладку по индексу из list_tabs.",
    input_schema: obj({ index: { type: "number" } }, ["index"]),
  },
  {
    name: "ask_user",
    description:
      "Спросить человека. Только когда без него правда нельзя: нужны данные, которых " +
      "нет на странице, или требуется выбор, который ты не вправе сделать сам.",
    input_schema: obj({ question: { type: "string" } }, ["question"]),
  },
  {
    name: "finish",
    description: "Завершить задачу и отчитаться: что сделано, что нет и почему.",
    input_schema: obj({ summary: { type: "string" } }, ["summary"]),
  },
];

export type ToolDeps = {
  actions: Actions;
  gate: SecurityGate;
  askHuman: AskHuman;
};

export type Dispatched = {
  /** Тип берём из SDK: tool_result принимает уже текст/картинку, но не любой блок. */
  content: Anthropic.ToolResultBlockParam["content"];
  isError: boolean;
  /** Заполнено, когда агент вызвал finish */
  finished?: string;
};

const render = (result: ToolResult): Dispatched => ({
  content: `${result.ok ? result.message : `ОШИБКА ${result.error}: ${result.message}`}\n\n${formatObservation(result.observation)}`,
  isError: !result.ok,
});

export async function dispatch(
  name: string,
  raw: unknown,
  deps: ToolDeps,
): Promise<Dispatched> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const { actions, gate, askHuman } = deps;

  // Единая точка входа всех инструментов - здесь и гарантируем, что агенту есть
  // чем работать. Иначе закрытая вкладка превращает любой его ход в падение.
  await actions.ensureBrowser();

  // Гейт стоит между решением модели и действием браузера. Агент не может его
  // обойти: проверка выполняется здесь, а не по его просьбе.
  if (gate.isMutating(name)) {
    const ref = typeof input["ref"] === "string" ? input["ref"] : "";
    const element = ref ? await actions.describe(ref) : String(input["url"] ?? name);
    // Только url и title: пересборка наблюдения здесь переразметила бы рефы и
    // увела клик на другой элемент. Полное наблюдение собираем уже после решения.
    const page = await actions.pageInfo();
    const decision = await gate.check({
      tool: name,
      element,
      intent: String(input["intent"] ?? "(намерение не указано)"),
      url: page.url,
      title: page.title,
    });
    if (!decision.allowed) {
      return {
        content: `ОШИБКА declined: ${decision.reason}\n\n${formatObservation(await actions.observe())}`,
        isError: true,
      };
    }
  }

  switch (name) {
    case "navigate":
      return render(await actions.navigate(String(input["url"] ?? "")));

    case "go_back":
      return render(await actions.goBack());

    case "observe":
      return render({ ok: true, message: "Наблюдение обновлено", observation: await actions.observe() });

    case "click":
      return render(await actions.click(String(input["ref"] ?? "")));

    case "type_text":
      return render(
        await actions.typeText(
          String(input["ref"] ?? ""),
          String(input["text"] ?? ""),
          Boolean(input["press_enter"]),
        ),
      );

    case "select_option":
      return render(
        await actions.selectOption(String(input["ref"] ?? ""), String(input["value"] ?? "")),
      );

    case "scroll":
      return render(
        await actions.scroll(
          input["direction"] === "up" ? "up" : "down",
          typeof input["ref"] === "string" ? input["ref"] : undefined,
        ),
      );

    case "wait":
      return render(await actions.wait(Number(input["seconds"] ?? 2), String(input["reason"] ?? "")));

    case "screenshot": {
      const shot = await actions.screenshot();
      const observation = await actions.observe();
      ui.info(`скриншот ${(shot.bytes / 1024).toFixed(0)} КБ`);
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.base64 } },
          { type: "text", text: formatObservation(observation) },
        ],
        isError: false,
      };
    }

    case "query_page": {
      // Тяжёлое чтение уходит суб-агенту. В основной контекст вернётся только ответ.
      const answer = await queryPage(String(input["question"] ?? ""), await actions.deepContext());
      return { content: answer, isError: false };
    }

    case "list_tabs":
      return render(await actions.listTabs());

    case "switch_tab":
      return render(await actions.switchTab(Number(input["index"] ?? -1)));

    case "ask_user": {
      const question = String(input["question"] ?? "");
      console.log(`\n\x1b[1m❓ Агент спрашивает:\x1b[0m ${question}`);
      const answer = await askHuman("Ответ: ");
      return { content: `Человек ответил: ${answer}`, isError: false };
    }

    case "finish": {
      const summary = String(input["summary"] ?? "");
      return { content: "Задача завершена.", isError: false, finished: summary };
    }

    default:
      return { content: `Инструмента ${name} не существует.`, isError: true };
  }
}
