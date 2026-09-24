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
  /** Отмена текущей задачи. null - задачи нет, Ctrl+C означает выход. */
  let current: AbortController | null = null;
  // Вопрос гейта привязан к задаче: отмена снимает его, и действие не выполняется.
  const askHuman: AskHuman = async (question) => await rl.question(question, { signal: current?.signal });

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
    "Пиши задачу текстом. Ctrl+C во время задачи - отменить её и дать другую.",
    "exit или Ctrl+C в ожидании задачи - выход.",
  ]);

  await session.start(process.env["START_URL"] ?? "about:blank");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    rl.close();
    await session.close();
  };
  const onInterrupt = (): void => {
    if (current && !current.signal.aborted) {
      ui.warn("Отменяю задачу...");
      current.abort();
      return;
    }
    void shutdown().then(() => process.exit(0));
  };
  // В TTY Ctrl+C перехватывает readline, а не процесс; process - для запуска без терминала.
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  try {
    for (;;) {
      const task = (await rl.question("\n\x1b[1mYou:\x1b[0m ")).trim();
      if (!task) continue;
      if (task === "exit" || task === "quit") break;

      const started = Date.now();
      current = new AbortController();
      try {
        await runTask(task, { actions, gate, askHuman }, current.signal);
      } catch (err) {
        ui.error(`Прогон прерван: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        current = null;
      }
      ui.info(`прогон занял ${((Date.now() - started) / 1000).toFixed(1)} с`);
    }
  } finally {
    await shutdown();
  }
}

await main();
