import { readFileSync } from "node:fs";

import { connectionId, openVault, parseCapabilityManifest } from "@local/vault";

import type { ChildState, MountedCapability } from "./children.js";
import type { CapabilitySpec } from "./config.js";

export interface ManifestCheck {
  checked: boolean;
  id?: string;
  warnings: string[];
}

export interface GrantSummary {
  id: string;
  connectionId: string;
  actions: string[];
}

export interface CapabilityStatus {
  id: string;
  state: ChildState;
  tools: number;
  tools_denied_by_policy: string[];
  last_error: string | null;
  connected_at: string | null;
  manifest: ManifestCheck;
  grants: GrantSummary[];
}

/** Warn-only: manifest problems never block mounting (per CAPABILITY.md). */
export function checkManifest(
  spec: CapabilitySpec,
  env: NodeJS.ProcessEnv = process.env,
): ManifestCheck {
  if (spec.manifestPath === undefined) {
    return { checked: false, warnings: [] };
  }
  let manifest;
  try {
    manifest = parseCapabilityManifest(JSON.parse(readFileSync(spec.manifestPath, "utf8")));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      checked: true,
      warnings: [`manifest at ${spec.manifestPath} failed to parse: ${reason}`],
    };
  }
  const warnings: string[] = [];
  if (manifest.id !== spec.id) {
    warnings.push(`manifest id '${manifest.id}' does not match config id '${spec.id}'`);
  }
  try {
    const granted = new Set(
      openVault({ env }).listGrants(manifest.id).map((grant) => grant.connectionId),
    );
    for (const need of manifest.connections) {
      if (!need.optional && !granted.has(connectionId(need.provider, need.slot))) {
        warnings.push(
          `required connection ${connectionId(need.provider, need.slot)} has no grant for '${manifest.id}'`,
        );
      }
    }
  } catch {
    warnings.push("unable to read grants from the vault");
  }
  return { checked: true, id: manifest.id, warnings };
}

export function readGrantSummary(
  capabilityId: string,
  env: NodeJS.ProcessEnv = process.env,
): GrantSummary[] {
  try {
    return openVault({ env }).listGrants(capabilityId).map((grant) => ({
      id: grant.id,
      connectionId: grant.connectionId,
      actions: grant.actions,
    }));
  } catch {
    return [];
  }
}

export function buildGatewayStatus(
  mounted: readonly MountedCapability[],
  specs: ReadonlyMap<string, CapabilitySpec>,
  deniedTools: (capabilityId: string) => string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; data: { capabilities: CapabilityStatus[] } } {
  const capabilities: CapabilityStatus[] = mounted.map((child) => {
    const spec = specs.get(child.id);
    const denied = deniedTools(child.id);
    return {
      id: child.id,
      state: child.state,
      // Tools exposed through the gateway (the child's list minus policy denials).
      tools: Math.max(child.tools.length - denied.length, 0),
      tools_denied_by_policy: denied,
      last_error: child.lastError,
      connected_at: child.connectedAt,
      manifest:
        spec === undefined ? { checked: false, warnings: [] } : checkManifest(spec, env),
      grants: readGrantSummary(child.id, env),
    };
  });
  return { ok: true, data: { capabilities } };
}
