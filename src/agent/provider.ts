/**
 * Выбор провайдера модели.
 *
 * Агент говорит по протоколу Anthropic Messages API. Кроме самой Anthropic его
 * понимают совместимые шлюзы - например z.ai отдаёт GLM через
 * https://api.z.ai/api/anthropic. Поэтому провайдер это конфигурация, а не код.
 *
 * Важно: совместимость протокола не означает совместимость возможностей. Adaptive
 * thinking, effort, context editing и prompt caching - расширения Anthropic. На чужом
 * шлюзе они либо игнорируются, либо возвращают 400, поэтому каждая из них объявлена
 * отдельным флагом и не отправляется туда, где не поддерживается.
 */

export type ProviderId = "anthropic" | "zai";

export type Features = {
  /** thinking: {type:"adaptive"} */
  adaptiveThinking: boolean;
  /** output_config: {effort} */
  effort: boolean;
  /** beta context-management-2025-06-27 */
  contextManagement: boolean;
  /** cache_control: {type:"ephemeral"} */
  promptCaching: boolean;
  /** tool_choice.disable_parallel_tool_use */
  disableParallelToolUse: boolean;
};

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  baseURL?: string;
  apiKey: string;
  mainModel: string;
  subModel: string;
  features: Features;
};

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

function detectProvider(): ProviderId {
  const explicit = env("AGENT_PROVIDER")?.toLowerCase();
  if (explicit === "zai" || explicit === "anthropic") return explicit;
  if (env("ZAI_API_KEY")) return "zai";
  if (env("ANTHROPIC_BASE_URL")?.includes("z.ai")) return "zai";
  return "anthropic";
}

let cached: ProviderConfig | null = null;

export function provider(): ProviderConfig {
  if (cached) return cached;
  cached = resolve();
  return cached;
}

/** Только для тестов: сбросить закешированное решение. */
export function resetProvider(): void {
  cached = null;
}

export function resolve(): ProviderConfig {
  const id = detectProvider();

  if (id === "zai") {
    const key = env("ZAI_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN") ?? env("ANTHROPIC_API_KEY");
    if (!key) {
      throw new Error(
        "Провайдер z.ai выбран, но ключа нет. Положи ZAI_API_KEY в .env " +
          "(ключ берётся на https://z.ai/manage-apikey/apikey-list).",
      );
    }
    return {
      id,
      label: "z.ai (GLM)",
      baseURL: env("ANTHROPIC_BASE_URL") ?? ZAI_BASE_URL,
      apiKey: key,
      mainModel: env("AGENT_MODEL") ?? "glm-4.6",
      // По умолчанию суб-агенты идут на ту же модель: id более дешёвой модели
      // зависит от тарифа аккаунта, поэтому не угадываем, а даём переопределить.
      subModel: env("AGENT_SUB_MODEL") ?? env("AGENT_MODEL") ?? "glm-4.6",
      features: {
        adaptiveThinking: false,
        effort: false,
        contextManagement: false,
        promptCaching: false,
        disableParallelToolUse: false,
      },
    };
  }

  const key = env("ANTHROPIC_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN");
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY не задан. Положи ключ с console.anthropic.com в .env, " +
        "либо выбери другого провайдера через AGENT_PROVIDER (шаблон в .env.example).",
    );
  }
  return {
    id,
    label: "Anthropic (Claude)",
    baseURL: env("ANTHROPIC_BASE_URL"),
    apiKey: key,
    mainModel: env("AGENT_MODEL") ?? "claude-sonnet-5",
    subModel: env("AGENT_SUB_MODEL") ?? "claude-haiku-4-5",
    features: {
      adaptiveThinking: true,
      effort: true,
      contextManagement: true,
      promptCaching: true,
      disableParallelToolUse: true,
    },
  };
}

/** Есть ли вообще чем авторизоваться. Для дружелюбной ошибки на старте. */
export function hasCredentials(): boolean {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}
