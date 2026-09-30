/**
 * Неинтерактивный прогон одной задачи. Для отладки и дымовых проверок.
 *
 * Security-гейт здесь автоматически ОТКЛОНЯЕТ всё высокорисковое: прогон идёт без
 * человека, а молча подтверждать необратимые действия нельзя. Для настоящей работы
 * есть REPL (npm run dev), где отвечает человек.
 *
 *   npm run task -- "открой example.com и расскажи, что там"
 *
 * Код выхода 0 только если агент дошёл до finish: скрипту и CI этого достаточно.
 */
import { BrowserSession } from "../src/browser/session.js";
import { Actions } from "../src/browser/actions.js";
import { SecurityGate } from "../src/agent/security.js";
import { runTask } from "../src/agent/loop.js";
import { provider } from "../src/agent/provider.js";
import type { AskHuman } from "../src/types.js";
import * as ui from "../src/ui/render.js";

try {
  process.loadEnvFile(".env");
} catch {
  // Файла нет - ключ приходит из окружения, provider() ниже это проверит.
}

const args = process.argv.slice(2);
// --approve: заранее согласиться на высокорисковые действия. Только для
// наблюдаемой отладки, когда человек смотрит на экран. По умолчанию - отказ.
const autoApprove = args.includes("--approve");
const task = args.filter((a) => a !== "--approve").join(" ").trim();

if (!task) {
  console.error('Укажи задачу: npx tsx scripts/run-task.ts [--approve] "..."');
  process.exit(1);
}

const config = provider();
ui.banner([
  `Прогон без человека. Провайдер: ${config.label}, модель: ${config.mainModel}`,
  autoApprove
    ? `РЕЖИМ --approve: высокорисковые действия будут ВЫПОЛНЕНЫ без спроса.`
    : `Высокорисковые действия будут отклонены автоматически.`,
  ``,
  `Задача: ${task}`,
]);

const answer = autoApprove ? "y" : "n";
const askHuman: AskHuman = async (question) => {
  ui.warn(`вопрос без человека: ${question.trim()} -> автоответ "${answer}"`);
  return answer;
};

const session = new BrowserSession(askHuman);
await session.start("about:blank");

let outcome;
try {
  outcome = await runTask(task, {
    actions: new Actions(session),
    gate: new SecurityGate(askHuman),
    askHuman,
  });
} finally {
  await session.close();
}
process.exitCode = outcome === "finished" ? 0 : 1;
