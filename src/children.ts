import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { CapabilitySpec } from "./config.js";
import { redactErrorMessage } from "./redact.js";

export type ChildState = "connected" | "failed" | "closed";

export interface MountedCapability {
  id: string;
  state: ChildState;
  client: Client | null;
  tools: Tool[];
  lastError: string | null;
  connectedAt: string | null;
}

export type TransportFactory = (spec: CapabilitySpec) => Transport;

export interface ChildEgress {
  url: string;
  token: string;
}

/**
 * Child env: per-spec entries, then the gateway's vault location passthrough,
 * then the egress endpoint, then the non-negotiable explicit grant mode (and
 * broker-only secrets access when configured). The SDK merges this over its
 * safe default environment.
 */
export function buildChildEnv(
  spec: CapabilitySpec,
  env: NodeJS.ProcessEnv = process.env,
  egress?: ChildEgress,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  // Provisioned env first; the capability's own spec.env always wins.
  const child: Record<string, string> = { ...(extraEnv ?? {}), ...(spec.env ?? {}) };
  const vaultHome = env["VAULT_HOME"];
  if (vaultHome !== undefined && vaultHome.trim() !== "") {
    child["VAULT_HOME"] = vaultHome;
  }
  const backend = env["VAULT_SECRETS_BACKEND"];
  if (backend !== undefined && backend.trim() !== "") {
    child["VAULT_SECRETS_BACKEND"] = backend;
  }
  if (egress !== undefined) {
    child["VAULT_EGRESS_URL"] = egress.url;
    child["VAULT_EGRESS_TOKEN"] = egress.token;
  }
  child["VAULT_GRANT_MODE"] = "explicit";
  if (spec.secretsAccess === "broker") {
    child["VAULT_SECRETS_ACCESS"] = "broker";
  }
  return child;
}

export function buildStdioTransport(
  spec: CapabilitySpec,
  env: NodeJS.ProcessEnv = process.env,
  egress?: ChildEgress,
  extraEnv?: Record<string, string>,
): StdioClientTransport {
  const parameters: StdioServerParameters = {
    command: spec.command,
    args: [...spec.args],
    env: buildChildEnv(spec, env, egress, extraEnv),
    stderr: "pipe",
  };
  if (spec.cwd !== undefined) {
    parameters.cwd = spec.cwd;
  }
  return new StdioClientTransport(parameters);
}

export interface ChildManagerOptions {
  transportFactory?: TransportFactory;
  onToolsChanged: (capabilityId: string) => void;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  version?: string;
  egressFor?: (capabilityId: string) => ChildEgress | undefined;
  extraEnvFor?: (capabilityId: string) => Record<string, string> | undefined;
}

export class ChildManager {
  private readonly children = new Map<string, MountedCapability>();

  constructor(
    private readonly specs: readonly CapabilitySpec[],
    private readonly options: ChildManagerOptions,
  ) {}

  /** Mounts every capability; failures are recorded per child, never thrown. */
  async start(): Promise<void> {
    await Promise.allSettled(this.specs.map((spec) => this.mount(spec)));
  }

  async reconnect(id: string): Promise<MountedCapability> {
    const spec = this.specs.find((candidate) => candidate.id === id);
    if (spec === undefined) {
      throw new Error(`unknown capability: ${id}`);
    }
    const existing = this.children.get(id);
    if (existing !== undefined && existing.client !== null) {
      existing.state = "closed";
      try {
        await existing.client.close();
      } catch {
        // Already dead; reconnect proceeds regardless.
      }
    }
    const mounted = await this.mount(spec);
    this.options.onToolsChanged(id);
    return mounted;
  }

  get(id: string): MountedCapability | undefined {
    return this.children.get(id);
  }

  list(): MountedCapability[] {
    return [...this.children.values()];
  }

  async close(): Promise<void> {
    const closing: Array<Promise<void>> = [];
    for (const child of this.children.values()) {
      if (child.client !== null) {
        child.state = "closed";
        closing.push(child.client.close().catch(() => undefined));
      }
    }
    await Promise.all(closing);
  }

  private async mount(spec: CapabilitySpec): Promise<MountedCapability> {
    const mounted: MountedCapability = {
      id: spec.id,
      state: "failed",
      client: null,
      tools: [],
      lastError: null,
      connectedAt: null,
    };
    this.children.set(spec.id, mounted);
    let client: Client | undefined;
    let transport: Transport | undefined;
    try {
      client = new Client(
        { name: "capability-gateway", version: this.options.version ?? "0.0.0" },
        {
          listChanged: {
            tools: {
              onChanged: (error, tools) => {
                if (error !== null) {
                  this.options.log(
                    `[${spec.id}] tools/list refresh failed: ${redactErrorMessage(error.message)}`,
                  );
                  return;
                }
                mounted.tools = tools ?? [];
                this.options.onToolsChanged(spec.id);
              },
            },
          },
        },
      );
      const factory =
        this.options.transportFactory ??
        ((forSpec: CapabilitySpec) =>
          buildStdioTransport(
            forSpec,
            this.options.env,
            this.options.egressFor?.(forSpec.id),
            this.options.extraEnvFor?.(forSpec.id),
          ));
      transport = factory(spec);
      this.attachStderr(spec.id, transport);
      client.onclose = () => {
        if (mounted.state === "connected") {
          mounted.state = "failed";
          mounted.lastError = "child process closed";
          this.options.onToolsChanged(spec.id);
        }
      };
      client.onerror = (error) => {
        mounted.lastError = redactErrorMessage(error.message);
      };
      await client.connect(transport);
      const listed = await client.listTools();
      mounted.client = client;
      mounted.tools = listed.tools;
      mounted.state = "connected";
      mounted.connectedAt = new Date().toISOString();
      mounted.lastError = null;
      return mounted;
    } catch (error) {
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      mounted.state = "failed";
      mounted.lastError = redactErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      this.options.log(`[gateway] failed to mount ${spec.id}: ${mounted.lastError}`);
      return mounted;
    }
  }

  private attachStderr(id: string, transport: Transport): void {
    const stream = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (stream === undefined || stream === null || typeof stream.on !== "function") {
      return;
    }
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text === "") {
        return;
      }
      for (const line of text.split("\n")) {
        this.options.log(`[${id}] ${line}`);
      }
    });
  }
}
