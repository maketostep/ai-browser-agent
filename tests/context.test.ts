import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { formatObservation, pruneHistory } from "../src/agent/context.js";
import type { Observation } from "../src/types.js";

const observation = (n: number): Observation => ({
  url: `https://example.test/${n}`,
  title: `Страница ${n}`,
  elements: `[e1] button "Кнопка ${n}"\n[e2] link "Ссылка ${n}"`,
  text: `текст страницы ${n}`,
  tabs: 1,
});

const toolResult = (id: string, obs: Observation): Anthropic.MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: `Клик выполнен\n\n${formatObservation(obs)}` }],
});

const firstBlockText = (message: Anthropic.MessageParam | undefined): string => {
  if (!message || !Array.isArray(message.content)) return "";
  const block = message.content[0];
  if (!block || block.type !== "tool_result") return "";
  return typeof block.content === "string" ? block.content : "";
};

describe("formatObservation", () => {
  it("кладёт адрес, заголовок и элементы в размеченный блок", () => {
    const formatted = formatObservation(observation(1));
    expect(formatted).toContain('<page url="https://example.test/1"');
    expect(formatted).toContain('title="Страница 1"');
    expect(formatted).toContain('[e1] button "Кнопка 1"');
  });

  it("помечает текст страницы как недоверенный", () => {
    expect(formatObservation(observation(1))).toContain('<text untrusted="true">');
  });

  it("не печатает пустую заметку", () => {
    expect(formatObservation(observation(1))).not.toContain("<note>");
    expect(formatObservation({ ...observation(1), note: "новая вкладка" })).toContain(
      "<note>новая вкладка</note>",
    );
  });
});

describe("pruneHistory", () => {
  it("оставляет полными последние три наблюдения", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 1; i <= 6; i++) messages.push(toolResult(`t${i}`, observation(i)));

    const pruned = pruneHistory(messages);

    expect(pruned).toBe(3);
    // Свежие три целы.
    for (const i of [4, 5, 6]) {
      expect(firstBlockText(messages[i - 1])).toContain(`[e1] button "Кнопка ${i}"`);
    }
    // Старые схлопнуты, но заглушка честно говорит, что там было.
    for (const i of [1, 2, 3]) {
      const text = firstBlockText(messages[i - 1]);
      expect(text).toContain("наблюдение вычищено из истории");
      expect(text).toContain(`"Страница ${i}"`);
      expect(text).toContain("элементов 2");
      expect(text).not.toContain(`[e1] button "Кнопка ${i}"`);
    }
  });

  it("повторный вызов ничего не ломает и не чистит лишнего", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 1; i <= 5; i++) messages.push(toolResult(`t${i}`, observation(i)));

    expect(pruneHistory(messages)).toBe(2);
    expect(pruneHistory(messages)).toBe(0);
    expect(firstBlockText(messages[4])).toContain('[e1] button "Кнопка 5"');
  });

  it("не трогает результаты без наблюдения, например ответ суб-агента", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "В выдаче три позиции" }] },
    ];
    for (let i = 1; i <= 4; i++) messages.push(toolResult(`t${i}`, observation(i)));

    pruneHistory(messages);

    expect(firstBlockText(messages[0])).toBe("В выдаче три позиции");
  });

  it("схлопывает и скриншоты, отмечая что картинка там была", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "s1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
              { type: "text", text: formatObservation(observation(9)) },
            ],
          },
        ],
      },
    ];
    for (let i = 1; i <= 3; i++) messages.push(toolResult(`t${i}`, observation(i)));

    expect(pruneHistory(messages)).toBe(1);
    const text = firstBlockText(messages[0]);
    expect(text).toContain("был скриншот");
    expect(text).toContain('"Страница 9"');
  });
});
