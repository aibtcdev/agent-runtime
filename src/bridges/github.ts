import type { TaskInput } from "../types";

type GitHubBridgeEvent = {
  event: string;
  repository: string;
  title: string;
  number: number;
  author: string;
  url: string;
  merged?: boolean;
  summary?: string;
  operator_question?: string;
};

export function githubEventToTask(event: GitHubBridgeEvent): TaskInput {
  return {
    kind: "github-story",
    source: "github-bridge",
    priority: 7,
    requested_profile: "lumen",
    payload: {
      repository: event.repository,
      title: event.title,
      number: event.number,
      author: event.author,
      url: event.url,
      merged: event.merged ?? false,
      summary: event.summary ?? "",
      operator_question: event.operator_question ?? "Explain what changed and why it matters."
    }
  };
}
