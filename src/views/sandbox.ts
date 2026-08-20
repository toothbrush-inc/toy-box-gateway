// The transform sandbox: pure synchronous JS, (input) => CardModel, with only
// JSON and Math in scope and a hard vm timeout. A cooperative boundary like
// the rest of local enforcement — hosted upgrades to isolates.

import { Script } from "node:vm";

import { redactErrorMessage } from "../redact.js";

export type TransformErrorKind = "syntax" | "timeout" | "runtime" | "result";

export class TransformError extends Error {
  constructor(
    readonly kind: TransformErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TransformError";
  }
}

export function runTransform(source: string, input: unknown, timeoutMs: number): unknown {
  let script: Script;
  try {
    script = new Script(`"use strict"; (${source})(__input)`);
  } catch (error) {
    throw new TransformError("syntax", redactErrorMessage(messageOf(error)));
  }
  let result: unknown;
  try {
    result = script.runInNewContext(
      { __input: structuredClone(input), JSON, Math },
      { timeout: timeoutMs, contextCodeGeneration: { strings: false, wasm: false } },
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new TransformError("timeout", `transform exceeded its ${String(timeoutMs)}ms budget`);
    }
    throw new TransformError("runtime", redactErrorMessage(messageOf(error)));
  }
  try {
    return structuredClone(result);
  } catch {
    throw new TransformError("result", "transform must return plain synchronous JSON data");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
