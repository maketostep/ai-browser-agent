/**
 * Обнаружение цикла по повторам одного и того же действия.
 *
 * Счётчика неудач мало. Живой прогон по почте дал восемь шагов подряд: клик по письму
 * открывал постороннюю вкладку, агент возвращался и кликал снова. Каждый клик формально
 * УСПЕШЕН, поэтому счётчик неудач сбрасывался, и цикл крутился бы до исчерпания лимита
 * шагов. Ловить надо бесполезный успех, а не только провал.
 *
 * Общий для основного цикла и MCP-режима: там цикл ведёт Claude Code, и без этого
 * модуля агента некому остановить.
 */
export const LOOP_WINDOW = 6;
export const LOOP_WARN_AT = 3;
export const LOOP_STOP_AT = 5;

/** Ключ действия по сути, без формулировок: intent агент меняет, а делает то же самое. */
export function actionSignature(name: string, input: Record<string, unknown>): string {
  const parts = [name];
  for (const field of ["ref", "url", "index", "direction", "value"]) {
    const value = input[field];
    if (value !== undefined) parts.push(`${field}=${String(value)}`);
  }
  return parts.join("|");
}

export type LoopVerdict = { signature: string; repeats: number; level: "ok" | "warn" | "stop" };

export class LoopGuard {
  private readonly recent: string[] = [];

  /** Записывает действие и говорит, сколько раз оно уже было в недавнем окне. */
  record(name: string, input: unknown): LoopVerdict {
    const signature = actionSignature(name, (input ?? {}) as Record<string, unknown>);
    this.recent.push(signature);
    if (this.recent.length > LOOP_WINDOW) this.recent.shift();
    const repeats = this.recent.filter((s) => s === signature).length;
    const level = repeats >= LOOP_STOP_AT ? "stop" : repeats >= LOOP_WARN_AT ? "warn" : "ok";
    return { signature, repeats, level };
  }
}
