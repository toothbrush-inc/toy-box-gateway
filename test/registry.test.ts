import { describe, expect, it } from "vitest";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { parsePrefixedName, prefixedName, ToolRegistry } from "../src/registry.js";

const echoTool: Tool = {
  name: "echo",
  description: "Echoes input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

const syncTool: Tool = { name: "sync_now", inputSchema: { type: "object" } };

describe("prefixed names", () => {
  it("round-trips through prefix and parse, splitting on the first separator", () => {
    expect(prefixedName("weather", "get_status")).toBe("weather__get_status");
    expect(parsePrefixedName("weather__get_status")).toEqual({
      capabilityId: "weather",
      toolName: "get_status",
    });
    expect(parsePrefixedName("a__b__c")).toEqual({ capabilityId: "a", toolName: "b__c" });
    expect(parsePrefixedName("gateway_status")).toBeNull();
    expect(parsePrefixedName("__x")).toBeNull();
    expect(parsePrefixedName("x__")).toBeNull();
  });
});

describe("ToolRegistry", () => {
  it("lists prefixed tools with schemas re-emitted verbatim and routes back", () => {
    const registry = new ToolRegistry();
    const warnings = registry.rebuild(
      [{ id: "weather", tools: [echoTool] }],
      new Map([["weather", { id: "weather" }]]),
    );
    expect(warnings).toEqual([]);

    const tools = registry.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "weather__echo",
      description: "Echoes input",
      inputSchema: echoTool.inputSchema,
      annotations: { readOnlyHint: true },
    });

    expect(registry.resolve("weather__echo")).toMatchObject({
      capabilityId: "weather",
      toolName: "echo",
    });
    expect(registry.resolve("weather__missing")).toBeNull();
  });

  it("hides policy-denied tools from the list and reports them", () => {
    const registry = new ToolRegistry();
    registry.rebuild(
      [{ id: "calsync", tools: [echoTool, syncTool] }],
      new Map([["calsync", { id: "calsync", denyTools: ["sync_now"] }]]),
    );
    expect(registry.listTools().map((tool) => tool.name)).toEqual(["calsync__echo"]);
    expect(registry.resolve("calsync__sync_now")).toBeNull();
    expect(registry.deniedTools("calsync")).toEqual(["sync_now"]);
  });
});
