import "dotenv/config";
import fs from "fs";
import { loadConfig } from "./config";
import { AuthService } from "./auth";
import { SessionManager } from "./session-manager";
import { startWsServer } from "./ws-server";

function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.tokensDir, { recursive: true });

  console.log(
    `[bridge] target=${cfg.mcHost}:${cfg.mcPort} version=${cfg.mcVersion} tokensDir=${cfg.tokensDir}`,
  );

  const auth = new AuthService(cfg.tokensDir);
  const sessions = new SessionManager(cfg);
  const server = startWsServer(cfg, auth, sessions);

  const shutdown = (signal: string) => {
    console.log(`[bridge] received ${signal}, shutting down`);
    sessions.shutdownAll(`bridge ${signal}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
