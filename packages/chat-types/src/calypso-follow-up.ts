import type { AgentTaskPlan } from "./orchestrator";

export type CalypsoFollowUpPriorStatus = "running" | "done" | "error";

export interface CalypsoFollowUpMessage {
  role: "user" | "assistant";
  content: string;
}

export const FOLLOW_UP_ASSISTANT_CHAR_LIMIT = 12_000;
export const PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION =
  "[Private-derived prior answer omitted. Re-read private sources if needed.]";

export function buildCalypsoTaskMessageHistory(input: {
  priorPrompt: string | null;
  priorStatus: CalypsoFollowUpPriorStatus;
  streamedText: string;
  taskPlan: AgentTaskPlan | null;
  subtaskText: Record<string, string>;
  errorCode: string | null;
  nextUserText: string;
  priorAssistantContainsPrivateDerivedText?: boolean;
  /**
   * Set when the user EXPLICITLY chose to refine THIS completed result
   * ("Refine this result" affordance, X3). The prior answer is then attached
   * even when it is private-derived — the user is editing a draft they are
   * looking at, and the agent path re-masks the content on-device before it
   * leaves, so the masking round-trip still holds. Left false/undefined for a
   * normal follow-up, which keeps the conservative omission so private-derived
   * content is not silently carried into an unrelated next task.
   */
  includePrivateDerivedPriorAnswer?: boolean;
}): CalypsoFollowUpMessage[] {
  const priorPrompt = input.priorPrompt?.trim();
  if (!priorPrompt || input.priorStatus === "running") {
    return [{ role: "user", content: input.nextUserText }];
  }

  const messages: CalypsoFollowUpMessage[] = [
    { role: "user", content: priorPrompt },
  ];
  const priorAssistant =
    input.priorAssistantContainsPrivateDerivedText &&
    !input.includePrivateDerivedPriorAnswer
      ? PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION
      : buildPriorCalypsoAssistantText(input);
  if (priorAssistant) {
    messages.push({ role: "assistant", content: priorAssistant });
  }
  messages.push({ role: "user", content: input.nextUserText });
  return messages;
}

function buildPriorCalypsoAssistantText(input: {
  priorStatus: CalypsoFollowUpPriorStatus;
  streamedText: string;
  taskPlan: AgentTaskPlan | null;
  subtaskText: Record<string, string>;
  errorCode: string | null;
}): string {
  const parts: string[] = [];
  const streamed = input.streamedText.trim();
  if (streamed) parts.push(streamed);

  for (const item of orderedSubtaskTexts(input.taskPlan, input.subtaskText)) {
    parts.push(`${item.title}:\n${item.text}`);
  }

  if (input.errorCode) {
    parts.push(`Previous task ended with error: ${input.errorCode}`);
  } else if (input.priorStatus === "error") {
    parts.push("Previous task ended with an error.");
  }

  return clampFollowUpAssistantText(parts.join("\n\n").trim());
}

function orderedSubtaskTexts(
  taskPlan: AgentTaskPlan | null,
  subtaskText: Record<string, string>,
): Array<{ title: string; text: string }> {
  const planSubtasks = taskPlan?.subtasks ?? [];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const subtask of planSubtasks) {
    ids.push(subtask.id);
    seen.add(subtask.id);
  }
  for (const id of Object.keys(subtaskText)) {
    if (!seen.has(id)) ids.push(id);
  }

  return ids
    .map((id) => {
      const text = subtaskText[id]?.trim();
      if (!text) return null;
      const title =
        planSubtasks.find((subtask) => subtask.id === id)?.title ??
        "Calypso step";
      return { title, text };
    })
    .filter((item): item is { title: string; text: string } => item !== null);
}

function clampFollowUpAssistantText(text: string): string {
  if (text.length <= FOLLOW_UP_ASSISTANT_CHAR_LIMIT) return text;
  return [
    "[Earlier Calypso output omitted]",
    text.slice(text.length - FOLLOW_UP_ASSISTANT_CHAR_LIMIT),
  ].join("\n");
}
