import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, resetProvider } from "../src/agent/provider.js";
import { client, resetClient } from "../src/agent/client.js";

const KEYS = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_SUB_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_SUB_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_FALLBACK_MODEL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("выбор провайдера", () => {
  it("по умолчанию Anthropic со всеми возможностями", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    const config = resolve();

    expect(config.id).toBe("anthropic");
    expect(config.mainModel).toBe("claude-sonnet-5");
    expect(config.subModel).toBe("claude-haiku-4-5");
    expect(config.baseURL).toBeUndefined();
    expect(Object.values(config.features).every(Boolean)).toBe(true);
  });

  it("переключается на z.ai от одного только ZAI_API_KEY", () => {
    process.env["ZAI_API_KEY"] = "zai-test";
    const config = resolve();

    expect(config.id).toBe("zai");
    expect(config.baseURL).toBe("https://api.z.ai/api/anthropic");
    expect(config.mainModel).toBe("glm-4.6");
  });

  it("узнаёт z.ai по базовому адресу, даже если ключ лежит в анторопиковой переменной", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://api.z.ai/api/anthropic";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "zai-test";
    expect(resolve().id).toBe("zai");
  });

  it("на совместимом шлюзе не отправляет расширения Anthropic", () => {
    process.env["ZAI_API_KEY"] = "zai-test";
    const features = resolve().features;

    // Каждый из этих флагов - отдельный способ уронить запрос в 400 на чужом шлюзе.
    expect(features.adaptiveThinking).toBe(false);
    expect(features.effort).toBe(false);
    expect(features.contextManagement).toBe(false);
    expect(features.promptCaching).toBe(false);
    expect(features.disableParallelToolUse).toBe(false);
  });

  it("явный AGENT_PROVIDER сильнее автоопределения", () => {
    process.env["ZAI_API_KEY"] = "zai-test";
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["AGENT_PROVIDER"] = "anthropic";
    expect(resolve().id).toBe("anthropic");
  });

  it("модели переопределяются переменными окружения", () => {
    process.env["ZAI_API_KEY"] = "zai-test";
    process.env["AGENT_MODEL"] = "glm-5";
    process.env["AGENT_SUB_MODEL"] = "glm-4-flash";
    const config = resolve();

    expect(config.mainModel).toBe("glm-5");
    expect(config.subModel).toBe("glm-4-flash");
  });

  it("суб-модель наследует AGENT_MODEL, если отдельно не задана", () => {
    process.env["ZAI_API_KEY"] = "zai-test";
    process.env["AGENT_MODEL"] = "glm-5";
    expect(resolve().subModel).toBe("glm-5");
  });

  it("без ключа падает понятной ошибкой, а не пустым запросом", () => {
    expect(() => resolve()).toThrow(/ANTHROPIC_API_KEY/);

    process.env["AGENT_PROVIDER"] = "zai";
    expect(() => resolve()).toThrow(/z\.ai/);
  });
});

describe("OpenRouter", () => {
  afterEach(() => {
    resetProvider();
    resetClient();
  });

  it("выбирается по OPENROUTER_API_KEY, модель из OPENROUTER_MODEL", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "anthropic/claude-sonnet-5";
    const config = resolve();

    expect(config.id).toBe("openrouter");
    expect(config.baseURL).toBe("https://openrouter.ai/api");
    expect(config.mainModel).toBe("anthropic/claude-sonnet-5");
    // Суб-агенты без отдельной модели идут на основную: id дешёвой модели не угадываем.
    expect(config.subModel).toBe("anthropic/claude-sonnet-5");
    // Модель за шлюзом может быть любой, расширения Anthropic не отправляем.
    expect(Object.values(config.features).some(Boolean)).toBe(false);
  });

  it("берёт OPENROUTER_SUB_MODEL для суб-агентов", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "anthropic/claude-sonnet-5";
    process.env["OPENROUTER_SUB_MODEL"] = "anthropic/claude-haiku-4.5";
    expect(resolve().subModel).toBe("anthropic/claude-haiku-4.5");
    // Суб-модель отличается от основной - она же запасная для основного цикла.
    expect(resolve().fallbackModel).toBe("anthropic/claude-haiku-4.5");
  });

  it("без отдельной суб-модели запасной нет, OPENROUTER_FALLBACK_MODEL задаёт её явно", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "anthropic/claude-sonnet-5";
    expect(resolve().fallbackModel).toBeUndefined();
    process.env["OPENROUTER_FALLBACK_MODEL"] = "openai/gpt-5-mini";
    expect(resolve().fallbackModel).toBe("openai/gpt-5-mini");
  });

  it("срезает /v1 с OPENROUTER_BASE_URL: SDK сам добавит /v1/messages", () => {
    // Адрес из документации OpenRouter для OpenAI-клиентов - .../api/v1. С ним
    // запрос ушёл бы на .../api/v1/v1/messages и получил 404.
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "openai/gpt-5";
    process.env["OPENROUTER_BASE_URL"] = "https://openrouter.ai/api/v1/";
    expect(resolve().baseURL).toBe("https://openrouter.ai/api");
  });

  it("без модели падает понятной ошибкой", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    expect(() => resolve()).toThrow(/OPENROUTER_MODEL/);
  });

  it("явный AGENT_PROVIDER=openrouter сильнее ключа Anthropic", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "anthropic/claude-sonnet-5";
    process.env["AGENT_PROVIDER"] = "openrouter";
    expect(resolve().id).toBe("openrouter");
  });

  it("авторизуется Bearer-токеном и не отправляет чужой x-api-key", () => {
    // Если в окружении лежит ANTHROPIC_API_KEY, SDK подхватил бы его сам и отправил
    // OpenRouter чужой ключ в x-api-key.
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    process.env["OPENROUTER_MODEL"] = "anthropic/claude-sonnet-5";
    process.env["AGENT_PROVIDER"] = "openrouter";
    const sdk = client();

    expect(sdk.authToken).toBe("sk-or-test");
    expect(sdk.apiKey).toBeNull();
  });
});
