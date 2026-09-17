// Untrusted transforms run in QuickJS compiled to WebAssembly. No Node
// objects, callbacks, modules, filesystem or network APIs enter the runtime.
// Each invocation has its own heap, stack limit and execution deadline.
import { getQuickJS } from "quickjs-emscripten";

const QuickJS = await getQuickJS();
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

export type TransformErrorKind = "syntax" | "timeout" | "runtime" | "result";

export class TransformError extends Error {
  constructor(readonly kind: TransformErrorKind, message: string) {
    super(message);
    this.name = "TransformError";
  }
}

export function runTransform(source: string, input: unknown, timeoutMs: number): unknown {
  if (source.length > 32_768) throw new TransformError("syntax", "transform exceeds source size limit");
  let json: string;
  try { json = JSON.stringify(input) ?? "null"; }
  catch { throw new TransformError("runtime", "transform input is not plain JSON data"); }
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) {
    throw new TransformError("runtime", "transform input exceeds 1 MiB");
  }
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = performance.now() + timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted = performance.now() >= deadline;
    return interrupted;
  });
  const vm = runtime.newContext();
  const failure = (): TransformError => new TransformError(
    interrupted ? "timeout" : "runtime",
    interrupted ? `transform exceeded its ${String(timeoutMs)}ms budget` : "transform execution failed",
  );
  try {
    const compiled = vm.evalCode(`(${source})`, "transform.js", { compileOnly: true });
    if (compiled.error) {
      compiled.error.dispose();
      if (interrupted) throw failure();
      throw new TransformError("syntax", "transform is not valid JavaScript");
    }
    compiled.value.dispose();
    // Serialisation stays inside the engine and its budget. The only result
    // that crosses back is a string; getters and thrown objects stay inside.
    const result = vm.evalCode(`"use strict"; (() => {
      const stringify = JSON.stringify;
      const input = JSON.parse(${JSON.stringify(json)});
      const value = (${source})(input);
      if (value === null || typeof value !== "object" || typeof value.then === "function") return "";
      try { return stringify(value); } catch { return ""; }
    })()`);
    if (result.error) {
      result.error.dispose();
      throw failure();
    }
    let serialised: string;
    try { serialised = vm.typeof(result.value) === "string" ? vm.getString(result.value) : ""; }
    finally { result.value.dispose(); }
    // Promise jobs never reach Node's event loop and share the same deadline.
    while (runtime.hasPendingJob()) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        jobs.error.dispose();
        throw failure();
      }
    }
    if (interrupted) throw failure();
    if (serialised === "" || Buffer.byteLength(serialised) > MAX_JSON_BYTES) {
      throw new TransformError("result", "transform must return bounded synchronous JSON data");
    }
    return JSON.parse(serialised) as unknown;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
