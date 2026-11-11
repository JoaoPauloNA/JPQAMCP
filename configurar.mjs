#!/usr/bin/env node
// Mostra a configuração MCP com os caminhos locais do Node e do servidor.
//   node configurar.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.argv.length > 2) {
  console.error("use: node configurar.mjs");
  process.exit(1);
}

const aqui = dirname(fileURLToPath(import.meta.url));
const servidor = join(aqui, "server.mjs");
const configuracao = {
  mcpServers: {
    jpqamcp: { command: process.execPath, args: [servidor] },
  },
};
console.log(JSON.stringify(configuracao, null, 2));
