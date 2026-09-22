import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "../src/agent/provider.js";

const KEYS = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_SUB_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ZAI_API_KEY",
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
    expect(config.mainModel).toBe("claude-opus-5");
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
