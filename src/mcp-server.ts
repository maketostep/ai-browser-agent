import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, dispatch, type Dispatched, type ToolDeps } from "./agent/tools.js";
import type { Classifier } from "./agent/security.js";
import type { AskHuman } from "./types.js";

/**
 * MCP-вход: те же инструменты и тот же security-гейт, но решения принимает клиент
 * (Claude Code), а не наш цикл из agent/loop.ts.
 *
 * Без API-ключа здесь недоступно всё, что само зовёт модель: query_page и классификатор
 * риска. ask_user и finish не нужны - клиент сам разговаривает с человеком.
 */
const EXCLUDED = new Set(["query_page", "ask_user", "finish"]);

export const MCP_TOOLS = TOOLS.filter((tool) => !EXCLUDED.has(tool.name));

/**
 * Классификатор-заглушка: риск решает только детерминированный пол и режим после
 * отказа. Вызвать модель для оценки риска без API-ключа нечем.
 */
export const floorOnlyClassifier: Classifier = async () => ({
  risk: "low",
  reason: "классификатор риска в MCP-режиме недоступен, решает детерминированный пол",
  reversible: true,
});

const ANSI = /\x1b\[[0-9;]*m/g;
const CONTEXT_LINES = 20;

/**
 * stdout в MCP занят протоколом: любой console.log его ломает. Печать уходит в stderr,
 * а последние строки копятся, чтобы вопрос человеку пришёл вместе с тем, что гейт
 * про действие напечатал.
 */
export function redirectConsole(): () => string {
  // ponytail: берём хвост из 20 строк, а не строки конкретного вопроса; если в
  // вопрос попадает лишнее, гейту нужен явный канал контекста.
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    process.stderr.write(line + "\n");
    lines.push(line.replace(ANSI, ""));
    if (lines.length > CONTEXT_LINES) lines.shift();
  };
  return () => lines.splice(0).join("\n").trim();
}

const YES_NO = /\[y\/N\]/;

/**
 * Вопрос человеку через MCP elicitation. Клиент без elicitation или отказ = "нет":
 * гейт обязан закрываться, а не открываться.
 */
export function elicitingAsk(server: Server, drain: () => string = () => ""): AskHuman {
  return async (question) => {
    const message = [drain(), question].filter(Boolean).join("\n\n");
    const confirm = YES_NO.test(question);
    try {
      const result = await server.elicitInput({
        message,
        requestedSchema: {
          type: "object",
          properties: confirm
            ? { confirm: { type: "boolean", title: "Подтвердить" } }
            : { answer: { type: "string", title: "Ответ" } },
          required: [confirm ? "confirm" : "answer"],
        },
      });
      if (result.action !== "accept") return "";
      if (confirm) return result.content?.["confirm"] === true ? "y" : "n";
      return String(result.content?.["answer"] ?? "");
    } catch (err) {
      console.log(`Спросить человека не удалось (${err instanceof Error ? err.message : String(err)}), считаю отказом`);
      return "";
    }
  };
}

function toMcp(result: Dispatched): CallToolResult {
  const blocks = typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : result.content ?? [];
  const content: CallToolResult["content"] = [];
  for (const block of blocks) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.source.type === "base64") {
      content.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    }
  }
  return { content, isError: result.isError };
}

export function createMcpServer(): Server {
  return new Server({ name: "ai-browser-agent", version: "1.0.0" }, { capabilities: { tools: {} } });
}

export function registerTools(server: Server, deps: ToolDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input } = request.params;
    if (EXCLUDED.has(name)) {
      return { content: [{ type: "text", text: `Инструмента ${name} в MCP-режиме нет.` }], isError: true };
    }
    try {
      return toMcp(await dispatch(name, input, deps));
    } catch (err) {
      // Ошибка браузера - информация для модели, а не падение сервера.
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `ОШИБКА: ${message}` }], isError: true };
    }
  });
}
