import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./browser/session.js";
import { Actions } from "./browser/actions.js";
import { SecurityGate } from "./agent/security.js";
import {
  createMcpServer,
  elicitingAsk,
  floorOnlyClassifier,
  redirectConsole,
  registerTools,
} from "./mcp-server.js";

// Первым делом: до любого вывода, иначе печать попадёт в протокол.
const drain = redirectConsole();

const server = createMcpServer();
const askHuman = elicitingAsk(server, drain);
const session = new BrowserSession(askHuman);
const actions = new Actions(session);
const gate = new SecurityGate(askHuman, floorOnlyClassifier);
registerTools(server, { actions, gate, askHuman });

await session.start(process.env["START_URL"] ?? "about:blank");
await server.connect(new StdioServerTransport());

// Клиент закрыл stdin - закрываем и браузер, иначе Chrome держит профиль.
const shutdown = (): void => {
  void session.close().then(() => process.exit(0));
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
