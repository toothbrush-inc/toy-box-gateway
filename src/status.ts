import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  connectionId,
  openVault,
  parseCapabilityManifest,
  PROFILE_PROVIDER,
} from "@local/vault";

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

export interface CapabilityEgressStatus {
  enabled: boolean;
  hosts: string[];
}

export interface CapabilityProfileStatus {
  fields: string[];
  granted: string[];
}

export interface CapabilityDataStatus {
  profile: CapabilityProfileStatus | null;
  commons: string[];
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
  egress: CapabilityEgressStatus;
  profile: CapabilityProfileStatus | null;
  commons: string[];
}

/** Warn-only: manifest problems never block mounting (per CAPABILITY.md). */
export function checkManifest(
  spec: CapabilitySpec,
  env: NodeJS.ProcessEnv = process.env,
  commonsDir?: string,
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
  for (const need of manifest.connections) {
    if (need.provider === PROFILE_PROVIDER) {
      if (need.actions === undefined || need.actions.length === 0) {
        warnings.push(
          "profile connection declares no fields (actions); all profile reads will be denied",
        );
      }
      if (need.egress !== undefined) {
        warnings.push("profile connection must not declare an egress spec; it is ignored");
      }
    }
  }
  for (const entry of manifest.data?.commons ?? []) {
    if (commonsDir === undefined) {
      warnings.push(
        `commons dataset '${entry.dataset}' is declared but the gateway has no commons directory configured`,
      );
    } else if (!existsSync(join(commonsDir, `${entry.dataset}.json`))) {
      warnings.push(`commons dataset '${entry.dataset}' is missing from ${commonsDir}`);
    }
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
  egressInfo: (capabilityId: string) => CapabilityEgressStatus = () => ({
    enabled: false,
    hosts: [],
  }),
  dataInfo: (capabilityId: string) => CapabilityDataStatus = () => ({
    profile: null,
    commons: [],
  }),
  commonsDir?: string,
): { ok: true; data: { capabilities: CapabilityStatus[] } } {
  const capabilities: CapabilityStatus[] = mounted.map((child) => {
    const spec = specs.get(child.id);
    const denied = deniedTools(child.id);
    const data = dataInfo(child.id);
    return {
      id: child.id,
      state: child.state,
      // Tools exposed through the gateway (the child's list minus policy denials).
      tools: Math.max(child.tools.length - denied.length, 0),
      tools_denied_by_policy: denied,
      last_error: child.lastError,
      connected_at: child.connectedAt,
      manifest:
        spec === undefined
          ? { checked: false, warnings: [] }
          : checkManifest(spec, env, commonsDir),
      grants: readGrantSummary(child.id, env),
      egress: egressInfo(child.id),
      profile: data.profile,
      commons: data.commons,
    };
  });
  return { ok: true, data: { capabilities } };
}
