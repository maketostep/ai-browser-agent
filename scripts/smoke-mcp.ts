import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Поднимает MCP-сервер так же, как Claude Code по .mcp.json, и проверяет, что
// протокол по stdout не засорён печатью.
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["--import", "tsx", "src/mcp.ts"] }));
const { tools } = await client.listTools();
console.log(tools.map((tool) => tool.name).join(", "));
const observed = await client.callTool({ name: "observe", arguments: {} });
console.log(JSON.stringify(observed).slice(0, 300));
await client.close();
