import type { AgentChatMessage } from "@kanna/shared";

export interface ChatPresentationTurn {
  user?: AgentChatMessage;
  replies: AgentChatMessage[];
  tools: AgentChatMessage[];
  other: AgentChatMessage[];
}

export function groupChatTurns(messages: AgentChatMessage[]): ChatPresentationTurn[] {
  const turns: ChatPresentationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, replies: [], tools: [], other: [] });
      continue;
    }
    if (!turns.length) turns.push({ replies: [], tools: [], other: [] });
    const turn = turns[turns.length - 1]!;
    if (message.role === "assistant") turn.replies.push(message);
    else if (message.role === "tool") turn.tools.push(message);
    else turn.other.push(message);
  }
  return turns;
}
