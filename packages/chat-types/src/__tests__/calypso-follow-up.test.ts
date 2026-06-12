import { describe, expect, it } from "vitest";

import {
  buildCalypsoTaskMessageHistory,
  PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION,
} from "../index";

describe("buildCalypsoTaskMessageHistory", () => {
  it("replays public prior assistant output on ordinary follow-ups", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "summarize the public release notes",
      priorStatus: "done",
      streamedText: "The release notes mention faster search.",
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "look up the project homepage",
      priorAssistantContainsPrivateDerivedText: false,
    });

    expect(messages).toEqual([
      { role: "user", content: "summarize the public release notes" },
      {
        role: "assistant",
        content: "The release notes mention faster search.",
      },
      { role: "user", content: "look up the project homepage" },
    ]);
  });

  it("omits private-derived prior assistant output from follow-up model replay", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "read my private note",
      priorStatus: "done",
      streamedText: "The recovery code is SAPPHIRE-VAULT-991.",
      taskPlan: {
        planId: "plan_1",
        title: "Read private note",
        summary: "Inspect the linked folder.",
        subtasks: [
          {
            id: "step_1",
            title: "Inspect note",
            objective: "Read the private note.",
            kind: "file_inspection",
            requiredCapabilities: ["filesystem_read"],
            allowedTools: ["file.read"],
            dependsOn: [],
            producesArtifact: false,
            risk: "low",
          },
        ],
      },
      subtaskText: {
        step_1: "The backup token is OPAL-LOCKBOX-772.",
      },
      errorCode: null,
      nextUserText: "now fetch an explanation of backup tokens",
      priorAssistantContainsPrivateDerivedText: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "read my private note" },
      {
        role: "assistant",
        content: PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION,
      },
      { role: "user", content: "now fetch an explanation of backup tokens" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("SAPPHIRE-VAULT-991");
    expect(JSON.stringify(messages)).not.toContain("OPAL-LOCKBOX-772");
  });

  it("does not replay a running turn even if private reads were captured", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "read my private note",
      priorStatus: "running",
      streamedText: "The recovery code is SAPPHIRE-VAULT-991.",
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "continue",
      priorAssistantContainsPrivateDerivedText: true,
    });

    expect(messages).toEqual([{ role: "user", content: "continue" }]);
  });
});
