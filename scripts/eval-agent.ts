/**
 * Замер агента на локальных страницах из evals/tasks.ts: успех, шаги, токены, время.
 * Ходит в модель и тратит токены, поэтому в npm test не входит.
 *
 *   npm run eval                       все задачи по разу
 *   npm run eval -- --repeat 3         по три прогона, модель недетерминирована
 *   npm run eval -- pagination         одна задача по id
 *   npm run eval -- --visible          с видимым окном Chrome
 *
 * Гейт без человека отклоняет всё высокорисковое, как в scripts/run-task.ts.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserSession } from "../src/browser/session.js";
import { Actions } from "../src/browser/actions.js";
import { SecurityGate } from "../src/agent/security.js";
import { runTask, type StepUsage } from "../src/agent/loop.js";
import { provider } from "../src/agent/provider.js";
import type { AskHuman } from "../src/types.js";
import { TASKS } from "../evals/tasks.js";

process.loadEnvFile(".env");

const args = process.argv.slice(2);
const visible = args.includes("--visible");
const repeatAt = args.indexOf("--repeat");
const repeat = repeatAt === -1 ? 1 : Math.max(1, Number(args[repeatAt + 1]) || 1);
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--repeat");
const selected = ids.length > 0 ? TASKS.filter((t) => ids.includes(t.id)) : TASKS;
if (selected.length === 0) {
  console.error(`Нет задач с id ${ids.join(", ")}. Есть: ${TASKS.map((t) => t.id).join(", ")}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const task = TASKS.find((t) => req.url === `/${t.id}`);
  res.writeHead(task ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(task?.html ?? "");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const config = provider();
console.log(`Провайдер: ${config.label}, модель: ${config.mainModel}, задач: ${selected.length}, повторов: ${repeat}`);

const askHuman: AskHuman = async () => "n";
const session = new BrowserSession(askHuman, { headless: !visible, profileDir: ".profile-eval" });
await session.start("about:blank");

type Row = { id: string; ok: boolean; steps: number; tokens: number; seconds: number; answer: string };
const rows: Row[] = [];

try {
  for (const t of selected) {
    for (let run = 1; run <= repeat; run++) {
      const url = `${base}/${t.id}`;
      await session.page().goto(url);
      let steps = 0;
      let tokens = 0;
      let answer = "";
      const onStep = (u: StepUsage): void => {
        steps = u.step;
        tokens += u.input + u.output;
      };
      const started = Date.now();
      try {
        await runTask(
          t.task.replace("{url}", url),
          { actions: new Actions(session), gate: new SecurityGate(askHuman), askHuman },
          undefined,
          { onStep, onFinish: (s) => (answer = s) },
        );
      } catch (err) {
        console.error(`прогон ${t.id} упал: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Ноль шагов - агент ничего не сделал. Задачи на отказ гейта проходят проверку
      // бездействием, и без этого условия таблица засчитала бы им успех.
      const ok = steps > 0 && (await t.check(session.page(), answer).catch(() => false));
      rows.push({ id: t.id, ok, steps, tokens, seconds: Math.round((Date.now() - started) / 100) / 10, answer });
    }
  }
} finally {
  await session.close();
  server.close();
}

console.log("\nЗадача               Успех   Шаги   Токены   Секунды");
for (const r of rows) {
  console.log(`${r.id.padEnd(20)} ${(r.ok ? "да" : "НЕТ").padEnd(7)} ${String(r.steps).padEnd(6)} ${String(r.tokens).padEnd(8)} ${r.seconds}`);
}
// По провалу видно, где агент ошибся: соврал в ответе или не дошёл до finish.
for (const r of rows.filter((x) => !x.ok)) {
  console.log(`\n${r.id}: ${r.answer ? r.answer.replace(/\s+/g, " ").slice(0, 300) : "(без finish)"}`);
}
const passed = rows.filter((r) => r.ok).length;
console.log(`\nУспешно ${passed} из ${rows.length}, токенов всего ${rows.reduce((s, r) => s + r.tokens, 0)}`);
process.exitCode = passed === rows.length ? 0 : 1;
