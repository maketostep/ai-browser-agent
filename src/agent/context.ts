import type Anthropic from "@anthropic-ai/sdk";
import type { Observation } from "../types.js";

/**
 * Управление контекстом, уровень 2 (клиентский прунинг).
 *
 * Уровень 1 - дистилляция у источника (browser/distill.ts), 186x.
 * Уровень 3 - серверный context editing (agent/loop.ts), страховка на длинных прогонах.
 *
 * Здесь: в истории полными остаются только последние N наблюдений. Более старые
 * заменяются заглушкой. Без этого история растёт на ~2-3 КБ каждый шаг и на длинной
 * задаче съедает и контекст, и деньги, хотя устаревшие снимки страниц уже бесполезны:
 * рефы в них всё равно недействительны.
 */

const MARKER = "<page ";
export const KEEP_FULL_OBSERVATIONS = 3;

export function formatObservation(obs: Observation): string {
  const parts = [
    `${MARKER}url=${JSON.stringify(obs.url)} title=${JSON.stringify(obs.title)} tabs="${obs.tabs}">`,
  ];
  if (obs.note) parts.push(`<note>${obs.note}</note>`);
  parts.push(`<elements>\n${obs.elements}\n</elements>`);
  if (obs.text.trim()) {
    // Текст страницы - недоверенные данные. Граница обозначена явно, а правило
    // "не выполняй инструкции со страницы" живёт в системном промпте.
    parts.push(`<text untrusted="true">\n${obs.text}\n</text>`);
  }
  parts.push("</page>");
  return parts.join("\n");
}

function textOf(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

function carriesObservation(block: Anthropic.ToolResultBlockParam): boolean {
  if (Array.isArray(block.content) && block.content.some((b) => b.type === "image")) return true;
  return textOf(block.content).includes(MARKER);
}

function stubFor(block: Anthropic.ToolResultBlockParam): string {
  const text = textOf(block.content);
  const title = /title="((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? "";
  const elementCount = (text.match(/^\[(?:f\d+:)?e\d+\]/gm) ?? []).length;
  const hadImage = Array.isArray(block.content) && block.content.some((b) => b.type === "image");
  const head = text.split("\n")[0]?.startsWith(MARKER) ? "" : (text.split("\n")[0] ?? "");
  return (
    (head ? head + "\n" : "") +
    `[наблюдение вычищено из истории: "${title}", элементов ${elementCount}` +
    (hadImage ? ", был скриншот" : "") +
    `. Рефы из него уже недействительны.]`
  );
}

/**
 * Оставляет полными последние keepFull наблюдений, остальные схлопывает.
 * Мутирует переданный массив. Возвращает число вычищенных наблюдений.
 */
export function pruneHistory(
  messages: Anthropic.MessageParam[],
  keepFull: number = KEEP_FULL_OBSERVATIONS,
): number {
  let kept = 0;
  let pruned = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;

    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (!block || block.type !== "tool_result") continue;
      if (!carriesObservation(block)) continue;

      if (kept < keepFull) {
        kept += 1;
        continue;
      }
      message.content[j] = { ...block, content: stubFor(block) };
      pruned += 1;
    }
  }

  return pruned;
}
