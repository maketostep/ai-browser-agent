/** Что агент видит после каждого действия. Единственное представление страницы,
 *  которое попадает в основной контекст модели. Raw HTML сюда не попадает никогда. */
export type Observation = {
  url: string;
  title: string;
  /** Построчный список интерактивных элементов с рефами */
  elements: string;
  /** Видимый текст страницы */
  text: string;
  /** Сколько вкладок открыто */
  tabs: number;
  /** Событие, которое агент не мог увидеть в DOM: новая вкладка, диалог, навигация */
  note?: string;
};

export type ErrorCode =
  | "stale_ref"
  | "not_visible"
  | "intercepted"
  | "timeout"
  | "declined"
  | "bad_input";

export type ToolResult =
  | { ok: true; message: string; observation: Observation }
  | { ok: false; error: ErrorCode; message: string; observation: Observation };

/** Вердикт классификатора риска. Приходит от суб-агента, решение принимает харнесс. */
export type RiskVerdict = {
  risk: "low" | "medium" | "high";
  reason: string;
  reversible: boolean;
};

/** Запрос к человеку. Один и тот же канал используют ask_user и security-гейт. */
export type AskHuman = (question: string) => Promise<string>;
