import type Anthropic from "@anthropic-ai/sdk";
import { withRetry, isAbort, MAIN_BACKOFF } from "./retry.js";
import { client } from "./client.js";
import { provider } from "./provider.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, dispatch, type ToolDeps } from "./tools.js";
import { formatObservation, pruneHistory } from "./context.js";
import * as ui from "../ui/render.js";

/** Страховка от зацикливания: без finish агент всё равно остановится и отчитается. */
const MAX_STEPS = 40;
/** После стольких подряд неудач по одному рефу агента принудительно разворачивают. */
const MAX_REF_FAILURES = 3;

/**
 * Обнаружение цикла по повторам одного и того же действия.
 *
 * Счётчика неудач мало. Живой прогон по почте дал восемь шагов подряд: клик по письму
 * открывал постороннюю вкладку, агент возвращался и кликал снова. Каждый клик формально
 * УСПЕШЕН, поэтому счётчик неудач сбрасывался, и цикл крутился бы до исчерпания лимита
 * шагов. Ловить надо бесполезный успех, а не только провал.
 */
export const LOOP_WINDOW = 6;
export const LOOP_WARN_AT = 3;
export const LOOP_STOP_AT = 5;

/** Ключ действия по сути, без формулировок: intent агент меняет, а делает то же самое. */
export function actionSignature(name: string, input: Record<string, unknown>): string {
  const parts = [name];
  for (const field of ["ref", "url", "index", "direction", "value"]) {
    const value = input[field];
    if (value !== undefined) parts.push(`${field}=${String(value)}`);
  }
  return parts.join("|");
}

/** Уровень 3 управления контекстом. Выключается сам, если бета недоступна аккаунту. */
let serverContextEditing = !process.env["DISABLE_SERVER_CONTEXT_EDITING"];

function isBetaRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /beta|context_management|context-management|unsupported/i.test(message);
}

/**
 * Вторая линия обороны поверх ретраев SDK. На бесплатном тире 529 прилетает пачками,
 * и ронять из-за этого всю многошаговую задачу - худшее, что можно сделать: агент
 * теряет весь прогресс на ровном месте.
 */
async function requestWithRetry(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal | undefined,
): Promise<Anthropic.Message> {
  const { mainModel, fallbackModel } = provider();
  return await withRetry("основной цикл", MAIN_BACKOFF, (attempt) => {
    const model = modelForAttempt(mainModel, fallbackModel, attempt);
    if (model !== mainModel && attempt === 1) ui.warn(`переключаюсь на запасную модель ${model}`);
    return requestTurn(messages, model, signal);
  });
}

/**
 * Первая попытка шага - на основной модели, повторы после временного сбоя - на
 * запасной. Живой прогон: Nvidia за бесплатной моделью отдавала overloaded_error,
 * а свободная модель рядом простаивала. Следующий шаг снова начинается с основной.
 */
export function modelForAttempt(main: string, fallback: string | undefined, attempt: number): string {
  return attempt > 0 && fallback ? fallback : main;
}

async function requestTurn(
  messages: Anthropic.MessageParam[],
  model: string,
  signal: AbortSignal | undefined,
): Promise<Anthropic.Message> {
  const config = provider();
  const caps = config.features;

  const params = {
    model,
    max_tokens: 16000,
    // Стабильный префикс: системный промпт и набор инструментов не меняются за прогон,
    // поэтому кешируются, а изменчивые наблюдения идут после брейкпоинта. Там, где
    // кеширования нет, промпт уходит обычной строкой.
    system: caps.promptCaching
      ? [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }]
      : SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
    // Браузер последователен: два действия одновременно сделать нельзя.
    tool_choice: caps.disableParallelToolUse
      ? { type: "auto" as const, disable_parallel_tool_use: true }
      : undefined,
    // Расширения Anthropic. На совместимом шлюзе их просто не отправляем: лишнее
    // поле там либо игнорируется, либо роняет запрос в 400.
    thinking: caps.adaptiveThinking
      ? { type: "adaptive" as const, display: "summarized" as const }
      : undefined,
    output_config: caps.effort ? { effort: "high" as const } : undefined,
  };

  if (caps.contextManagement && serverContextEditing) {
    try {
      const stream = client().beta.messages.stream({
        ...params,
        betas: ["context-management-2025-06-27"],
        context_management: { edits: [{ type: "clear_tool_uses_20250919" as const }] },
      }, { signal });
      stream.on("text", (delta) => process.stdout.write(delta));
      return (await stream.finalMessage()) as unknown as Anthropic.Message;
    } catch (err) {
      if (!isBetaRejection(err)) throw err;
      serverContextEditing = false;
      ui.warn("Серверный context editing недоступен, работаем на клиентском прунинге");
    }
  }

  const stream = client().messages.stream(params, { signal });
  stream.on("text", (delta) => process.stdout.write(delta));
  return await stream.finalMessage();
}

const cancelled = (): "cancelled" => {
  ui.warn("Задача отменена. Можно дать новую.");
  return "cancelled";
};

/**
 * signal - отмена человеком (Ctrl+C в терминале). Проверяется перед каждым шагом,
 * прерывает запрос к модели на лету и вопрос гейта. Уже начатое действие в браузере
 * доигрывается: обрывать клик на середине опаснее, чем дождаться его.
 */
export async function runTask(task: string, deps: ToolDeps, signal?: AbortSignal): Promise<"cancelled" | void> {
  if (signal?.aborted) return cancelled();
  // Гейт должен знать задачу целиком: без неё безобидная кнопка неотличима от шага
  // к разрушению. И запреты одной задачи не должны переноситься в следующую.
  deps.gate.beginTask(task);

  const messages: Anthropic.MessageParam[] = [];

  // Первое наблюдение отдаём ДО первого хода агента. Это прямое следствие persistent
  // session: пользователь мог оставить открытой нужную страницу, и начинать с пустого
  // места означало бы её выбросить.
  await deps.actions.ensureBrowser();
  const bootstrap = await deps.actions.observe();
  messages.push({
    role: "user",
    content:
      `Задача: ${task}\n\n` +
      `Сейчас в браузере открыто вот это. Действуй.\n\n` +
      formatObservation(bootstrap),
  });

  const refFailures = new Map<string, number>();
  const recentActions: string[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal?.aborted) return cancelled();
    const pruned = pruneHistory(messages);
    if (pruned > 0) ui.info(`прунинг контекста: схлопнуто наблюдений ${pruned}`);

    let response: Anthropic.Message;
    try {
      response = await requestWithRetry(messages, signal);
    } catch (err) {
      if (isAbort(err)) return cancelled();
      ui.error(`Запрос к модели не прошёл: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    ui.usage({
      step,
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    });

    for (const block of response.content) {
      if (block.type === "thinking") ui.thinking(block.thinking);
    }

    if (response.stop_reason === "refusal") {
      ui.error("Модель отклонила запрос.");
      return;
    }

    // Ассистентский ход возвращаем в историю целиком, включая thinking-блоки.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") {
      continue;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Агент заговорил, но не действует. Считаем это концом хода.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) console.log();
      ui.warn("Агент остановился, не вызвав finish. Задача считается незавершённой.");
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished: string | undefined;

    for (const use of toolUses) {
      ui.toolCall(use.name, use.input);

      let outcome;
      try {
        outcome = await dispatch(use.name, use.input, deps);
      } catch (err) {
        // Отмена во время вопроса гейта: действие не выполнено и одобрением не считается.
        if (isAbort(err)) return cancelled();
        outcome = {
          content: `Инструмент упал: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      const preview = typeof outcome.content === "string" ? outcome.content.split("\n")[0]! : "[картинка + наблюдение]";
      ui.toolResult(!outcome.isError, preview);

      // Повтор одного и того же действия, успешного или нет.
      const signature = actionSignature(use.name, (use.input ?? {}) as Record<string, unknown>);
      recentActions.push(signature);
      if (recentActions.length > LOOP_WINDOW) recentActions.shift();
      const repeats = recentActions.filter((s) => s === signature).length;

      if (repeats >= LOOP_STOP_AT) {
        ui.banner([
          "\x1b[1m⛔ Задача остановлена харнессом\x1b[0m",
          "",
          `Агент зациклился: действие ${signature} повторено ${repeats} раз без продвижения.`,
          "Дальнейшие шаги жгли бы лимит впустую.",
        ]);
        return;
      }

      if (repeats >= LOOP_WARN_AT && typeof outcome.content === "string") {
        outcome.content +=
          `\n\n[ХАРНЕСС] Ты повторил действие ${signature} уже ${repeats} раза, и ничего не ` +
          `изменилось. Это цикл, повторять его снова бессмысленно. Смени подход: другой ` +
          `элемент, другой путь к цели, screenshot, вопрос через query_page - или вызови ` +
          `ask_user, если не понимаешь, что происходит. Ещё ${LOOP_STOP_AT - repeats} повтора, ` +
          `и задача будет остановлена.`;
      }

      // Если агент третий раз подряд спотыкается об один и тот же реф, разворачиваем его.
      const ref = (use.input as Record<string, unknown>)["ref"];
      if (typeof ref === "string") {
        const failures = outcome.isError ? (refFailures.get(ref) ?? 0) + 1 : 0;
        refFailures.set(ref, failures);
        if (failures >= MAX_REF_FAILURES && typeof outcome.content === "string") {
          outcome.content +=
            `\n\nЭто ${failures}-я неудача подряд с ${ref}. Хватит: ` +
            `элемент недостижим тем способом, которым ты пробуешь. Смени подход.`;
        }
      }

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError,
      });

      if (outcome.finished !== undefined) finished = outcome.finished;
    }

    messages.push({ role: "user", content: results });

    if (finished !== undefined) {
      ui.banner(["\x1b[1m✅ Задача завершена\x1b[0m", "", ...finished.split("\n")]);
      return;
    }
  }

  ui.warn(`Достигнут лимит в ${MAX_STEPS} шагов. Задача остановлена принудительно.`);
}
