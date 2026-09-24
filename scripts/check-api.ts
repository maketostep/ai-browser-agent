/**
 * Проверка связности с провайдером: авторизация, tool calling, стриминг.
 * Отделяет "шлюз не принимает наш запрос" от "агент плохо рассуждает".
 */
import { client } from "../src/agent/client.js";
import { provider } from "../src/agent/provider.js";
import { requireContent } from "../src/agent/retry.js";

process.loadEnvFile(".env");

const config = provider();
console.log(`провайдер: ${config.label}, модель: ${config.mainModel}\n`);

// 1. Простой вызов: проходит ли авторизация вообще.
console.log("1) простой вызов...");
try {
  const response = requireContent(
    await client().messages.create({
    model: config.mainModel,
    max_tokens: 64,
    messages: [{ role: "user", content: "Ответь одним словом: работает?" }],
    }),
  );
  const text = response.content.find((b) => b.type === "text");
  console.log(`   ok, stop_reason=${response.stop_reason}`);
  console.log(`   ответ: ${text && text.type === "text" ? text.text.trim() : "(нет текста)"}`);
  console.log(`   usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
} catch (err) {
  console.log(`   ПРОВАЛ: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
}

// 2. Tool calling: на этом держится весь цикл агента.
console.log("\n2) вызов инструмента...");
try {
  const response = requireContent(
    await client().messages.create({
    model: config.mainModel,
    max_tokens: 256,
    tools: [
      {
        name: "click",
        description: "Кликнуть по элементу страницы",
        input_schema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Реф элемента, например e12" },
            intent: { type: "string", description: "Что делаешь и обратимо ли это" },
          },
          required: ["ref", "intent"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          'На странице есть элементы:\n[e1] link "Главная"\n[e7] button "Найти"\n' +
          "Нажми кнопку поиска.",
      },
    ],
    }),
  );
  const use = response.content.find((b) => b.type === "tool_use");
  if (use && use.type === "tool_use") {
    console.log(`   ok, вызван ${use.name} с ${JSON.stringify(use.input)}`);
  } else {
    console.log(`   ВНИМАНИЕ: инструмент не вызван, stop_reason=${response.stop_reason}`);
  }
} catch (err) {
  console.log(`   ПРОВАЛ: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
}

// 3. Стриминг: в терминале агент печатается по токенам.
console.log("\n3) стриминг...");
try {
  const stream = client().messages.stream({
    model: config.mainModel,
    max_tokens: 100,
    messages: [{ role: "user", content: "Посчитай вслух от одного до пяти." }],
  });
  let chunks = 0;
  stream.on("text", () => chunks++);
  const final = await stream.finalMessage();
  console.log(`   ok, дельт получено: ${chunks}, stop_reason=${final.stop_reason}`);
} catch (err) {
  console.log(`   ПРОВАЛ: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
}
