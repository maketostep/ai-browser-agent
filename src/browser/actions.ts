import type { Frame, Locator } from "playwright";
import type { BrowserSession } from "./session.js";
import { distillPage } from "./distill.js";
import type { ErrorCode, Observation, ToolResult } from "../types.js";

const MAX_TEXT = 3000;
const ACTION_TIMEOUT = 8000;
const NAV_TIMEOUT = 30000;
/** Шаг и потолок ожидания стабилизации DOM: обычно хватает двух проверок. */
const SETTLE_STEP_MS = 250;
const SETTLE_MAX_CHECKS = 12;

/**
 * Действия в браузере. Каждое возвращает свежее наблюдение в том же результате:
 * один шаг агента = один вызов модели, без лишнего round-trip "сделал -> посмотри".
 */
export class Actions {
  constructor(private readonly session: BrowserSession) {}

  /** Гарантирует, что агенту есть в чём работать. Зовётся перед каждым инструментом. */
  async ensureBrowser(): Promise<void> {
    await this.session.ensurePage();
  }

  // ---------------------------------------------------------------- наблюдение

  async observe(extraNote?: string): Promise<Observation> {
    const page = this.session.page();
    const frames = page.frames();
    const chunks: string[] = [];
    let text = "";
    let mainFrameError: string | undefined;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      // Индекс 0 - главный фрейм, у него рефы без префикса.
      const prefix = i === 0 ? "" : `f${i}`;
      try {
        await this.shimEsbuildHelpers(frame);
        const result = await frame.evaluate(distillPage, { prefix, maxText: MAX_TEXT });
        if (i === 0) text = result.text;
        if (result.count === 0) continue;
        chunks.push(prefix ? `--- фрейм ${prefix} (${frame.url()}) ---\n${result.elements}` : result.elements);
      } catch (err) {
        const detail = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        // Дочерний фрейм мог отсоединиться посреди обхода - это норма на SPA.
        // А вот молчаливый провал ГЛАВНОГО фрейма выглядел бы для агента как пустая
        // страница, и он бы уверенно пошёл принимать решения вслепую.
        if (i === 0) mainFrameError = detail;
      }
    }

    const notes = [
      this.session.drainNotes(),
      extraNote,
      mainFrameError ? `ВНИМАНИЕ: прочитать страницу не удалось (${mainFrameError})` : undefined,
    ]
      .filter(Boolean)
      .join("; ");

    const elements = mainFrameError
      ? "(страницу прочитать не удалось, список элементов недостоверен)"
      : chunks.join("\n") || "(интерактивных элементов не найдено)";

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      elements,
      text,
      tabs: this.session.pages().length,
      note: notes || undefined,
    };
  }

  /**
   * tsx компилирует через esbuild с keepNames: внутренние функции оборачиваются в
   * хелпер __name. Playwright переносит distillPage в страницу через toString(),
   * а хелпера в странице нет - и вызов падает с ReferenceError.
   *
   * Строковый аргумент evaluate идёт в страницу как есть, минуя компиляцию, поэтому
   * шим определяется надёжно. Контекст умирает при каждой навигации, так что ставим
   * его перед каждым снимком, а не один раз на старте.
   */
  private async shimEsbuildHelpers(frame: Frame): Promise<void> {
    await frame.evaluate("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  }

  private async ok(message: string, note?: string): Promise<ToolResult> {
    await this.settle();
    return { ok: true, message, observation: await this.observe(note) };
  }

  private async fail(error: ErrorCode, message: string): Promise<ToolResult> {
    return { ok: false, error, message, observation: await this.observe() };
  }

  /**
   * Дать странице дорисовать результат действия.
   *
   * Фиксированная пауза здесь не работает: на SPA снимок одной и той же страницы
   * Лавки ловил то 15, то 64 интерактивных элемента в зависимости от везения.
   * Агент, которому досталось чтение на 15, видит почти пустую страницу и решает
   * вслепую. Ждём, пока количество элементов перестанет меняться, а не фиксированный
   * срок. networkidle на SPA не наступает вовсе, поэтому он тут не годится.
   */
  private async settle(): Promise<void> {
    const page = this.session.page();
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

    const countInteractive = () =>
      page
        .evaluate(
          () =>
            document.querySelectorAll("a,button,input,select,textarea,[role],[onclick],[tabindex]")
              .length,
        )
        .catch(() => -1);

    let previous = -1;
    for (let attempt = 0; attempt < SETTLE_MAX_CHECKS; attempt++) {
      await page.waitForTimeout(SETTLE_STEP_MS);
      const current = await countInteractive();
      if (current > 0 && current === previous) return;
      previous = current;
    }
  }

  // ------------------------------------------------------------------- рефы

  /** Реф вида "e7" или "f2:e7" -> локатор в нужном фрейме. */
  private resolve(ref: string): { locator: Locator; frame: Frame } | null {
    const page = this.session.page();
    const match = /^(?:f(\d+):)?e\d+$/.exec(ref.trim());
    if (!match) return null;

    const frameIndex = match[1] ? Number(match[1]) : 0;
    const frame = page.frames()[frameIndex];
    if (!frame) return null;

    return { locator: frame.locator(`[data-agent-ref="${ref.trim()}"]`), frame };
  }

  private async locate(ref: string): Promise<{ locator: Locator } | ToolResult> {
    const resolved = this.resolve(ref);
    if (!resolved) {
      return this.fail(
        "bad_input",
        `Реф ${JSON.stringify(ref)} выдуман. Рефы не придумывают, их берут из наблюдения: ` +
          `${await this.sampleRefs()}. Возьми нужный элемент из списка ниже.`,
      );
    }
    const count = await resolved.locator.count().catch(() => 0);
    if (count === 0) {
      return this.fail(
        "stale_ref",
        `Рефа ${ref} больше нет на странице. Рефы живут один снапшот: страница изменилась, ` +
          `возьми элемент из наблюдения ниже. Сейчас доступны, например: ${await this.sampleRefs()}.`,
      );
    }
    return { locator: resolved.locator.first() };
  }

  /** Пара живых рефов для сообщения об ошибке: слабой модели проще исправиться по образцу. */
  private async sampleRefs(): Promise<string> {
    const observation = await this.observe();
    const refs = (observation.elements.match(/\[(?:f\d+:)?e\d+\]/g) ?? []).slice(0, 3);
    return refs.length > 0 ? refs.join(", ") : "(на странице нет интерактивных элементов)";
  }

  /**
   * Playwright пишет перехватчика в текст ошибки, но закрывающих тегов там больше,
   * чем открывающих, и наивная регулярка вытаскивает бесполезное "</div>". Берём
   * последний ОТКРЫВАЮЩИЙ тег перед фразой про перехват - в нём есть класс или id.
   */
  private describeInterceptor(raw: string): string {
    const upto = raw.slice(0, raw.search(/intercepts pointer events/i));
    const openingTags = upto.match(/<[a-zA-Z][^>]{0,160}>/g) ?? [];
    const who = openingTags[openingTags.length - 1];

    const base = who
      ? `Клик перехвачен элементом ${who.replace(/\s+/g, " ")}.`
      : `Клик перехвачен другим элементом.`;

    // Повтор того же клика ничего не изменит: подсказываем выходы явно, иначе
    // слабая модель зацикливается на одном и том же действии.
    return (
      `${base} Поверх цели лежит оверлей: баннер, попап или всплывающая карточка. ` +
      `Повторять тот же клик бесполезно. Варианты: найти в наблюдении кнопку закрытия ` +
      `этого оверлея и нажать её; прокрутить страницу; либо взять screenshot и посмотреть, ` +
      `что именно перекрывает цель.`
    );
  }

  /** Playwright пишет причину провала в текст ошибки. Переводим её в код. */
  private classifyError(err: unknown): { code: ErrorCode; detail: string } {
    const raw = err instanceof Error ? err.message : String(err);
    const firstLine = raw.split("\n")[0] ?? raw;

    if (/intercepts pointer events/i.test(raw)) {
      return { code: "intercepted", detail: this.describeInterceptor(raw) };
    }
    if (/not visible|outside of the viewport|hidden/i.test(raw)) {
      return { code: "not_visible", detail: `Элемент есть в DOM, но не виден: ${firstLine}` };
    }
    if (/Timeout|timed out/i.test(raw)) {
      return { code: "timeout", detail: `Действие не уложилось в таймаут: ${firstLine}` };
    }
    return { code: "timeout", detail: firstLine };
  }

  // --------------------------------------------------------------- действия

  async navigate(url: string): Promise<ToolResult> {
    const page = this.session.page();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return this.ok(`Открыт ${url}`);
    } catch (err) {
      const { detail } = this.classifyError(err);
      // Частичная загрузка - это всё ещё состояние, с которым агент может работать.
      return this.fail("timeout", `${url} не догрузился: ${detail}`);
    }
  }

  async goBack(): Promise<ToolResult> {
    try {
      await this.session.page().goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return this.ok("Вернулся назад");
    } catch {
      return this.fail("timeout", "Назад не получилось: истории нет или переход не завершился");
    }
  }

  async click(ref: string): Promise<ToolResult> {
    const found = await this.locate(ref);
    if ("ok" in found) return found;

    try {
      await found.locator.scrollIntoViewIfNeeded({ timeout: 3000 });
    } catch {
      // Не смертельно: click сам попробует доскроллить.
    }

    try {
      await found.locator.click({ timeout: ACTION_TIMEOUT });
      return this.ok(`Клик по ${ref}`);
    } catch (err) {
      const { code, detail } = this.classifyError(err);
      return this.fail(code, detail);
    }
  }

  async typeText(ref: string, text: string, pressEnter: boolean): Promise<ToolResult> {
    const found = await this.locate(ref);
    if ("ok" in found) return found;

    try {
      await found.locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await found.locator.click({ timeout: ACTION_TIMEOUT });
      await found.locator.fill(text, { timeout: ACTION_TIMEOUT });
      if (pressEnter) await this.session.page().keyboard.press("Enter");
      return this.ok(`В ${ref} введено ${JSON.stringify(text)}${pressEnter ? " + Enter" : ""}`);
    } catch (err) {
      const { code, detail } = this.classifyError(err);
      return this.fail(code, detail);
    }
  }

  async selectOption(ref: string, value: string): Promise<ToolResult> {
    const found = await this.locate(ref);
    if ("ok" in found) return found;

    try {
      // Сначала по значению, затем по видимой подписи: агент видит подписи, не values.
      await found.locator.selectOption({ value }, { timeout: ACTION_TIMEOUT }).catch(
        async () => await found.locator.selectOption({ label: value }, { timeout: ACTION_TIMEOUT }),
      );
      return this.ok(`В ${ref} выбрано ${JSON.stringify(value)}`);
    } catch (err) {
      const { code, detail } = this.classifyError(err);
      return this.fail(code, `Не удалось выбрать ${JSON.stringify(value)}: ${detail}`);
    }
  }

  async scroll(direction: "up" | "down", ref?: string): Promise<ToolResult> {
    if (ref) {
      const found = await this.locate(ref);
      if ("ok" in found) return found;
      await found.locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      return this.ok(`Проскроллил к ${ref}`);
    }
    const delta = direction === "down" ? 800 : -800;
    await this.session.page().mouse.wheel(0, delta);
    return this.ok(`Прокрутка ${direction === "down" ? "вниз" : "вверх"}`);
  }

  async wait(seconds: number, reason: string): Promise<ToolResult> {
    const capped = Math.min(Math.max(seconds, 0), 15);
    await this.session.page().waitForTimeout(capped * 1000);
    return this.ok(`Подождал ${capped} с: ${reason}`);
  }

  /** Вьюпорт, не вся страница: полностраничный скриншот вытесняет из контекста то,
   *  ради чего его звали. */
  async screenshot(): Promise<{ base64: string; bytes: number }> {
    const buffer = await this.session.page().screenshot({ type: "jpeg", quality: 60 });
    return { base64: buffer.toString("base64"), bytes: buffer.byteLength };
  }

  async listTabs(): Promise<ToolResult> {
    const pages = this.session.pages();
    const active = this.session.page();
    const lines = await Promise.all(
      pages.map(async (p, i) => {
        const marker = p === active ? "*" : " ";
        return `${marker} [${i}] ${await p.title().catch(() => "")} - ${p.url()}`;
      }),
    );
    return this.ok(`Вкладки:\n${lines.join("\n")}`);
  }

  async switchTab(index: number): Promise<ToolResult> {
    if (!this.session.switchTo(index)) {
      return this.fail("bad_input", `Вкладки с индексом ${index} нет. Посмотри list_tabs.`);
    }
    return this.ok(`Переключился на вкладку ${index}`);
  }

  /**
   * Расширенный снимок для DOM sub-agent: полный видимый текст вместо обрезанного.
   * Это и есть смысл суб-агента - он читает больше, а в основной контекст попадает
   * только его короткий ответ.
   */
  async deepContext(): Promise<{ url: string; title: string; elements: string; text: string }> {
    const page = this.session.page();
    const observation = await this.observe();
    const fullText = await page
      .evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim())
      .catch(() => observation.text);

    return {
      url: observation.url,
      title: observation.title,
      elements: observation.elements,
      text: fullText.slice(0, 20000),
    };
  }

  /**
   * Адрес и заголовок без пересборки наблюдения.
   *
   * Важно: observe() снимает и заново раздаёт все data-agent-ref. Если позвать его
   * между выбором рефа моделью и самим действием, реф либо протухнет, либо - хуже -
   * укажет на другой элемент, и клик уйдёт не туда с уже одобренным намерением.
   * Поэтому всё, что нужно до действия, берётся так.
   */
  async pageInfo(): Promise<{ url: string; title: string }> {
    const page = this.session.page();
    return { url: page.url(), title: await page.title().catch(() => "") };
  }

  /** Описание элемента для классификатора риска и для печати в терминал. */
  async describe(ref: string): Promise<string> {
    const resolved = this.resolve(ref);
    if (!resolved) return ref;
    try {
      const described = await resolved.locator.first().evaluate((el) => {
        const text = (el as HTMLElement).innerText ?? "";
        const label = el.getAttribute("aria-label") ?? "";
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        const href = el.getAttribute("href") ?? "";
        return [role, label || text.replace(/\s+/g, " ").slice(0, 80), href].filter(Boolean).join(" ");
      });
      return described || ref;
    } catch {
      return ref;
    }
  }
}
