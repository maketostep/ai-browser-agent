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

const TRANSIENT_STREAM_ERRORS = new Set(["overloaded_error", "rate_limit_error", "api_error", "timeout_error"]);

/** Тип ошибки из тела SSE-события вида {type: "error", error: {type: "..."}}. */
function streamErrorType(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return "";
  const type = (inner as { type?: unknown }).type;
  return typeof type === "string" ? type : "";
}

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
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await operation();
    } catch (err) {
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
