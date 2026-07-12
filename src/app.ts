import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server.js";
import { WeatherService } from "./services/weather.js";

export interface AppOptions {
  weatherService?: WeatherService;
  allowedOrigins?: readonly string[];
}

function normalizeAllowedOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error(`Invalid MCP allowed origin: ${value}`);
  }
  return url.origin;
}

function configuredOrigins(explicit?: readonly string[]): ReadonlySet<string> {
  const values = explicit ?? (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return new Set(values.map(normalizeAllowedOrigin));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function originAllowed(req: Request, originHeader: string, allowedOrigins: ReadonlySet<string>): boolean {
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.origin !== originHeader) return false;
  if (allowedOrigins.has(origin.origin)) return true;

  // Local browser clients are allowed only when both Origin and Host are the same
  // loopback address. Public deployments must opt browser origins in explicitly.
  const requestHost = req.get("host")?.toLowerCase();
  return isLoopbackHostname(origin.hostname) && requestHost === origin.host.toLowerCase();
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  const weatherService = options.weatherService ?? new WeatherService();
  const allowedOrigins = configuredOrigins(options.allowedOrigins);
  app.disable("x-powered-by");

  app.use("/mcp", (req, res, next) => {
    const origin = req.get("origin");
    // Non-browser MCP clients (including remote server-to-server calls) normally
    // omit Origin. The MCP transport requirement applies when the header exists.
    if (origin === undefined || originAllowed(req, origin, allowedOrigins)) {
      next();
      return;
    }
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Forbidden: invalid Origin header" },
      id: null
    });
  });
  app.use(express.json({ limit: "64kb", strict: true }));

  app.get("/", (_req, res) => {
    res.status(200).json({ status: "ok", service: "mood-transit", version: "1.0.0", mcpEndpoint: "/mcp" });
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "mood-transit", version: "1.0.0" });
  });

  app.get("/readyz", (_req, res) => {
    res.status(200).json({ status: "ready" });
  });

  app.post("/mcp", async (req, res, next) => {
    const server = createMcpServer(weatherService);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    res.on("close", () => { void cleanup(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await cleanup();
      next(error);
    }
  });

  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for stateless Streamable HTTP." },
      id: null
    });
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const isSyntaxError = error instanceof SyntaxError;
    const isTooLarge = typeof error === "object" && error !== null && "status" in error && error.status === 413;
    res.status(isTooLarge ? 413 : isSyntaxError ? 400 : 500).json({
      jsonrpc: "2.0",
      error: {
        code: isTooLarge ? -32001 : isSyntaxError ? -32700 : -32603,
        message: isTooLarge ? "Request body exceeds 64kb" : isSyntaxError ? "Invalid JSON" : "Internal server error"
      },
      id: null,
      path: req.path
    });
  });

  return app;
}
