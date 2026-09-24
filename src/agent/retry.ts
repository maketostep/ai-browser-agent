import AnthropicSDK from "@anthropic-ai/sdk";
import * as ui from "../ui/render.js";

/**
 * Шлюз ответил 200, но без сообщения. Живая проверка OpenRouter на бесплатной
 * модели: разовый такой ответ, и вызов падал на "reading 'find'" глубоко в коде.
 * Повтор того же запроса проходил - это сбой вышестоящего провайдера, а не наш.
 */
export class EmptyResponseError extends Error {}

export function requireContent<T extends { content?: unknown }>(response: T): T {
  if (!Array.isArray(response.content)) {
    throw new EmptyResponseError(`провайдер вернул ответ без content: ${JSON.stringify(response).slice(0, 200)}`);
  }
  return response;
}

/**
 * Квота исчерпана надолго: ретраи бессмысленны. Живой прогон на бесплатных моделях
 * OpenRouter: free-models-per-day кончился до завтра, а цикл честно ждал
 * 3 + 8 + 20 + 45 секунд. Минутный лимит со скорым сбросом ретраится как обычно.
 */
export class QuotaExhaustedError extends Error {}

/** Дольше этого до сброса квоты не ждём, а сразу отказываем. */
const QUOTA_WAIT_MS = 2 * 60 * 1000;

function quotaExhausted(err: unknown): QuotaExhaustedError | null {
  if (!(err instanceof AnthropicSDK.APIError) || err.status !== 429) return null;
  const headers: Headers | undefined = err.headers;
  const reset = Number(headers?.get("x-ratelimit-reset"));
  if (headers?.get("x-ratelimit-remaining") !== "0" || !Number.isFinite(reset)) return null;
  // Одни провайдеры отдают секунды, другие миллисекунды.
  const resetMs = reset < 1e12 ? reset * 1000 : reset;
  if (resetMs - Date.now() < QUOTA_WAIT_MS) return null;
  const at = new Date(resetMs).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return new QuotaExhaustedError(
    `квота провайдера исчерпана до ${at}, повтор не поможет (${errorMessage(err)}). ` +
      `Пополни счёт провайдера или смени модель в .env`,
  );
}

const TRANSIENT_STREAM_ERRORS = new Set(["overloaded_error", "rate_limit_error", "api_error", "timeout_error"]);

/** Поле из тела ошибки вида {type: "error", error: {type, message}}. */
function innerErrorField(body: unknown, field: "type" | "message"): string {
  if (typeof body !== "object" || body === null) return "";
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return "";
  const value = (inner as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

const streamErrorType = (body: unknown): string => innerErrorField(body, "type");

/** Человеческий текст ошибки без JSON-обёртки провайдера. */
const errorMessage = (err: InstanceType<typeof AnthropicSDK.APIError>): string =>
  innerErrorField(err.error, "message") || err.message.split("\n")[0]!;

/** Перегрузка, троттлинг и пустой ответ проходят сами. Остальное ретраить бессмысленно. */
export function isTransient(err: unknown): boolean {
  if (err instanceof EmptyResponseError) return true;
  if (err instanceof AnthropicSDK.APIError) {
    // Ошибка события внутри стрима приходит без HTTP-статуса: живая проверка
    // OpenRouter дала так overloaded_error от Nvidia. Судим по типу в теле.
    if (err.status === undefined) return TRANSIENT_STREAM_ERRORS.has(streamErrorType(err.error));
    const status = err.status;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return err instanceof AnthropicSDK.APIConnectionError;
}

/**
 * Ретраи с нарастающей паузой.
 *
 * Нужны не только основному циклу. Суб-агенты без них ломали работу тише и
 * обиднее: классификатор риска падал на 529, харнесс честно страховался вердиктом
 * "необратимо" - и блокировал переход между папками почты. Безопасно, но агент
 * вставал на ровном месте.
 */
export async function withRetry<T>(
  label: string,
  delaysMs: readonly number[],
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const quota = quotaExhausted(err);
      if (quota) throw quota;
      lastError = err;
      if (!isTransient(err) || attempt === delaysMs.length) break;
      const pause = delaysMs[attempt]!;
      const status =
        err instanceof AnthropicSDK.APIError ? err.status : err instanceof EmptyResponseError ? "пустой ответ" : "сеть";
      ui.warn(`${label}: провайдер отдал ${status}, ждём ${pause / 1000} с и пробуем снова`);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  throw lastError;
}

/** Основной цикл: шаг дорогой, ждать не жалко. */
export const MAIN_BACKOFF = [3_000, 8_000, 20_000, 45_000] as const;
/** Суб-агенты: вызываются часто, длинные паузы застопорили бы прогон. */
export const SUB_BACKOFF = [1_500, 4_000, 10_000] as const;

/** Человек отменил задачу: прерванный запрос к модели или прерванный вопрос в терминале. */
export function isAbort(err: unknown): boolean {
  return err instanceof AnthropicSDK.APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}
