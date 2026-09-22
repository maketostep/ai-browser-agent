import Anthropic from "@anthropic-ai/sdk";
import { provider } from "./provider.js";

let cached: Anthropic | null = null;

export function client(): Anthropic {
  if (cached) return cached;
  const config = provider();

  cached = new Anthropic({
    apiKey: config.apiKey,
    // Бесплатные и общие тиры регулярно отдают 429/529. Ретраи самого SDK - первая
    // линия; вторая, с более длинными паузами, живёт в agent/loop.ts.
    maxRetries: 4,
    timeout: 120_000,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    // Совместимые шлюзы расходятся в том, какой заголовок читают: Anthropic ждёт
    // x-api-key, шлюзы в стиле Claude Code - Authorization: Bearer. SDK отправит оба,
    // сервер возьмёт тот, который понимает.
    ...(config.id === "zai" ? { authToken: config.apiKey } : {}),
  });
  return cached;
}

/** Только для тестов. */
export function resetClient(): void {
  cached = null;
}
