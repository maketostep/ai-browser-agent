import { describe, it, expect } from "vitest";
import AnthropicSDK from "@anthropic-ai/sdk";
import { withRetry, requireContent, isTransient } from "../src/agent/retry.js";

describe("ретраи", () => {
  it("ответ 200 без content ретраится, а не роняет вызов", async () => {
    // Живая проверка OpenRouter на бесплатной модели: разовый ответ без content,
    // и check-api упал на "Cannot read properties of undefined (reading 'find')".
    const replies: { content?: unknown[] }[] = [{}, { content: [{ type: "text", text: "ok" }] }];
    let calls = 0;
    const response = await withRetry("тест", [0], async () => requireContent(replies[calls++]!));

    expect(calls).toBe(2);
    expect(response.content).toHaveLength(1);
  });

  it("стабильно пустой ответ после ретраев - понятная ошибка", async () => {
    await expect(withRetry("тест", [0], async () => requireContent({}))).rejects.toThrow(/без content/);
  });
});

describe("ошибки внутри стрима", () => {
  it("overloaded_error из SSE без HTTP-статуса считается временной", () => {
    // Живая проверка OpenRouter: перегрузку вышестоящей модели шлюз прислал событием
    // внутри стрима. У такой ошибки SDK нет статуса, и цикл агента бросал задачу.
    const body = { type: "error", error: { type: "overloaded_error", message: "Upstream error from Nvidia" } };
    const err = new AnthropicSDK.APIError(undefined, body, JSON.stringify(body), undefined);
    expect(isTransient(err)).toBe(true);
  });

  it("invalid_request_error из SSE ретраить бессмысленно", () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
    const err = new AnthropicSDK.APIError(undefined, body, JSON.stringify(body), undefined);
    expect(isTransient(err)).toBe(false);
  });
});
