import type { CapabilitySpec } from "./config.js";

export type PolicyDecision = { allowed: true } | { allowed: false; message: string };

export type PolicyInput = Pick<CapabilitySpec, "id" | "allowTools" | "denyTools">;

export function evaluatePolicy(spec: PolicyInput, toolName: string): PolicyDecision {
  if (spec.denyTools !== undefined && spec.denyTools.includes(toolName)) {
    return { allowed: false, message: denialMessage(spec.id, toolName) };
  }
  if (spec.allowTools !== undefined && !spec.allowTools.includes(toolName)) {
    return { allowed: false, message: denialMessage(spec.id, toolName) };
  }
  return { allowed: true };
}

function denialMessage(capabilityId: string, toolName: string): string {
  return (
    `Tool '${toolName}' is denied by gateway policy for capability '${capabilityId}'. ` +
    `Edit allowTools/denyTools for '${capabilityId}' in the gateway config and restart the gateway.`
  );
}
