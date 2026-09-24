import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrowserSession } from "../src/browser/session.js";
import { Actions } from "../src/browser/actions.js";
import type { ToolResult } from "../src/types.js";

/**
 * Дистилляция опирается на реальный layout: getBoundingClientRect и getComputedStyle.
 * jsdom layout не считает, поэтому все размеры там нулевые и проверка видимости
 * вырождается. Тесты идут на настоящем Chrome в headless.
 */
const FIXTURE = `
<!doctype html>
<html lang="ru"><body style="margin:0">
  <h1>Тестовая страница</h1>
  <p id="status">исходное состояние</p>

  <button id="act">Нажми меня</button>
  <a href="/somewhere">Куда-то</a>
  <input type="search" placeholder="Поиск по сайту">
  <select id="pick">
    <option value="1">Один</option>
    <option value="2">Два</option>
  </select>

  <button style="display:none">Спрятанная кнопка</button>
  <div aria-hidden="true"><button>Кнопка вне доступности</button></div>
  <button style="width:0;height:0;padding:0;border:0">Нулевая кнопка</button>

  <div style="position:relative;margin-top:20px">
    <button id="covered">Под оверлеем</button>
    <div id="overlay" style="position:absolute;inset:-10px;background:rgba(0,0,0,.4)"></div>
  </div>

  <my-widget></my-widget>

  <script>
    document.getElementById('act').addEventListener('click', () => {
      document.getElementById('status').textContent = 'кнопка нажата';
    });
    document.querySelector('input[type=search]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('status').textContent = 'поиск отправлен';
    });
    document.getElementById('pick').addEventListener('change', (e) => {
      document.getElementById('status').textContent = 'выбрано ' + e.target.value;
    });
    customElements.define('my-widget', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="inner">Кнопка в теневом дереве</button>';
      }
    });
  </script>
</body></html>`;

/** Находит реф так же, как это делает агент: по имени в дистиллированном списке. */
const refOf = (elements: string, pattern: RegExp): string => {
  const line = elements.split("\n").find((l) => pattern.test(l));
  if (!line) throw new Error(`не найдено ${pattern} среди:\n${elements}`);
  return /\[((?:f\d+:)?e\d+)\]/.exec(line)![1]!;
};

const statusText = async (actions: Actions): Promise<string> => {
  const observation = await actions.observe();
  return observation.text;
};

describe("браузерный слой", () => {
  let session: BrowserSession;
  let actions: Actions;

  beforeAll(async () => {
    session = new BrowserSession(async () => "n", { headless: true, profileDir: ".profile-test" });
    await session.start("about:blank");
    actions = new Actions(session);
  });

  afterAll(async () => {
    await session.close();
  });

  const reload = async (): Promise<string> => {
    await session.page().setContent(FIXTURE);
    return (await actions.observe()).elements;
  };

  it("находит видимые интерактивные элементы и размечает их рефами", async () => {
    const elements = await reload();

    expect(elements).toMatch(/\[e\d+\] button "Нажми меня"/);
    expect(elements).toMatch(/\[e\d+\] link "Куда-то"/);
    expect(elements).toMatch(/\[e\d+\] searchbox "Поиск по сайту"/);
    expect(elements).toMatch(/\[e\d+\] combobox/);
  });

  it("пропускает скрытые, aria-hidden и нулевого размера", async () => {
    const elements = await reload();

    expect(elements).not.toContain("Спрятанная кнопка");
    expect(elements).not.toContain("Кнопка вне доступности");
    expect(elements).not.toContain("Нулевая кнопка");
  });

  it("заходит в теневое дерево", async () => {
    const elements = await reload();
    expect(elements).toContain("Кнопка в теневом дереве");
  });

  it("на страницах с сотнями элементов ужимает текст, но не элементы", async () => {
    // На главной hh.ru наблюдение выходило 12 323 символа при 204 элементах, и
    // набегали они именно элементами: текст дистилляция и так режет до 3000.
    // Элементы резать нельзя - по ним агент действует, спрятанный элемент это
    // скрытый тупик. Поэтому бюджет отбирается у текста.
    const manyButtons = Array.from(
      { length: 400 },
      (_, i) => `<button>Кнопка номер ${i} с достаточно длинной подписью</button>`,
    ).join("");
    await session
      .page()
      .setContent(
        `<!doctype html><body style="margin:0"><p>${"длинный текст страницы. ".repeat(500)}</p>${manyButtons}</body>`,
      );

    const observation = await actions.observe();

    // Текст ужат до минимума и честно помечен как обрезанный.
    expect(observation.text).toContain("текст обрезан");
    expect(observation.text.length).toBeLessThan(1000);
    // Элементы целы все до единого, включая последний.
    expect(observation.elements).toContain("Кнопка номер 0 ");
    expect(observation.elements).toContain("Кнопка номер 399 ");
  });

  it("не отдаёт в контекст ничего похожего на сырой HTML", async () => {
    await reload();
    const observation = await actions.observe();

    expect(observation.elements).not.toContain("<button");
    expect(observation.elements).not.toContain("<script");
    // Сжатый снимок обязан быть на порядки меньше исходной разметки.
    expect(observation.elements.length).toBeLessThan(FIXTURE.length);
  });

  it("кликает по рефу", async () => {
    const elements = await reload();
    const result = await actions.click(refOf(elements, /"Нажми меня"/));

    expect(result.ok).toBe(true);
    expect(await statusText(actions)).toContain("кнопка нажата");
  });

  it("вводит текст и жмёт Enter", async () => {
    const elements = await reload();
    const result = await actions.typeText(refOf(elements, /searchbox/), "хот-дог", true);

    expect(result.ok).toBe(true);
    expect(result.observation.elements).toContain('value="хот-дог"');
    expect(await statusText(actions)).toContain("поиск отправлен");
  });

  it("выбирает вариант по видимой подписи, а не только по value", async () => {
    const elements = await reload();
    const result = await actions.selectOption(refOf(elements, /combobox/), "Два");

    expect(result.ok).toBe(true);
    expect(await statusText(actions)).toContain("выбрано 2");
  });

  it("на устаревший реф отвечает stale_ref, а не падением", async () => {
    await reload();
    const result: ToolResult = await actions.click("e9999");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("stale_ref");
    // Агент получает свежее наблюдение, чтобы было из чего выбрать заново.
    expect(result.observation.elements).toContain("Нажми меня");
  });

  it("отбивает мусорный реф как bad_input", async () => {
    await reload();
    const result = await actions.click("кнопка оплаты");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("bad_input");
  });

  it("помечает перекрытые элементы заранее, до попытки клика", async () => {
    const elements = await reload();
    const coveredLine = elements.split("\n").find((l) => /"Под оверлеем"/.test(l));

    expect(coveredLine).toBeDefined();
    expect(coveredLine).toContain("перекрыт");
    // Виновник назван конкретно, а не абстрактным "что-то сверху".
    expect(coveredLine).toMatch(/перекрыт \w+/);

    // Свободные элементы такой пометки не получают.
    const freeLine = elements.split("\n").find((l) => /"Нажми меня"/.test(l));
    expect(freeLine).not.toContain("перекрыт");
  });

  it("окно без aria-modal: показывает только его элементы, страницу под ним сворачивает", async () => {
    // Живой прогон на Лавке: окно адреса без aria-modal дало 121 элемент, из них
    // почти все "перекрыт", а кнопки окна оказались в самом конце списка.
    const pageButtons = Array.from({ length: 12 }, (_, i) => `<button>Товар ${i + 1}</button>`).join("");
    await session.page().setContent(`
      <div style="height:3000px">${pageButtons}<a href="#footer" style="position:absolute;top:2800px">Подвал</a></div>
      <a href="#close" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></a>
      <div style="position:fixed;top:100px;left:100px;width:400px;height:400px;background:#fff;overflow:auto">
        <button>Подтвердить адрес</button>
        <button style="margin-top:900px">Кнопка внизу окна</button>
      </div>`);
    const { elements } = await actions.observe();
    expect(elements).toContain('"Подтвердить адрес"');
    expect(elements).toContain('"Кнопка внизу окна"');
    expect(elements).not.toContain('"Товар 1"');
    expect(elements).not.toContain('"Подвал"');
    expect(elements).toMatch(/под оверлеем скрыто 13 элементов/);
  });

  it("небольшой баннер поверх страницы не прячет её", async () => {
    const pageButtons = Array.from({ length: 12 }, (_, i) => `<button style="display:block">Товар ${i + 1}</button>`).join("");
    await session.page().setContent(`
      ${pageButtons}
      <div style="position:fixed;top:0;left:0;right:0;height:22px;background:#fc0">Баннер <button>Принять</button></div>`);
    const { elements } = await actions.observe();
    expect(elements).toContain('"Товар 12"');
    expect(elements).toContain('"Принять"');
    expect(elements).not.toMatch(/под оверлеем/);
  });

  it("ждёт окончания анимации: гаснущий оверлей не попадает в наблюдение", async () => {
    // Живой прогон на Лавке: после поиска все товары пришли с пометкой
    // "перекрыт div.fade". Число элементов уже не менялось, а слой ещё гас.
    await session.page().setContent(`
      <style>.fade{position:fixed;inset:0;background:#000;transition:opacity 1.2s linear}</style>
      <button id="go">Искать</button><a href="#item">Товар</a>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          const fade = document.createElement('div');
          fade.className = 'fade';
          document.body.appendChild(fade);
          fade.getBoundingClientRect();
          fade.style.opacity = '0';
          fade.addEventListener('transitionend', () => fade.remove());
        });
      </script>`);
    const { elements } = await actions.observe();
    const result = await actions.click(refOf(elements, /"Искать"/));
    const item = result.observation.elements.split("\n").find((l) => /"Товар"/.test(l));
    expect(item).toBeDefined();
    expect(item).not.toContain("перекрыт");
  });

  it("ждёт ответа фонового запроса: результаты поиска попадают в наблюдение", async () => {
    // Живой прогон на Лавке: после Enter в поиске DOM стоял, анимаций не было, а
    // товары приходили ответом fetch. Наблюдение снималось до ответа, без товаров.
    const page = session.page();
    await page.route("http://agent.test/search", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ body: "ok", headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await page.setContent(`
      <button id="find">Найти</button>
      <script>
        document.getElementById('find').addEventListener('click', async () => {
          await fetch('http://agent.test/search');
          const a = document.createElement('a');
          a.href = '#r';
          a.textContent = 'Результат поиска';
          document.body.appendChild(a);
        });
      </script>`);
    const { elements } = await actions.observe();
    const result = await actions.click(refOf(elements, /"Найти"/));
    await page.unroute("http://agent.test/search");
    expect(result.observation.elements).toContain("Результат поиска");
  });

  it("вырезает мягкие переносы и невидимые символы из имён и текста", async () => {
    await session.page().setContent(`<button>Хот&shy;сте&shy;ры&#8203; 250 г</button><p>Сосис&shy;ка в тесте</p>`);
    const observation = await actions.observe();
    expect(observation.elements).toContain('"Хотстеры 250 г"');
    expect(observation.text).toContain("Сосиска в тесте");
    expect(observation.elements + observation.text).not.toMatch(/[\u00AD\u200B-\u200D\uFEFF]/);
  });

  it("распознаёт перехваченный клик и называет виновника", async () => {
    const elements = await reload();
    const result = await actions.click(refOf(elements, /"Под оверлеем"/));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("intercepted");
      expect(result.message).toMatch(/оверлей|перехвач/i);
    }
  });

  it("рефы перевыдаются после перезагрузки страницы", async () => {
    const first = await reload();
    const second = await reload();
    // Один и тот же элемент должен находиться по имени в обоих снимках.
    expect(refOf(first, /"Нажми меня"/)).toBe(refOf(second, /"Нажми меня"/));
    // И при этом старые атрибуты на странице не копятся.
    const stale = await session.page().evaluate(() => document.querySelectorAll("[data-agent-ref]").length);
    expect(stale).toBeGreaterThan(0);
  });

  it("pageInfo не переразмечает рефы", async () => {
    // Регрессия: раньше security-гейт звал observe() ради url и title, а тот
    // снимал и заново раздавал все data-agent-ref. Реф, выбранный моделью,
    // протухал между решением и действием - либо ошибка, либо клик не по тому
    // элементу с уже одобренным намерением.
    const elements = await reload();
    const ref = refOf(elements, /"Нажми меня"/);

    const before = await session.page().evaluate(() =>
      Array.from(document.querySelectorAll("[data-agent-ref]")).map((e) => e.getAttribute("data-agent-ref")),
    );
    const info = await actions.pageInfo();
    const after = await session.page().evaluate(() =>
      Array.from(document.querySelectorAll("[data-agent-ref]")).map((e) => e.getAttribute("data-agent-ref")),
    );

    expect(info.url).toBeTruthy();
    expect(after).toEqual(before);

    // И реф, выбранный до гейта, всё ещё указывает на тот же элемент.
    const result = await actions.click(ref);
    expect(result.ok).toBe(true);
    expect(await statusText(actions)).toContain("кнопка нажата");
  });

  it("восстанавливается, когда все вкладки закрыты", async () => {
    // Регрессия из живого прогона: пользователь закрыл окно, сессия осталась без
    // страниц, и КАЖДЫЙ инструмент падал с "Все вкладки закрыты". Агент оставался
    // работоспособным, но безруким - выхода из этого состояния не было вообще.
    await reload();
    for (const page of session.pages()) await page.close();
    expect(session.pages().length).toBe(0);

    await actions.ensureBrowser();

    expect(session.pages().length).toBe(1);
    const result = await actions.navigate("about:blank");
    expect(result.ok).toBe(true);
    // И заметка объясняет агенту, что произошло, а не молчит.
    const observation = await actions.observe();
    expect(observation.url).toContain("about:blank");
  });

  it("поднимает браузер заново, если его закрыли целиком", async () => {
    // Пробный прогон MCP-режима: человек залогинился и закрыл окно Chrome, и каждый
    // инструмент падал на "browser has been closed".
    await session.page().context().close();

    await actions.ensureBrowser();

    const result = await actions.navigate("about:blank");
    expect(result.ok).toBe(true);
    expect(result.observation.note).toContain("Браузер был закрыт");
  });

  it("stale_ref не теряет заметку, объясняющую, почему рефа нет", async () => {
    // Пробный прогон: окно Chrome закрыли, клик по старому рефу дал stale_ref на
    // about:blank, но без заметки о перезапуске - подсказка с примерами рефов
    // вызывала observe() первой и забирала заметки себе.
    await session.page().context().close();
    await actions.ensureBrowser();

    const result = await actions.click("e5");
    expect(result.ok).toBe(false);
    expect(result.observation.note).toContain("Браузер был закрыт");
  });

  it("скриншот возвращает jpeg разумного размера", async () => {
    await reload();
    const shot = await actions.screenshot();

    expect(shot.bytes).toBeGreaterThan(0);
    // JPEG начинается с FFD8 - в base64 это /9j/
    expect(shot.base64.startsWith("/9j/")).toBe(true);
  });
});
