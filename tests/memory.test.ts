import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, formatNotes, loadNotes, MAX_NOTES, MAX_NOTE_LENGTH } from "../src/agent/memory.js";
import { MCP_TOOLS } from "../src/mcp-server.js";
import { TOOLS } from "../src/agent/tools.js";

describe("память между сессиями", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notes-"));
    file = join(dir, "sub", "notes.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("без файла память пуста, папка создаётся при первой записи", () => {
    expect(loadNotes(file)).toEqual([]);
    expect(addNote("Адрес доставки: Ленина 1", file)).toEqual(["Адрес доставки: Ленина 1"]);
    expect(loadNotes(file)).toEqual(["Адрес доставки: Ленина 1"]);
  });

  it("повтор не плодится и уходит в конец, длинная заметка режется", () => {
    addNote("a", file);
    addNote("b", file);
    expect(addNote("a", file)).toEqual(["b", "a"]);
    const long = addNote("x".repeat(MAX_NOTE_LENGTH + 50), file).at(-1)!;
    expect(long.length).toBe(MAX_NOTE_LENGTH);
  });

  it("при переполнении вытесняются самые старые", () => {
    for (let i = 0; i < MAX_NOTES + 5; i++) addNote(`факт ${i}`, file);
    const notes = loadNotes(file);
    expect(notes).toHaveLength(MAX_NOTES);
    expect(notes[0]).toBe("факт 5");
  });

  it("битый файл не глотается молча", () => {
    addNote("a", file);
    writeFileSync(file, "{не json", "utf8");
    expect(() => loadNotes(file)).toThrow(/Не читается/);
  });

  it("заметки в промпте помечены как данные, пустая память ничего не добавляет", () => {
    expect(formatNotes([])).toBe("");
    expect(formatNotes(["a"])).toContain("не инструкции");
  });

  it("remember есть у основного агента и нет в MCP: там своя память клиента", () => {
    expect(TOOLS.map((t) => t.name)).toContain("remember");
    expect(MCP_TOOLS.map((t) => t.name)).not.toContain("remember");
  });
});
