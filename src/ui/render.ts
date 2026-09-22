/**
 * Печать в терминал. На видео этот вывод - половина результата: видно, какие
 * инструменты агент зовёт и с какими аргументами.
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max) + c.dim(` …+${s.length - max} симв.`);

export function banner(lines: string[]): void {
  console.log();
  for (const line of lines) console.log("  " + line);
  console.log();
}

export function assistant(text: string): void {
  if (!text.trim()) return;
  console.log(`\n${c.bold("🤖 Агент:")} ${text.trim()}`);
}

export function thinking(text: string): void {
  if (!text.trim()) return;
  console.log(c.dim(`\n💭 ${truncate(text.trim(), 400)}`));
}

export function toolCall(name: string, input: unknown): void {
  console.log(`\n${c.cyan("🔧 Вызов:")} ${c.bold(name)}`);
  console.log(c.dim(`   Аргументы: ${truncate(JSON.stringify(input), 300)}`));
}

export function toolResult(ok: boolean, message: string): void {
  const icon = ok ? c.green("   ✓") : c.red("   ✗");
  console.log(`${icon} ${truncate(message.replace(/\n/g, "\n     "), 400)}`);
}

export function subagentStart(label: string, question: string): void {
  console.log(`\n${c.magenta("🧠 Sub-agent")} ${c.dim(`(${label})`)}: ${truncate(question, 160)}`);
}

export function subagentResult(answer: string): void {
  console.log(c.magenta(`   ↳ ${truncate(answer.replace(/\n/g, "\n     "), 500)}`));
}

export function securityGate(action: string, reason: string): void {
  console.log(`\n${c.yellow("🔒 Security gate")} ${c.bold("HIGH")}`);
  console.log(`   Действие: ${action}`);
  console.log(`   Причина:  ${reason}`);
}

export function gateDecision(approved: boolean): void {
  console.log(approved ? c.green("   → подтверждено человеком") : c.red("   → отклонено человеком"));
}

export function usage(u: { input: number; output: number; cacheRead: number; step: number }): void {
  console.log(
    c.dim(
      `   [шаг ${u.step}] токены in=${u.input} out=${u.output} cache_read=${u.cacheRead}`,
    ),
  );
}

export function info(text: string): void {
  console.log(c.dim(`   ${text}`));
}

export function warn(text: string): void {
  console.log(c.yellow(`   ! ${text}`));
}

export function error(text: string): void {
  console.log(c.red(`   ✗ ${text}`));
}
