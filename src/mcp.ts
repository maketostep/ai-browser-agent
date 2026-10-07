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
// Плагин Claude Code запускает сервер из чужого проекта: профиль кладём туда, где
// он переживёт и смену проекта, и обновление плагина.
const session = new BrowserSession(askHuman, {
  profileDir: process.env["AGENT_PROFILE_DIR"],
  startUrl: process.env["START_URL"],
});
const actions = new Actions(session);
const gate = new SecurityGate(askHuman, floorOnlyClassifier, process.env["AGENT_AUTO_APPROVE"] === "1");
registerTools(server, { actions, gate, askHuman });

await server.connect(new StdioServerTransport());

// Клиент закрыл stdin - закрываем и браузер, иначе Chrome держит профиль.
const shutdown = (): void => {
  void session.close().then(() => process.exit(0));
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
