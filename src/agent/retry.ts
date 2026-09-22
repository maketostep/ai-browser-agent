import AnthropicSDK from "@anthropic-ai/sdk";
import * as ui from "../ui/render.js";

/** Перегрузка и троттлинг проходят сами. Остальное ретраить бессмысленно. */
export function isTransient(err: unknown): boolean {
  if (err instanceof AnthropicSDK.APIError) {
    const status = err.status ?? 0;
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
      const status = err instanceof AnthropicSDK.APIError ? err.status : "сеть";
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
