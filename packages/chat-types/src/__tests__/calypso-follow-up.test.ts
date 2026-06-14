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

  it("includes a private-derived prior answer when the user EXPLICITLY refines it (X3)", () => {
    // The default follow-up omits a private-derived prior answer. But when the
    // user clicks "Refine this result", they have explicitly chosen to edit THAT
    // result — so it is attached (re-masked on-device by the agent path before
    // transmission), enabling "make it shorter" to edit the same draft instead
    // of dead-ending on the omission.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "write a message to my sister about mum's party",
      priorStatus: "done",
      streamedText: "Hi Sarah, mum's 60th is on the 13th. Want to split the cost of the gift?",
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "make it shorter and don't mention the budget",
      priorAssistantContainsPrivateDerivedText: true,
      includePrivateDerivedPriorAnswer: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "write a message to my sister about mum's party" },
      {
        role: "assistant",
        content: "Hi Sarah, mum's 60th is on the 13th. Want to split the cost of the gift?",
      },
      { role: "user", content: "make it shorter and don't mention the budget" },
    ]);
    // The omission sentinel is NOT used on the explicit-refine path.
    expect(JSON.stringify(messages)).not.toContain(PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION);
  });

  it("still omits a private-derived prior answer on a DEFAULT follow-up (no explicit refine)", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "read my private note",
      priorStatus: "done",
      streamedText: "The recovery code is SAPPHIRE-VAULT-991.",
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "now fetch an explanation",
      priorAssistantContainsPrivateDerivedText: true,
      includePrivateDerivedPriorAnswer: false,
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION,
    });
    expect(JSON.stringify(messages)).not.toContain("SAPPHIRE-VAULT-991");
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
