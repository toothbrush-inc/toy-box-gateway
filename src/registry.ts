import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { evaluatePolicy, type PolicyInput } from "./policy.js";

export const PREFIX_SEPARATOR = "__";

export function prefixedName(capabilityId: string, toolName: string): string {
  return `${capabilityId}${PREFIX_SEPARATOR}${toolName}`;
}

export function parsePrefixedName(
  name: string,
): { capabilityId: string; toolName: string } | null {
  const separator = name.indexOf(PREFIX_SEPARATOR);
  if (separator <= 0 || separator + PREFIX_SEPARATOR.length >= name.length) {
    return null;
  }
  return {
    capabilityId: name.slice(0, separator),
    toolName: name.slice(separator + PREFIX_SEPARATOR.length),
  };
}

export interface RegistryCapability {
  id: string;
  tools: readonly Tool[];
}

interface RegistryEntry {
  capabilityId: string;
  toolName: string;
  tool: Tool;
}

export class ToolRegistry {
  private entries = new Map<string, RegistryEntry>();
  private denied = new Map<string, string[]>();

  /** Rebuilds the registry from connected capabilities; returns warnings to log. */
  rebuild(
    capabilities: readonly RegistryCapability[],
    policies: ReadonlyMap<string, PolicyInput>,
  ): string[] {
    const warnings: string[] = [];
    this.entries = new Map();
    this.denied = new Map();
    for (const capability of capabilities) {
      const policy = policies.get(capability.id);
      const deniedHere: string[] = [];
      for (const tool of capability.tools) {
        if (policy !== undefined && !evaluatePolicy(policy, tool.name).allowed) {
          deniedHere.push(tool.name);
          continue;
        }
        const name = prefixedName(capability.id, tool.name);
        if (this.entries.has(name)) {
          warnings.push(`duplicate tool name ${name}; keeping the last registration`);
        }
        this.entries.set(name, { capabilityId: capability.id, toolName: tool.name, tool });
      }
      this.denied.set(capability.id, deniedHere);
    }
    return warnings;
  }

  listTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [name, entry] of this.entries) {
      tools.push({ ...entry.tool, name });
    }
    return tools;
  }

  resolve(name: string): { capabilityId: string; toolName: string; tool: Tool } | null {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      return null;
    }
    return { capabilityId: entry.capabilityId, toolName: entry.toolName, tool: entry.tool };
  }

  deniedTools(capabilityId: string): string[] {
    return this.denied.get(capabilityId) ?? [];
  }
}
