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

export type ProviderId = "anthropic" | "zai" | "openrouter";

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
  /** На повторах основного цикла после временного сбоя, если основная модель не отвечает. */
  fallbackModel?: string;
  features: Features;
};

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** Всё выключено: модель за шлюзом может быть любой, лишнее поле роняет запрос в 400. */
const NO_EXTENSIONS: Features = {
  adaptiveThinking: false,
  effort: false,
  contextManagement: false,
  promptCaching: false,
  disableParallelToolUse: false,
};

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

function detectProvider(): ProviderId {
  const explicit = env("AGENT_PROVIDER")?.toLowerCase();
  if (explicit === "zai" || explicit === "anthropic" || explicit === "openrouter") return explicit;
  if (env("OPENROUTER_API_KEY")) return "openrouter";
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
  if (id === "zai") return resolveZai();
  if (id === "openrouter") return resolveOpenRouter();
  return resolveAnthropic();
}

function resolveZai(): ProviderConfig {
  const key = env("ZAI_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN") ?? env("ANTHROPIC_API_KEY");
  if (!key) {
    throw new Error(
      "Провайдер z.ai выбран, но ключа нет. Положи ZAI_API_KEY в .env " +
        "(ключ берётся на https://z.ai/manage-apikey/apikey-list).",
    );
  }
  return {
    id: "zai",
    label: "z.ai (GLM)",
    baseURL: env("ANTHROPIC_BASE_URL") ?? ZAI_BASE_URL,
    apiKey: key,
    mainModel: env("AGENT_MODEL") ?? "glm-4.6",
    // По умолчанию суб-агенты идут на ту же модель: id более дешёвой модели
    // зависит от тарифа аккаунта, поэтому не угадываем, а даём переопределить.
    subModel: env("AGENT_SUB_MODEL") ?? env("AGENT_MODEL") ?? "glm-4.6",
    features: NO_EXTENSIONS,
  };
}

/**
 * OpenRouter отдаёт модели разных вендоров через Anthropic-совместимый /v1/messages.
 * В их документации для OpenAI-клиентов адрес заканчивается на /api/v1, а SDK сам
 * дописывает /v1/messages - хвост /v1 срезаем, иначе вышел бы .../v1/v1/messages.
 */
function resolveOpenRouter(): ProviderConfig {
  const key = env("OPENROUTER_API_KEY");
  if (!key) {
    throw new Error("Провайдер OpenRouter выбран, но OPENROUTER_API_KEY не задан (https://openrouter.ai/keys).");
  }
  const model = env("OPENROUTER_MODEL") ?? env("AGENT_MODEL");
  if (!model) {
    throw new Error(
      "Для OpenRouter нужна модель: OPENROUTER_MODEL=vendor/model, например anthropic/claude-sonnet-5. " +
        "ТЗ требует модели Claude или OpenAI.",
    );
  }
  const subModel = env("OPENROUTER_SUB_MODEL") ?? env("AGENT_SUB_MODEL") ?? model;
  const baseURL = (env("OPENROUTER_BASE_URL") ?? OPENROUTER_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  return {
    id: "openrouter",
    label: "OpenRouter",
    baseURL,
    apiKey: key,
    mainModel: model,
    subModel,
    // Запасная по умолчанию - суб-модель: перегрузка одного вышестоящего провайдера
    // не держит задачу, пока другая модель свободна. Дневную квоту аккаунта это не
    // обходит - она общая, её ловит быстрый отказ в retry.ts.
    fallbackModel: env("OPENROUTER_FALLBACK_MODEL") ?? (subModel !== model ? subModel : undefined),
    // ponytail: у anthropic/* моделей OpenRouter пробрасывает часть расширений
    // (caching, thinking), но проверять это надо на живом ключе; пока всё выключено.
    features: NO_EXTENSIONS,
  };
}

function resolveAnthropic(): ProviderConfig {
  const key = env("ANTHROPIC_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN");
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY не задан. Положи ключ с console.anthropic.com в .env, " +
        "либо выбери другого провайдера через AGENT_PROVIDER (шаблон в .env.example).",
    );
  }
  return {
    id: "anthropic",
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
