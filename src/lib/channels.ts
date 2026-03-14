import { homedir } from "node:os";
import { join } from "node:path";

const CHANNELS_FILE = "data/channels.json";
const GLOBAL_DEFAULT = join(homedir(), "projects/kyrell-os");

interface ChannelData {
  workspace: string;
  onboardedAt: string;
}

interface ChannelsConfig {
  displayMode?: "verbose" | "compact";
  allowedUsers: string | string[];
  channels: Record<string, ChannelData>;
  workspaces: { label: string; path: string }[];
  globalDefault: string;
}

async function loadConfig(): Promise<ChannelsConfig> {
  const file = Bun.file(CHANNELS_FILE);
  if (!(await file.exists())) {
    return {
      allowedUsers: [],
      channels: {},
      workspaces: [],
      globalDefault: GLOBAL_DEFAULT,
    };
  }
  return file.json();
}

function expandHome(path: string): string {
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

export async function getWorkspaces(): Promise<
  { label: string; path: string }[]
> {
  const config = await loadConfig();
  return config.workspaces;
}

export async function getGlobalDefault(): Promise<string> {
  const config = await loadConfig();
  return config.globalDefault ?? GLOBAL_DEFAULT;
}

export async function getDisplayMode(): Promise<"verbose" | "compact"> {
  const config = await loadConfig();
  return config.displayMode ?? "verbose";
}
