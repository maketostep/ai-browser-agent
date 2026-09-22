import { createInterface } from "node:readline/promises";
import { BrowserSession } from "./browser/session.js";
import { Actions } from "./browser/actions.js";
import { SecurityGate } from "./agent/security.js";
import { runTask } from "./agent/loop.js";
import { provider } from "./agent/provider.js";
import type { AskHuman } from "./types.js";
import * as ui from "./ui/render.js";

// .env читается штатным Node, без зависимости на dotenv.
try {
  process.loadEnvFile(".env");
} catch {
  // Файла нет - значит ключ приходит из окружения. Проверка ниже это поймает.
}

async function main(): Promise<void> {
  let config;
  try {
    config = provider();
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const askHuman: AskHuman = async (question) => await rl.question(question);

  const session = new BrowserSession(askHuman);
  const actions = new Actions(session);
  const gate = new SecurityGate(askHuman);

  const disabled = Object.entries(config.features)
    .filter(([, on]) => !on)
    .map(([name]) => name);

  ui.banner([
    "\x1b[1mAI Browser Agent\x1b[0m",
    "",
    `Провайдер: ${config.label}   модель: ${config.mainModel}   суб-агенты: ${config.subModel}`,
    ...(disabled.length > 0 ? [`Недоступно у провайдера: ${disabled.join(", ")}`] : []),
    "",
    "Открываю браузер. Если нужен вход в аккаунт - залогинься вручную прямо в нём,",
    "сессия сохранится в профиле и переживёт перезапуск.",
    "",
    "Пиши задачу текстом. exit - выход.",
  ]);

  await session.start(process.env["START_URL"] ?? "about:blank");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    rl.close();
    await session.close();
  };
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });

  try {
    for (;;) {
      const task = (await rl.question("\n\x1b[1mYou:\x1b[0m ")).trim();
      if (!task) continue;
      if (task === "exit" || task === "quit") break;

      const started = Date.now();
      try {
        await runTask(task, { actions, gate, askHuman });
      } catch (err) {
        ui.error(`Прогон прерван: ${err instanceof Error ? err.message : String(err)}`);
      }
      ui.info(`прогон занял ${((Date.now() - started) / 1000).toFixed(1)} с`);
    }
  } finally {
    await shutdown();
  }
}

await main();
