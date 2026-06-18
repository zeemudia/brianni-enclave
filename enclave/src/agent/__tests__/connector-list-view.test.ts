import { describe, expect, it } from "vitest";
import { buildConnectorListView } from "../prompt";

const runtimeCatalogView = [
  {
    connectorId: "google-calendar",
    displayName: "[CONNECTOR_1]",
    operations: [
      { id: "list_events", mutating: false, paramsSchema: { timeMin: {} } },
      { id: "create_event", mutating: true, paramsSchema: { summary: {} } },
    ],
  },
];

describe("connector.list view is built from runtime catalog data (C1)", () => {
  it("surfaces operations + param schemas supplied at runtime, not from measured code", () => {
    const view = buildConnectorListView(runtimeCatalogView);
    const serialized = JSON.stringify(view);
    expect(serialized).toContain("list_events");
    expect(serialized).toContain("create_event");
    expect(serialized).toContain("timeMin");
  });

  it("returns an empty connector set when nothing is connected", () => {
    const view = buildConnectorListView([]);
    expect(view.connectors).toEqual([]);
  });

  it("preserves the mutating flag so the planner routes via connector.act vs connector.read", () => {
    const view = buildConnectorListView(runtimeCatalogView);
    const ops = view.connectors[0].operations;
    expect(ops.find((o) => o.id === "create_event")?.mutating).toBe(true);
    expect(ops.find((o) => o.id === "list_events")?.mutating).toBe(false);
  });
});
