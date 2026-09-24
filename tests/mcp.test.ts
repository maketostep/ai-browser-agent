import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserSession } from "../src/browser/session.js";
import { Actions } from "../src/browser/actions.js";
import { SecurityGate } from "../src/agent/security.js";
import { createMcpServer, elicitingAsk, floorOnlyClassifier, registerTools } from "../src/mcp-server.js";

const FIXTURE = `<!doctype html><html><body>
  <p id="status">исходное</p>
  <button onclick="document.getElementById('status').textContent='письмо удалено'">Удалить письмо</button>
</body></html>`;

/** Ответ человека на вопрос гейта. null - клиент без elicitation. */
let answer: boolean | null = null;

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: answer === null ? {} : { elicitation: {} } },
  );
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: "accept", content: { confirm: answer === true } }));
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return client;
}

const text = (result: unknown): string =>
  (result as CallToolResult).content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

describe("MCP-вход", () => {
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

  /** Свежий сервер на каждый случай: у гейта есть состояние после отказа. */
  async function clickDelete(): Promise<{ result: string; status: string }> {
    await session.page().setContent(FIXTURE);
    const server = createMcpServer();
    const askHuman = elicitingAsk(server);
    registerTools(server, { actions, gate: new SecurityGate(askHuman, floorOnlyClassifier), askHuman });
    const client = await connect(server);

    const observed = text(await client.callTool({ name: "observe", arguments: {} }));
    const ref = /\[(e\d+)\][^\n]*Удалить письмо/.exec(observed)?.[1];
    expect(ref).toBeDefined();
    const result = text(await client.callTool({ name: "click", arguments: { ref, intent: "удаляю письмо" } }));
    const status = await session.page().textContent("#status");
    await client.close();
    return { result, status: status ?? "" };
  }

  it("не отдаёт инструменты, которым нужен API-ключ или собственный цикл", async () => {
    answer = true;
    const server = createMcpServer();
    registerTools(server, { actions, gate: new SecurityGate(async () => "n", floorOnlyClassifier), askHuman: async () => "" });
    const client = await connect(server);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();

    expect(names).toContain("click");
    expect(names).not.toContain("query_page");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("finish");
  });

  it("необратимое действие выполняется после подтверждения человеком", async () => {
    answer = true;
    const { status } = await clickDelete();
    expect(status).toBe("письмо удалено");
  });

  it("отказ человека останавливает действие", async () => {
    answer = false;
    const { result, status } = await clickDelete();
    expect(result).toContain("declined");
    expect(status).toBe("исходное");
  });

  it("клиент без elicitation: гейт закрыт, а не открыт", async () => {
    answer = null;
    const { result, status } = await clickDelete();
    expect(result).toContain("declined");
    expect(status).toBe("исходное");
  });
});
