import type { TaskInput } from "../types";

type DiscordBridgeEvent = {
  event: string;
  channel: string;
  author: string;
  message: string;
  reply_style?: string;
  operator_goal?: string;
};

export function discordEventToTask(event: DiscordBridgeEvent): TaskInput {
  return {
    kind: "discord-reply",
    source: "discord-bridge",
    priority: 6,
    requested_profile: "lumen",
    payload: {
      channel: event.channel,
      author: event.author,
      message: event.message,
      reply_style: event.reply_style ?? "short",
      operator_goal: event.operator_goal ?? "Draft a concise Discord reply."
    }
  };
}
