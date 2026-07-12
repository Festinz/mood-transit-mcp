import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";

export function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "8000");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : 8000;
}

export function startServer(): ReturnType<ReturnType<typeof createApp>["listen"]> {
  const port = parsePort(process.env.PORT);
  const app = createApp();
  const server = app.listen(port, "0.0.0.0", () => {
    process.stdout.write(`MoodTransit MCP listening on 0.0.0.0:${port}\n`);
  });
  return server;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const server = startServer();
  const shutdown = (signal: string): void => {
    process.stdout.write(`Received ${signal}; shutting down\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
