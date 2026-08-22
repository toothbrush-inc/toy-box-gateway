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
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { ServeConfig } from "../config.js";
import { createGatewaySession, type CallIdentity, type GatewayCore } from "../gateway.js";
import {
  renderCardHtml,
  renderCardJson,
  renderNoticeHtml,
  renderPreviewHtml,
  renderPreviewJson,
  renderViewsIndexHtml,
} from "../views/render.js";
import { BoundedEventStore } from "./event-store.js";
import { SESSION_COOKIE, type GatewayOAuthProvider } from "./oauth/provider.js";
import { SessionManager } from "./sessions.js";

export interface HttpGatewayOptions {
  core: GatewayCore;
  serve: ServeConfig;
  verifier: OAuthTokenVerifier;
  /** Stage 2: the gateway's own OAuth AS — mounts the auth router, the Google
   * callback, and browser-session (cookie) auth for the views surface. */
  oauth?: GatewayOAuthProvider;
  log?: (line: string) => void;
  /** Extra express wiring before /mcp routes. */
  configureApp?: (app: express.Express) => void;
}

export interface HttpGateway {
  port: number;
  close(): Promise<void>;
}

function rpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export async function startHttpGateway(options: HttpGatewayOptions): Promise<HttpGateway> {
  const { core, serve, verifier, oauth } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const publicUrl = serve.publicUrl.replace(/\/+$/u, "");
  const allowedHosts = serve.allowedHosts ?? [new URL(publicUrl).hostname];
  const sessions = new SessionManager({
    ttlMs: serve.session.ttlMs,
    maxSessions: serve.session.maxSessions,
    log,
  });

  const app = express();
  // Exactly one trusted hop (Caddy). `true` would let clients spoof their IP
  // via X-Forwarded-For and bypass the auth endpoints' rate limiting.
  app.set("trust proxy", 1);
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

  if (oauth !== undefined) {
    // The gateway is its own OAuth AS: metadata, DCR, authorize, token, revoke.
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(publicUrl),
        resourceServerUrl: new URL(`${publicUrl}/mcp`),
        ...(serve.auth.stage === "oauth" ? { scopesSupported: serve.auth.oauth.scopesSupported } : {}),
      }),
    );
    const secureCookies = publicUrl.startsWith("https:");
    app.get("/auth/google/callback", async (req: Request, res: Response) => {
      try {
        const result = await oauth.handleGoogleCallback({
          ...(typeof req.query["state"] === "string" ? { state: req.query["state"] } : {}),
          ...(typeof req.query["code"] === "string" ? { code: req.query["code"] } : {}),
          ...(typeof req.query["error"] === "string" ? { error: req.query["error"] } : {}),
        });
        if (result.sessionCookie !== undefined) {
          res.cookie(SESSION_COOKIE, result.sessionCookie, {
            httpOnly: true,
            secure: secureCookies,
            sameSite: "lax",
            maxAge: 7 * 86_400_000,
            path: "/",
          });
        }
        res.redirect(result.redirectTo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).type("text/plain").send(`sign-in failed: ${message}`);
      }
    });
    app.get("/login", (req: Request, res: Response) => {
      const next = typeof req.query["next"] === "string" ? req.query["next"] : "/views";
      res.redirect(oauth.startBrowserLogin(next));
    });
    app.get("/logout", (_req: Request, res: Response) => {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.status(200).type("text/plain").send("signed out");
    });
    // Caddy forward_auth target: 204 with a valid session, else redirect
    // browsers to /login and 401 everything else.
    app.get("/session/verify", (req: Request, res: Response) => {
      if (oauth.verifySessionCookie(readCookie(req, SESSION_COOKIE)) !== null) {
        res.status(204).end();
        return;
      }
      const forwarded = req.headers["x-forwarded-uri"];
      const accept = req.headers.accept ?? "";
      if (typeof forwarded === "string" || accept.includes("text/html")) {
        const next = typeof forwarded === "string" ? forwarded : "/";
        res.redirect(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      res.status(401).end();
    });
  }

  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
  });

  // Views accept a browser session cookie (stage 2) or the API bearer token;
  // unauthenticated browsers get sent to the login flow instead of a 401.
  const viewsAuth: express.RequestHandler = (req, res, next) => {
    if (oauth !== undefined) {
      if (oauth.verifySessionCookie(readCookie(req, SESSION_COOKIE)) !== null) {
        next();
        return;
      }
      if (req.headers.authorization === undefined && (req.headers.accept ?? "").includes("text/html")) {
        res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
    }
    bearer(req, res, next);
  };

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

  // The glanceable card surface. Bearer-authed like /mcp; HTML by default,
  // .json for machines. A failed last run renders as an error card, not a 500.
  const views = core.views;
  if (views !== undefined) {
    app.get("/views", viewsAuth, (req: Request, res: Response) => {
      const list = views.list().map((spec) => {
        const snapshot = views.getSnapshot(spec.id);
        return {
          id: spec.id,
          title: spec.title,
          sensitivity: spec.sensitivity,
          refresh: spec.refresh,
          updatedAt: spec.updatedAt,
          lastRun: snapshot?.startedAt ?? null,
          lastOk: snapshot?.ok ?? null,
        };
      });
      if ((req.headers.accept ?? "").includes("text/html")) {
        res
          .status(200)
          .type("text/html; charset=utf-8")
          .send(
            renderViewsIndexHtml(
              views.list().map((spec) => ({ spec, snapshot: views.getSnapshot(spec.id) })),
            ),
          );
        return;
      }
      res.status(200).json({ ok: true, data: { views: list } });
    });
    // Previews: rendered once by preview_view, held at an unguessable token
    // until they expire. Same auth as the pinned cards; never cached.
    app.get("/views/preview/:token", viewsAuth, (req: Request, res: Response) => {
      const raw = typeof req.params["token"] === "string" ? req.params["token"] : "";
      const wantsJson = raw.endsWith(".json");
      const token = wantsJson ? raw.slice(0, -".json".length) : raw;
      const preview = views.getPreview(token);
      res.setHeader("Cache-Control", "no-store");
      if (preview === undefined) {
        if (!wantsJson && (req.headers.accept ?? "").includes("text/html")) {
          res
            .status(404)
            .type("text/html; charset=utf-8")
            .send(
              renderNoticeHtml(
                "Preview expired",
                "This preview is gone — previews live about ten minutes. Ask your agent to preview again, or to pin the view so it has a permanent page.",
              ),
            );
          return;
        }
        res.status(404).json({
          ok: false,
          error: { code: "unknown_preview", message: "no such preview, or it expired — preview again" },
        });
        return;
      }
      if (wantsJson) {
        res.status(200).json(renderPreviewJson(preview));
      } else {
        res.status(200).type("text/html; charset=utf-8").send(renderPreviewHtml(preview));
      }
    });
    app.get("/views/:id", viewsAuth, async (req: Request, res: Response) => {
      // View ids are TOKEN (no dots), so a trailing ".json" is unambiguous.
      const raw = typeof req.params["id"] === "string" ? req.params["id"] : "";
      const wantsJson = raw.endsWith(".json");
      const id = wantsJson ? raw.slice(0, -".json".length) : raw;
      const spec = views.get(id);
      if (spec === undefined) {
        res.status(404).json({ ok: false, error: { code: "unknown_view", message: `no pinned view '${id}'` } });
        return;
      }
      const snapshot = await views.getFresh(id);
      if (snapshot === undefined) {
        res.status(404).json({ ok: false, error: { code: "unknown_view", message: `no pinned view '${id}'` } });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      if (wantsJson) {
        res.status(200).json(renderCardJson(spec, snapshot));
      } else {
        res.status(200).type("text/html; charset=utf-8").send(renderCardHtml(spec, snapshot));
      }
    });
  }

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
