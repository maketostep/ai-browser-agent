/**
 * Дистилляция DOM.
 *
 * Замер на реальной странице крупного SPA (цифры и источник в RESEARCH.md):
 * raw HTML 430 954 симв., Playwright ariaSnapshot() 7 153 симв., эта функция
 * 2 321 симв. при 63 интерактивных элементах. Сжатие 186x относительно raw HTML.
 *
 * Функция distillPage исполняется в контексте страницы через page.evaluate,
 * поэтому она обязана быть самодостаточной: никаких ссылок на внешний скоуп,
 * никаких импортов внутри тела.
 */

export type DistillResult = {
  /** Построчно: `[e3] searchbox "Поиск" [value="хот-дог"]` */
  elements: string;
  /** Видимый текст страницы, обрезанный до лимита */
  text: string;
  /** Сколько интерактивных элементов размечено */
  count: number;
};

export type DistillOptions = {
  /** Префикс рефа для фреймов: "" для главного, "f1" для первого дочернего */
  prefix: string;
  /** Лимит на innerText */
  maxText: number;
};

/**
 * Исполняется ВНУТРИ страницы. Не рефакторить в сторону внешних зависимостей.
 */
export function distillPage(opts: DistillOptions): DistillResult {
  const { prefix, maxText } = opts;
  const out: string[] = [];
  const seen = new Set<Element>();
  let n = 0;

  // Мягкие переносы и символы нулевой ширины: на Лавке "Хот\u00ADсте\u00ADры". Человеку
  // не видны, но тратят токены и ломают модели совпадение текста.
  const INVISIBLE = /[\u00AD\u200B-\u200D\uFEFF]/g;
  const INTERACTIVE_TAGS = ["a", "button", "input", "select", "textarea", "summary"];
  const INTERACTIVE_ROLES =
    /^(button|link|tab|checkbox|radio|menuitem|menuitemcheckbox|menuitemradio|option|searchbox|textbox|combobox|switch|slider|spinbutton)$/;

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity === "0") return false;
    // aria-hidden прячет элемент от вспомогательных технологий, но не от глаза.
    // Мы всё равно его пропускаем: кликать по тому, что скрыто от a11y, обычно
    // ошибка, и такие элементы чаще всего дубликаты видимых.
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return null;
  };

  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    let fromLabelledBy = "";
    if (labelledBy) {
      fromLabelledBy = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
    }
    const candidates = [
      el.getAttribute("aria-label"),
      fromLabelledBy,
      el.getAttribute("placeholder"),
      el.getAttribute("alt"),
      el.getAttribute("title"),
      (el as HTMLElement).innerText,
      el.getAttribute("value"),
      el.getAttribute("name"),
    ];
    const picked = candidates.find((c) => c && c.trim().length > 0) ?? "";
    return picked.replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, 80);
  };

  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.includes(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.test(role.trim().toLowerCase())) return true;
    if (el.hasAttribute("onclick")) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
  };

  /**
   * Кто реально лежит в центре элемента. Если это не он сам и не его потомок,
   * клик перехватят - ровно та ошибка, которую иначе агент узнаёт только ударившись.
   * Помечаем заранее, чтобы он не тратил шаги на заведомо обречённые клики.
   */
  const obscuredBy = (el: Element): string | null => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Центр вне вьюпорта - судить не о чем, элемент просто надо доскроллить.
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;

    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top)) return null;

    const cls = typeof top.className === "string" ? top.className.trim().split(/\s+/)[0] : "";
    return top.tagName.toLowerCase() + (cls ? "." + cls : "");
  };

  const stateOf = (el: Element, role: string): string[] => {
    const state: string[] = [];
    const input = el as HTMLInputElement;
    if (input.disabled || el.getAttribute("aria-disabled") === "true") state.push("disabled");
    if (input.checked || el.getAttribute("aria-checked") === "true") state.push("checked");
    if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
    if (el.getAttribute("aria-selected") === "true") state.push("selected");
    const isTextual = role === "textbox" || role === "searchbox" || role === "combobox";
    if (isTextual && input.value) {
      state.push('value="' + String(input.value).replace(INVISIBLE, "").replace(/\s+/g, " ").slice(0, 40) + '"');
    }
    return state;
  };

  const walk = (root: Document | ShadowRoot): void => {
    const all = root.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if (seen.has(el)) continue;
      seen.add(el);

      // Web components: интерактив часто спрятан в теневом дереве.
      if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot as ShadowRoot);

      if (!isInteractive(el)) continue;
      const role = roleOf(el);
      if (!role) continue;
      if (!isVisible(el)) continue;

      n += 1;
      const ref = (prefix ? prefix + ":" : "") + "e" + n;
      el.setAttribute("data-agent-ref", ref);

      const name = nameOf(el);
      const state = stateOf(el, role);
      const blocker = obscuredBy(el);
      if (blocker) state.push("перекрыт " + blocker);
      const suffix = state.length > 0 ? " [" + state.join(",") + "]" : "";
      out.push("[" + ref + "] " + role + " " + JSON.stringify(name) + suffix);
    }
  };

  // Рефы живут ровно один снапшот. Чистим предыдущие, чтобы устаревший реф
  // резолвился в промах, а не в случайный элемент.
  for (const stale of Array.from(document.querySelectorAll("[data-agent-ref]"))) {
    stale.removeAttribute("data-agent-ref");
  }
  walk(document);

  const rawText = (document.body?.innerText ?? "").replace(INVISIBLE, "").replace(/\n{3,}/g, "\n\n").trim();

  return {
    elements: out.join("\n"),
    text: rawText.slice(0, maxText),
    count: n,
  };
}
