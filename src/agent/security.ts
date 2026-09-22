import { classifyRisk, type RiskInput } from "./subagents.js";
import type { AskHuman, RiskVerdict } from "../types.js";
import * as ui from "../ui/render.js";

/**
 * Security-гейт.
 *
 * Живёт в харнессе, не в модели. Агент обязан приложить intent, но intent - это вход
 * для оценки, а не решение. Инъекция со страницы не может ни снять гейт, ни подменить
 * вердикт: решение принимает код, который страницу не читал.
 *
 * Зашитого списка опасных кнопок здесь нет намеренно - ТЗ запрещает заготовки, и на
 * незнакомом сайте такой список всё равно бесполезен.
 */

/** Инструменты, меняющие состояние страницы или аккаунта. Остальные проходят без оценки. */
const MUTATING = new Set(["click", "type_text", "select_option", "switch_tab", "navigate", "go_back"]);

/** Оценивать имеет смысл только то, что может что-то необратимо сделать. */
const NEEDS_CLASSIFICATION = new Set(["click", "type_text", "select_option"]);

/**
 * Детерминированный пол безопасности.
 *
 * Классификатор - вероятностный, и на слабой модели он плавает: одно и то же
 * подтверждение возраста получало то high, то low на идентичном промпте. Строить
 * защиту от необратимых действий на настроении модели нельзя, поэтому для самых
 * дорогих категорий решение принимает код. Классификатор может только поднять
 * оценку выше пола, опустить - никогда.
 *
 * Это НЕ заготовка в смысле запрета ТЗ: здесь нет ни шагов сценария, ни селекторов,
 * ни знания о конкретном сайте. Это семантика действий, которая ограничивает агента,
 * а не помогает ему решать задачу.
 */
const IRREVERSIBLE: { pattern: RegExp; why: string }[] = [
  { pattern: /оплат|заплат|к\s*оплате|купить|оформить\s+заказ|pay\b|checkout|purchase/i, why: "трата денег" },
  { pattern: /отправ|отклик|подать\s+заявк|submit\b|send\b/i, why: "отправка адресату" },
  { pattern: /удал|очист|стере|\bdelete\b|\bremove\b|\bclear\b/i, why: "удаление данных" },
  {
    // Внимание: \w в JS не матчит кириллицу, поэтому здесь явные классы [а-яё].
    // На этом паттерны молча не срабатывали, пока не поймал тест.
    pattern:
      /мне\s+есть|уже\s+есть|18\s*лет|совершеннолет|подтвер[а-яё]*\s+возраст|соглас[а-яё]*\s+с|принима[а-яё]*\s+услови|accept.*terms|i\s+agree/i,
    why: "заявление от имени человека: возраст, личность или согласие",
  },
  { pattern: /опубликов|\bpublish\b|\bpost\b/i, why: "публикация" },
];

function deterministicFloor(element: string): string | null {
  for (const rule of IRREVERSIBLE) {
    if (rule.pattern.test(element)) return rule.why;
  }
  return null;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

export type Classifier = (input: RiskInput) => Promise<RiskVerdict>;

export class SecurityGate {
  /** Кеш по (элемент + намерение): повторный клик по тому же не платит второй раз. */
  private readonly cache = new Map<string, RiskVerdict>();

  /** classifier инъектируется, чтобы гейт можно было тестировать без сети. */
  constructor(
    private readonly askHuman: AskHuman,
    private readonly classifier: Classifier = classifyRisk,
  ) {}

  /** Сколько раз классификатор реально вызывался. Нужно тестам, чтобы проверить кеш. */
  calls = 0;

  private task = "";
  /** Что человек запретил в текущей задаче. Пусто - значит запретов ещё не было. */
  private readonly declined: string[] = [];

  /** Сбрасывает состояние между задачами: запреты одной задачи не переносятся в другую. */
  beginTask(task: string): void {
    this.task = task;
    this.declined.length = 0;
    this.cache.clear();
  }

  isMutating(tool: string): boolean {
    return MUTATING.has(tool);
  }

  async check(args: {
    tool: string;
    element: string;
    intent: string;
    url: string;
    title: string;
  }): Promise<GateDecision> {
    if (!NEEDS_CLASSIFICATION.has(args.tool)) return { allowed: true };

    // Ключ включает число запретов: после отказа прежние вердикты "low" больше
    // не годятся, обстановка изменилась.
    const key = `${this.declined.length}||${args.element}||${args.intent}`;
    let verdict = this.cache.get(key);
    if (!verdict) {
      this.calls += 1;
      try {
        verdict = await this.classifier({ ...args, task: this.task, declined: [...this.declined] });
      } catch (err) {
        // Защита в глубину: классификатор уже ловит свои ошибки сам, но если он всё
        // же упал, гейт обязан закрыться, а не открыться.
        verdict = {
          risk: "high",
          reason: `Оценка риска не выполнена (${err instanceof Error ? err.message : String(err)})`,
          reversible: false,
        };
      }
      this.cache.set(key, verdict);
    }

    // Детерминированная страховка поверх вероятностной оценки.
    //
    // Живой прогон показал дыру: гейт запретил "Очистить корзину" как необратимое,
    // а агент добился того же, нажав "Уменьшить количество" - классификатор счёл
    // это обратимым, потому что судил кнопку по подписи, в отрыве от задачи.
    // Подсказка классификатору про запреты помогает, но полагаться только на его
    // суждение нельзя. Поэтому после отказа любое меняющее состояние действие
    // проходит через человека, пока он сам что-нибудь не разрешит.
    const afterDecline = this.declined.length > 0;
    const floor = deterministicFloor(args.element);

    if (verdict.risk !== "high" && !afterDecline && !floor) {
      ui.info(`риск ${verdict.risk}: ${verdict.reason}`);
      return { allowed: true };
    }

    let why = verdict.reason;
    if (floor && verdict.risk !== "high") {
      // Модель недооценила, но категория действия говорит сама за себя.
      why = `${verdict.reason}. Однако элемент относится к необратимой категории (${floor}), ` +
        `поэтому решение принимает человек, а не оценка модели.`;
    }
    if (afterDecline && verdict.risk !== "high" && !floor) {
      why = `${verdict.reason}. Но в этой задаче человек уже запретил: ` +
        `${this.declined.join("; ")}. Пока запрет в силе, каждое меняющее действие ` +
        `подтверждается отдельно - иначе запрет обходится мелкими шагами.`;
    }

    ui.securityGate(`${args.tool} -> ${args.element}\n             Намерение: ${args.intent}`, why);
    const answer = await this.askHuman("Выполнить это действие? [y/N] ");
    const approved = answer.trim().toLowerCase() === "y";
    ui.gateDecision(approved);

    if (approved) {
      // Человек снял режим повышенной строгости осознанным разрешением.
      this.declined.length = 0;
      this.cache.clear();
      return { allowed: true };
    }

    this.declined.push(args.intent);
    return {
      allowed: false,
      reason:
        `Человек отклонил действие (${verdict.reason}). Это не сбой инструмента. ` +
        `Не пытайся добиться того же другим способом: обход запрета тоже будет ` +
        `остановлен. Спроси человека, как действовать дальше, или займись другой ` +
        `частью задачи.`,
    };
  }
}
