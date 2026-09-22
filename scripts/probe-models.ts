/**
 * Какие модели реально отвечают на текущем эндпоинте и умеют ли они вызывать
 * инструменты. Tool calling - обязательное условие: без него агент не работает.
 */
import { client } from "../src/agent/client.js";
import { provider } from "../src/agent/provider.js";

process.loadEnvFile(".env");

const CANDIDATES = [
  "glm-4.6",
  "glm-4.7-flash",
  "glm-4.5-flash",
  "glm-4-flash",
  "glm-4.5-air",
];

const TOOL = {
  name: "click",
  description: "Кликнуть по элементу страницы",
  input_schema: {
    type: "object" as const,
    properties: {
      ref: { type: "string", description: "Реф элемента, например e12" },
      intent: { type: "string", description: "Что делаешь и обратимо ли это" },
    },
    required: ["ref", "intent"],
  },
};

console.log(`эндпоинт: ${provider().baseURL}\n`);

for (const model of CANDIDATES) {
  process.stdout.write(`${model.padEnd(16)} `);
  try {
    const response = await client().messages.create({
      model,
      max_tokens: 200,
      tools: [TOOL],
      messages: [
        {
          role: "user",
          content: 'Элементы:\n[e1] link "Главная"\n[e7] button "Найти"\nНажми кнопку поиска.',
        },
      ],
    });
    const use = response.content.find((b) => b.type === "tool_use");
    if (use && use.type === "tool_use") {
      console.log(`OK, tool_use: ${JSON.stringify(use.input)}`);
    } else {
      console.log(`отвечает, но инструмент НЕ вызвала (stop_reason=${response.stop_reason})`);
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const code = /"code":"(\d+)"/.exec(raw)?.[1];
    const message = /"message":"([^"]{0,90})/.exec(raw)?.[1];
    console.log(`ОТКАЗ ${raw.slice(0, 3)}${code ? ` [${code}]` : ""} ${message ?? raw.slice(0, 80)}`);
  }
}
