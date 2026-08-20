// Public Streamable-HTTP MCP endpoint: bearer-authenticated (stage 1) with a
// per-session Server delegating into the shared GatewayCore. Stage 2 swaps the
// verifier for the OAuth provider and mounts the auth router — nothing here
// changes shape.

import { randomUUID } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";

import cors from "cors";
import express, { type Request, type Response } from "express";

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { ServeConfig } from "../config.js";
import { createGatewaySession, type CallIdentity, type GatewayCore } from "../gateway.js";
import { BoundedEventStore } from "./event-store.js";
import { SessionManager } from "./sessions.js";

export interface HttpGatewayOptions {
  core: GatewayCore;
  serve: ServeConfig;
  verifier: OAuthTokenVerifier;
  log?: (line: string) => void;
  /** Extra express wiring (stage 2 mounts the OAuth router here) before /mcp routes. */
  configureApp?: (app: express.Express) => void;
}

export interface HttpGateway {
  port: number;
  close(): Promise<void>;
}

function rpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export async function startHttpGateway(options: HttpGatewayOptions): Promise<HttpGateway> {
  const { core, serve, verifier } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const publicUrl = serve.publicUrl.replace(/\/+$/u, "");
  const allowedHosts = serve.allowedHosts ?? [new URL(publicUrl).hostname];
  const sessions = new SessionManager({
    ttlMs: serve.session.ttlMs,
    maxSessions: serve.session.maxSessions,
    log,
  });

  const app = express();
  app.set("trust proxy", true);
  app.use(hostHeaderValidation(allowedHosts));
  app.use(
    "/mcp",
    cors({
      origin: serve.allowedOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "mcp-session-id",
        "last-event-id",
        "mcp-protocol-version",
      ],
      exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    }),
  );
  app.use(express.json({ limit: "4mb" }));
  options.configureApp?.(app);

  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
  });

  const withExistingSession = async (req: Request, res: Response): Promise<void> => {
    const auth = req.auth;
    if (auth === undefined) {
      res.status(500).json(rpcError(-32000, "auth middleware did not run"));
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || sessionId === "") {
      res.status(400).json(rpcError(-32000, "Bad Request: no session ID provided"));
      return;
    }
    const found = sessions.get(sessionId, auth.clientId);
    if (found === "forbidden") {
      res.status(403).json(rpcError(-32000, "session belongs to a different client"));
      return;
    }
    if (found === undefined) {
      res.status(404).json(rpcError(-32001, "session not found"));
      return;
    }
    await found.transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", bearer, async (req: Request, res: Response) => {
    try {
      const auth = req.auth;
      if (auth === undefined) {
        res.status(500).json(rpcError(-32000, "auth middleware did not run"));
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string" && sessionId !== "") {
        await withExistingSession(req, res);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json(rpcError(-32000, "Bad Request: no valid session ID provided"));
        return;
      }
      if (!sessions.canCreate()) {
        res.status(429).json(rpcError(-32000, "too many concurrent sessions"));
        return;
      }

      const identity: CallIdentity = { clientId: auth.clientId };
      const extraUser = auth.extra?.["user"];
      if (typeof extraUser === "string") {
        identity.user = extraUser;
      }
      const session = createGatewaySession(core, identity);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new BoundedEventStore(serve.session.maxEventsPerSession),
        keepAliveMs: serve.session.keepAliveMs,
        onsessioninitialized: (sid) => {
          session.identity.sessionId = sid;
          sessions.register(sid, { transport, session, authKey: auth.clientId });
        },
        onsessionclosed: (sid) => {
          void sessions.remove(sid);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid !== undefined) {
          void sessions.remove(sid);
        } else {
          void session.close();
        }
      };
      // The SDK class types onclose as `| undefined`, which our
      // exactOptionalPropertyTypes flag rejects against the Transport
      // interface; the shapes are otherwise identical.
      await session.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`[gateway] /mcp POST failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, "internal error"));
      }
    }
  });

  app.get("/mcp", bearer, (req: Request, res: Response) => {
    void withExistingSession(req, res);
  });
  app.delete("/mcp", bearer, (req: Request, res: Response) => {
    void withExistingSession(req, res);
  });

  const listener: NodeHttpServer = await new Promise((resolve, reject) => {
    const server = app.listen(serve.port, serve.host, () => {
      resolve(server);
    });
    server.once("error", reject);
  });
  const address = listener.address();
  const port = address !== null && typeof address === "object" ? address.port : serve.port;
  log(`capability-gateway: http endpoint on ${serve.host}:${String(port)} (public ${publicUrl}/mcp)`);

  return {
    port,
    async close(): Promise<void> {
      await sessions.close();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
