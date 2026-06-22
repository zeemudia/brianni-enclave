import { describe, expect, it } from "vitest";

import {
  buildCalypsoTaskMessageHistory,
  FOLLOW_UP_ASSISTANT_CHAR_LIMIT,
} from "../calypso-follow-up";
import type { AgentTaskPlan } from "../orchestrator";

// Mutation-hardening for the Calypso follow-up message-history builder. The
// private-derived omission gate is a masking-roundtrip / privacy invariant, and
// the ordering / clamp logic decides exactly what prior content is replayed to
// the model on a follow-up. Each test isolates a single surviving branch.

function planWithSubtask(id: string, title: string): AgentTaskPlan {
  return {
    planId: "plan_x",
    title: "T",
    summary: "S",
    subtasks: [
      {
        id,
        title,
        objective: "o",
        kind: "research",
        requiredCapabilities: ["research"],
        allowedTools: ["web.fetch"],
        dependsOn: [],
        producesArtifact: false,
        risk: "low",
      },
    ],
  };
}

describe("buildCalypsoTaskMessageHistory — mutation hardening", () => {
  it("treats a null priorPrompt as a fresh turn (kills the `?.trim` optional-chaining)", () => {
    // Without optional chaining, `null.trim()` would throw. The guard returns a
    // single-message fresh turn.
    expect(
      buildCalypsoTaskMessageHistory({
        priorPrompt: null,
        priorStatus: "done",
        streamedText: "anything",
        taskPlan: null,
        subtaskText: {},
        errorCode: null,
        nextUserText: "go",
      }),
    ).toEqual([{ role: "user", content: "go" }]);
  });

  it("does NOT prepend an empty streamed block before the subtask text (kills the `if(streamed)` guard)", () => {
    // streamedText is whitespace-only -> must not push a leading empty part.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: "   ",
      taskPlan: planWithSubtask("a", "A"),
      subtaskText: { a: "done" },
      errorCode: null,
      nextUserText: "go",
    });
    // If the empty stream were pushed, content would be "\n\nA:\ndone".
    expect(messages[1]?.content).toBe("A:\ndone");
  });

  it("joins replay parts with a blank-line separator, not a comma (kills `join()` default-separator mutant)", () => {
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "error",
      streamedText: "hello",
      taskPlan: null,
      subtaskText: {},
      errorCode: "E1",
      nextUserText: "go",
    });
    expect(messages[1]?.content).toBe(
      "hello\n\nPrevious task ended with error: E1",
    );
    // A bare `.join()` would produce "hello,Previous task ended with error: E1".
    expect(messages[1]?.content).not.toContain("hello,Previous");
  });

  it("does not seed phantom subtask ids when taskPlan is null (kills the `?? []` ArrayDeclaration mutants)", () => {
    // With a null plan, the only subtask must come from the subtaskText keys.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: "",
      taskPlan: null,
      subtaskText: { onlykey: "text-here" },
      errorCode: null,
      nextUserText: "go",
    });
    // A `["Stryker was here"]` seed for planSubtasks/ids would add a phantom
    // "Calypso step" entry whose text comes from subtaskText["Stryker was here"]
    // (undefined -> skipped) — but it would also reorder/duplicate. Pin the exact
    // single-entry output.
    expect(messages[1]?.content).toBe("Calypso step:\ntext-here");
  });

  it("does not duplicate an id when the ids accumulator starts empty (kills the `ids = []` ArrayDeclaration seed)", () => {
    // If the `ids` accumulator were seeded with a sentinel string and the SAME
    // string is a subtaskText key, the object-keys loop re-appends it -> the
    // entry would render TWICE. With a correct empty seed it renders once.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: "",
      taskPlan: null,
      subtaskText: { "Stryker was here": "phantom-text" },
      errorCode: null,
      nextUserText: "go",
    });
    expect(messages[1]?.content).toBe("Calypso step:\nphantom-text");
    // A duplicated seed would produce two "Calypso step" blocks.
    expect(
      messages[1]?.content.split("Calypso step:").length - 1,
    ).toBe(1);
  });

  it("skips a planned subtask that has no captured text without throwing (kills the `subtaskText[id]?.trim` chaining)", () => {
    // The plan declares subtask "a" but subtaskText has no entry for it.
    // Without optional chaining, `undefined.trim()` would throw.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: "stream-only",
      taskPlan: planWithSubtask("a", "A"),
      subtaskText: {},
      errorCode: null,
      nextUserText: "go",
    });
    expect(messages[1]?.content).toBe("stream-only");
  });

  it("trims surrounding whitespace off the assembled replay block (kills the outer `.join().trim()` -> `.join()`)", () => {
    // The per-part inputs are NOT all internally trimmed: the error-code part is
    // interpolated verbatim ("Previous task ended with error: ${errorCode}"), so a
    // provider error code that carries trailing whitespace would leak it into the
    // replayed assistant message unless the OUTER `.trim()` on the joined result
    // cleans it. Dropping that outer trim leaves the trailing whitespace intact.
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "error",
      streamedText: "hello",
      taskPlan: null,
      subtaskText: {},
      errorCode: "E1   \n  ",
      nextUserText: "go",
    });
    expect(messages[1]?.content).toBe(
      "hello\n\nPrevious task ended with error: E1",
    );
    // Explicit: no trailing whitespace survives (the bare-`.join()` mutant would
    // keep "...error: E1   \n  ").
    expect(messages[1]?.content).toMatch(/E1$/);
  });

  it("does NOT clamp prior assistant text that is exactly at the char limit (kills `<=` -> `<`)", () => {
    const exact = "a".repeat(FOLLOW_UP_ASSISTANT_CHAR_LIMIT);
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: exact,
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "go",
    });
    expect(messages[1]?.content).toBe(exact);
    expect(messages[1]?.content.startsWith("[Earlier Calypso output omitted]")).toBe(
      false,
    );
  });

  it("DOES clamp prior assistant text one char over the limit (kills the inverse boundary)", () => {
    const over = "a".repeat(FOLLOW_UP_ASSISTANT_CHAR_LIMIT + 1);
    const messages = buildCalypsoTaskMessageHistory({
      priorPrompt: "p",
      priorStatus: "done",
      streamedText: over,
      taskPlan: null,
      subtaskText: {},
      errorCode: null,
      nextUserText: "go",
    });
    expect(messages[1]?.content.startsWith("[Earlier Calypso output omitted]")).toBe(
      true,
    );
  });
});
