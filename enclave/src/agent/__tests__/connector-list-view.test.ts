import { describe, expect, it } from "vitest";
import { buildConnectorListView } from "../prompt";

const runtimeCatalogView = [
  {
    connectorId: "google-calendar",
    displayName: "[CONNECTOR_1]",
    operations: [
      {
        id: "list_events",
        mutating: false,
        maxWindowDays: 370,
        maxResults: 250,
        windowParams: { start: "timeMin", end: "timeMax" },
        maxResultsParam: "maxResults",
        paramsSchema: {
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          maxResults: { type: "number" },
        },
      },
      {
        id: "create_event",
        mutating: true,
        paramsSchema: { summary: {} },
        contentFields: ["summary", "description", "location"],
      },
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
    expect(serialized).toContain("description");
    expect(serialized).toContain("location");
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

  it("merges catalog contentFields into the planner-visible paramsSchema", () => {
    const view = buildConnectorListView(runtimeCatalogView);
    const create = view.connectors[0].operations.find(
      (o) => o.id === "create_event",
    );
    expect(create?.paramsSchema).toMatchObject({
      summary: {},
      description: { type: "string" },
      location: { type: "string" },
    });
  });

  it("marks read-ceiling params as required in the planner-visible paramsSchema", () => {
    const view = buildConnectorListView(runtimeCatalogView);
    const listEvents = view.connectors[0].operations.find(
      (o) => o.id === "list_events",
    );
    expect(listEvents?.paramsSchema).toMatchObject({
      timeMin: { type: "string", required: true, maxWindowDays: 370 },
      timeMax: { type: "string", required: true, maxWindowDays: 370 },
      maxResults: { type: "number", required: true, maximum: 250 },
    });
  });
});
