import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNELS_FILE = join(homedir(), ".kos/agent/channels.json");
const GLOBAL_DEFAULT = join(homedir(), "projects/kyrell-os");

interface ChannelData {
  workspace: string;
  onboardedAt: string;
}

export interface ChannelsConfig {
  displayMode?: "verbose" | "compact" | "minimal";
  allowedUsers: string | string[];
  channels: Record<string, ChannelData>;
  scanRoots: string[];
  globalDefault: string;
  notifyChannel?: string;
}

const DEFAULT_CONFIG: ChannelsConfig = {
  displayMode: "compact",
  allowedUsers: "*",
  channels: {},
  scanRoots: ["~/projects"],
  globalDefault: "~/projects/kyrell-os",
};

export async function loadConfig(): Promise<ChannelsConfig> {
  const file = Bun.file(CHANNELS_FILE);
  if (!(await file.exists())) {
    return { ...DEFAULT_CONFIG };
  }
  return file.json();
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function isUserAllowed(userId: string): Promise<boolean> {
  const config = await loadConfig();
  if (config.allowedUsers === "*") return true;
  return (
    Array.isArray(config.allowedUsers) && config.allowedUsers.includes(userId)
  );
}

export async function resolveWorkspace(channelId: string): Promise<string> {
  const config = await loadConfig();
  const channel = config.channels[channelId];
  const workspace =
    channel?.workspace ?? config.globalDefault ?? GLOBAL_DEFAULT;
  return expandHome(workspace);
}

export async function saveChannelWorkspace(
  channelId: string,
  workspace: string,
): Promise<void> {
  const config = await loadConfig();
  config.channels[channelId] = {
    workspace,
    onboardedAt: new Date().toISOString(),
  };
  await Bun.write(CHANNELS_FILE, JSON.stringify(config, null, 2));
}

export async function getGlobalDefault(): Promise<string> {
  const config = await loadConfig();
  return expandHome(config.globalDefault ?? "~/projects/kyrell-os");
}

export async function getDisplayMode(): Promise<
  "verbose" | "compact" | "minimal"
> {
  const config = await loadConfig();
  return config.displayMode ?? "compact";
}

export async function updateConfig(
  updates: Partial<
    Pick<
      ChannelsConfig,
      | "displayMode"
      | "allowedUsers"
      | "globalDefault"
      | "scanRoots"
      | "notifyChannel"
    >
  >,
): Promise<ChannelsConfig> {
  const config = await loadConfig();
  if (updates.displayMode !== undefined)
    config.displayMode = updates.displayMode;
  if (updates.allowedUsers !== undefined)
    config.allowedUsers = updates.allowedUsers;
  if (updates.globalDefault !== undefined)
    config.globalDefault = updates.globalDefault;
  if (updates.scanRoots !== undefined) config.scanRoots = updates.scanRoots;
  if (updates.notifyChannel !== undefined)
    config.notifyChannel = updates.notifyChannel;
  await Bun.write(CHANNELS_FILE, JSON.stringify(config, null, 2));
  return config;
}

export async function getNotifyChannel(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.notifyChannel;
}

export async function scanWorkspaces(): Promise<
  { name: string; path: string }[]
> {
  const config = await loadConfig();
  const roots = config.scanRoots ?? ["~/projects"];
  const directories: { name: string; path: string }[] = [];

  for (const root of roots) {
    const expanded = expandHome(root);
    try {
      const entries = await readdir(expanded, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        directories.push({
          name: entry.name,
          path: join(expanded, entry.name),
        });
      }
    } catch {
      // Skip unreadable roots
    }
  }

  return directories.sort((a, b) => a.name.localeCompare(b.name));
}
