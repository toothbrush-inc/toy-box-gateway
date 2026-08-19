import { homedir } from "node:os";
import { join } from "node:path";

export function defaultGatewayHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "capability-gateway");
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData !== undefined && appData.trim() !== "") {
      return join(appData, "capability-gateway");
    }
    return join(homedir(), "AppData", "Roaming", "capability-gateway");
  }
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "capability-gateway");
  }
  return join(homedir(), ".local", "share", "capability-gateway");
}

export function resolveGatewayHome(
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (home !== undefined && home.trim() !== "") {
    return home;
  }
  const fromEnv = env["GATEWAY_HOME"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return defaultGatewayHome(platform, env);
}
