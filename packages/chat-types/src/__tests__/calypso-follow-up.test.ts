import { describe, expect, it } from "vitest";

import {
  buildCalypsoTaskMessageHistory,
  FOLLOW_UP_ASSISTANT_CHAR_LIMIT,
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

  it("starts a fresh turn when the prior prompt is blank after trimming", () => {
    expect(
      buildCalypsoTaskMessageHistory({
        priorPrompt: "   \n\t  ",
        priorStatus: "done",
        streamedText: "old answer",
        taskPlan: null,
        subtaskText: { step_1: "old private step" },
        errorCode: null,
        nextUserText: "new task",
      }),
    ).toEqual([{ role: "user", content: "new task" }]);
  });

  it("replays streamed output, planned subtasks, unplanned subtasks, and explicit error codes in stable order", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "research the launch checklist",
      priorStatus: "error",
      streamedText: " Initial summary. ",
      taskPlan: {
        planId: "plan_2",
        title: "Launch checklist",
        summary: "Check launch prerequisites.",
        subtasks: [
          {
            id: "step_a",
            title: "Check legal",
            objective: "Review legal surfaces.",
            kind: "research",
            requiredCapabilities: ["research"],
            allowedTools: ["web.fetch"],
            dependsOn: [],
            producesArtifact: false,
            risk: "low",
          },
          {
            id: "step_b",
            title: "Check billing",
            objective: "Review billing surfaces.",
            kind: "research",
            requiredCapabilities: ["research"],
            allowedTools: ["web.fetch"],
            dependsOn: ["step_a"],
            producesArtifact: false,
            risk: "low",
          },
        ],
      },
      subtaskText: {
        unplanned: "An extra note.",
        step_b: "Billing is ready.",
        step_a: "Legal is ready.",
      },
      errorCode: "TOOL_TIMEOUT",
      nextUserText: "continue from the billing section",
    });

    expect(messages).toEqual([
      { role: "user", content: "research the launch checklist" },
      {
        role: "assistant",
        content: [
          "Initial summary.",
          "Check legal:\nLegal is ready.",
          "Check billing:\nBilling is ready.",
          "Calypso step:\nAn extra note.",
          "Previous task ended with error: TOOL_TIMEOUT",
        ].join("\n\n"),
      },
      { role: "user", content: "continue from the billing section" },
    ]);
  });

  it("records a generic prior error when no explicit error code is available", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "summarize the upload",
      priorStatus: "error",
      streamedText: "",
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "try again",
    });

    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Previous task ended with an error.",
    });
  });

  it("does not inject an empty assistant replay when no prior assistant content exists", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "empty prior",
      priorStatus: "done",
      streamedText: "",
      taskPlan: null,
      subtaskText: { ignored: "   " },
      errorCode: null,
      nextUserText: "next task",
    });

    expect(messages).toEqual([
      { role: "user", content: "empty prior" },
      { role: "user", content: "next task" },
    ]);
  });

  it("clamps very long prior assistant replay to the private-safe tail", () => {
    const longPrefix = "x".repeat(200);
    const privateSafeTail = "tail-".repeat(Math.ceil(FOLLOW_UP_ASSISTANT_CHAR_LIMIT / 5));
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "draft a long public report",
      priorStatus: "done",
      streamedText: `${longPrefix}${privateSafeTail}`,
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "make the ending punchier",
      priorAssistantContainsPrivateDerivedText: false,
    });

    expect(messages[1]?.content.startsWith("[Earlier Calypso output omitted]\n")).toBe(true);
    expect(messages[1]?.content).toHaveLength(
      "[Earlier Calypso output omitted]\n".length + FOLLOW_UP_ASSISTANT_CHAR_LIMIT,
    );
    expect(messages[1]?.content).not.toContain(longPrefix);
    expect(messages[1]?.content.endsWith("tail-")).toBe(true);
  });
});
