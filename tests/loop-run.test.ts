import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mock = vi.hoisted(() => ({ script: [] as unknown[], firstPrompts: [] as string[], calls: 0 }));

vi.mock("../src/agent/client.js", () => {
  const stream = (params: { messages: { content: unknown }[] }) => {
    mock.firstPrompts.push(String(params.messages[0]?.content));
    const response = mock.script[mock.calls++];
    return { on: () => {}, finalMessage: async () => response };
  };
  return { client: () => ({ messages: { stream }, beta: { messages: { stream } } }) };
});

const { runTask } = await import("../src/agent/loop.js");
const { addNote } = await import("../src/agent/memory.js");
import type { ToolDeps } from "../src/agent/tools.js";

const turn = (name: string, input: object, usage = { input_tokens: 10, output_tokens: 5 }) => ({
  content: [{ type: "tool_use", id: `t-${Math.random()}`, name, input }],
  stop_reason: "tool_use",
  usage,
});

describe("runTask с подменой модели", () => {
  let dir: string;
  let deps: ToolDeps;

  beforeEach(() => {
    vi.stubEnv("AGENT_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    dir = mkdtempSync(join(tmpdir(), "loop-"));
    mock.script = [];
    mock.firstPrompts = [];
    mock.calls = 0;
    deps = {
      gate: { beginTask: () => {}, isMutating: () => false },
      actions: {
        ensureBrowser: async () => {},
        observe: async () => ({ url: "about:blank", title: "", elements: "", text: "", tabs: 1 }),
      },
      askHuman: async () => "",
      notesPath: join(dir, "notes.json"),
    } as unknown as ToolDeps;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finish даёт finished, onStep получает расход, заметки идут в первое сообщение", async () => {
    addNote("Адрес доставки: Ленина 1", deps.notesPath);
    mock.script = [turn("finish", { summary: "готово" })];
    const steps: number[] = [];

    const outcome = await runTask("задача", deps, undefined, { onStep: (u) => steps.push(u.input + u.output) });

    expect(outcome).toBe("finished");
    expect(steps).toEqual([15]);
    expect(mock.firstPrompts[0]).toContain("Адрес доставки: Ленина 1");
    expect(mock.firstPrompts[0]).toContain("не инструкции");
  });

  it("исчерпанный бюджет останавливает задачу до следующего запроса", async () => {
    mock.script = [turn("observe", {}, { input_tokens: 60, output_tokens: 60 }), turn("finish", { summary: "x" })];

    const outcome = await runTask("задача", deps, undefined, { tokenBudget: 100 });

    expect(outcome).toBeUndefined();
    expect(mock.firstPrompts).toHaveLength(1);
  });

  it("лимит шагов режет задачу, и это не finished", async () => {
    mock.script = [turn("observe", {}), turn("observe", {}), turn("observe", {})];

    const outcome = await runTask("задача", deps, undefined, { maxSteps: 2 });

    expect(outcome).toBeUndefined();
    expect(mock.firstPrompts).toHaveLength(2);
  });
});
