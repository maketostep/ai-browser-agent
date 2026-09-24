import { chromium, type BrowserContext, type Page, type Dialog, type Request } from "playwright";
import type { AskHuman } from "../types.js";
import * as ui from "../ui/render.js";

const PROFILE_DIR = ".profile";
/** Дольше этого запрос считаем фоновым (метрика, long-polling) и не ждём. */
const REQUEST_WAIT_MS = 2000;

export type SessionOptions = {
  /** Только для тестов. Продукт по требованию ТЗ всегда показывает браузер. */
  headless?: boolean;
  profileDir?: string;
};

/**
 * Живой браузер поверх персистентного профиля.
 *
 * Профиль на диске - это и есть требование ТЗ про persistent sessions: пользователь
 * логинится руками один раз, процесс можно перезапускать сколько угодно.
 */
export class BrowserSession {
  private ctx!: BrowserContext;
  private active!: Page;
  /** События, которых нет в DOM: новая вкладка, диалог, редирект. Вычитываются один раз. */
  private notes: string[] = [];
  /** Незавершённые fetch/xhr по вкладкам и время их старта: SPA дорисовывает страницу их ответами. */
  private readonly inflight = new Map<Page, Map<Request, number>>();

  constructor(
    private readonly askHuman: AskHuman,
    private readonly options: SessionOptions = {},
  ) {}

  async start(startUrl: string): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(this.options.profileDir ?? PROFILE_DIR, {
      channel: "chrome",
      // Требование ТЗ: браузер должен быть виден. headless включают только тесты.
      headless: this.options.headless ?? false,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-default-browser-check"],
    });

    this.active = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.wire(this.active);

    // Новая вкладка (target=_blank) сама становится активной: пользователь на видео
    // видит ровно то, с чем работает агент.
    this.ctx.on("page", (page) => {
      this.wire(page);
      this.active = page;
      this.notes.push(`Открылась новая вкладка: ${page.url()}`);
    });

    if (startUrl && startUrl !== "about:blank") {
      await this.active.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  private wire(page: Page): void {
    const pending = new Map<Request, number>();
    this.inflight.set(page, pending);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (type === "fetch" || type === "xhr") pending.set(request, Date.now());
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));

    // Нативный confirm/alert блокирует JS страницы до ответа. Отдаём решение человеку:
    // нативный confirm - это ровно то необратимое действие, ради которого существует гейт.
    page.on("dialog", async (dialog: Dialog) => {
      const accepted = await this.confirmDialog(dialog);
      try {
        if (accepted) await dialog.accept();
        else await dialog.dismiss();
      } catch {
        // Диалог мог быть закрыт страницей сам.
      }
      this.notes.push(
        `Диалог браузера (${dialog.type()}): ${JSON.stringify(dialog.message())} -> ` +
          (accepted ? "подтверждён человеком" : "отклонён"),
      );
    });

    page.on("close", () => {
      this.inflight.delete(page);
      if (page !== this.active) return;
      const alive = this.ctx.pages().filter((p) => !p.isClosed());
      const next = alive[alive.length - 1];
      if (next) {
        this.active = next;
        this.notes.push("Активная вкладка закрыта, переключился на предыдущую");
      }
    });
  }

  private async confirmDialog(dialog: Dialog): Promise<boolean> {
    if (dialog.type() === "alert") return true; // alert только сообщает, отклонять нечего
    ui.securityGate(
      `Страница показала ${dialog.type()}: ${JSON.stringify(dialog.message())}`,
      "Нативный диалог подтверждения - решение за человеком",
    );
    const answer = await this.askHuman("Подтвердить диалог? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  }

  /**
   * Гарантирует живую вкладку. Вызывается перед каждым действием агента.
   *
   * Без этого агент попадал в тупик, из которого нет выхода: все вкладки закрылись
   * (пользователь закрыл окно, страница закрыла сама себя, сессия восстановилась
   * странно), page() бросал "Все вкладки закрыты", и каждый следующий инструмент
   * падал там же. Агент оставался работоспособным, но безруким.
   */
  async ensurePage(): Promise<Page> {
    const alive = this.ctx.pages().filter((p) => !p.isClosed());

    if (!this.active || this.active.isClosed()) {
      const next = alive[alive.length - 1];
      if (next) {
        this.active = next;
        this.notes.push("Активная вкладка закрылась, переключился на оставшуюся");
      } else {
        this.active = await this.ctx.newPage();
        this.wire(this.active);
        this.notes.push("Все вкладки были закрыты, открыл новую");
      }
    }
    return this.active;
  }

  page(): Page {
    if (this.active.isClosed()) {
      const alive = this.ctx.pages().filter((p) => !p.isClosed());
      const next = alive[alive.length - 1];
      if (!next) throw new Error("Нет живой вкладки: ensurePage() не был вызван перед действием");
      this.active = next;
    }
    return this.active;
  }

  pages(): Page[] {
    return this.ctx.pages().filter((p) => !p.isClosed());
  }

  switchTo(index: number): boolean {
    const pages = this.pages();
    const target = pages[index];
    if (!target) return false;
    this.active = target;
    void target.bringToFront().catch(() => {});
    return true;
  }

  /**
   * Сколько свежих fetch/xhr активной вкладки ещё ждут ответа.
   *
   * Только моложе REQUEST_WAIT_MS: маяки метрики на Лавке не завершаются никогда,
   * и без отсечки каждый шаг ждал бы весь потолок стабилизации.
   */
  pendingRequests(): number {
    const now = Date.now();
    let fresh = 0;
    for (const started of this.inflight.get(this.page())?.values() ?? []) {
      if (now - started < REQUEST_WAIT_MS) fresh += 1;
    }
    return fresh;
  }

  /** Вычитывает накопленные события и очищает очередь. */
  drainNotes(): string | undefined {
    if (this.notes.length === 0) return undefined;
    const note = this.notes.join("; ");
    this.notes = [];
    return note;
  }

  pushNote(note: string): void {
    this.notes.push(note);
  }

  async close(): Promise<void> {
    await this.ctx.close().catch(() => {});
  }
}
