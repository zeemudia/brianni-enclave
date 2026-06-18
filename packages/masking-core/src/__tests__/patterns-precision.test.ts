import { describe, it, expect } from "vitest";
import { detectPII } from "../patterns";

const hasName = (text: string) =>
  detectPII(text).some((e) => e.type === "NAME");
const hasType = (text: string, type: string) =>
  detectPII(text).some((e) => e.type === type);

describe("NAME precision — non-person suppression (A1)", () => {
  it("suppresses place names that start with an ultra-safe leading word", () => {
    for (const phrase of ["Los Angeles", "Las Vegas", "The Hague", "New York"]) {
      expect(hasName(`I went to ${phrase} last year`), phrase).toBe(false);
    }
  });

  it("suppresses curated non-name phrases (incl. El/La-prefixed)", () => {
    for (const phrase of [
      "El Niño",
      "La Niña",
      "San Francisco",
      "Hong Kong",
    ]) {
      expect(hasName(`What is ${phrase} exactly`), phrase).toBe(false);
    }
  });

  it("STILL masks real personal names (no over-suppression — the privacy-critical direction)", () => {
    for (const name of [
      "John Smith",
      "Jane Okafor",
      "Dr Jane Doe",
      "Maria De La Cruz",
      "Robert De Niro",
      "Sarah Connor",
      // names that begin with a determiner that is ALSO a real given name —
      // these must NOT be caught by the leading-word rule (El/La/Le/Les excluded)
      "Les Paul",
      "La Toya Jackson",
      "El Greco",
    ]) {
      expect(hasName(`email ${name} about it`), name).toBe(true);
    }
  });
});

describe("ACCT precision — Luhn validation (A2)", () => {
  it("still detects a Luhn-valid card", () => {
    expect(hasType("Card: 4111 1111 1111 1111", "ACCT")).toBe(true);
  });

  it("does not flag a 16-digit group that fails the Luhn check", () => {
    expect(hasType("Ref: 4111 1111 1111 1112", "ACCT")).toBe(false);
    expect(hasType("Order 1234 5678 9012 3456", "ACCT")).toBe(false);
  });
});

describe("ID precision — SSN invalid-range rejection (A4)", () => {
  it("still detects a valid-range SSN", () => {
    expect(hasType("SSN 123-45-6789", "ID")).toBe(true);
  });

  it("rejects SSNs with a structurally invalid area / group / serial", () => {
    for (const ssn of [
      "000-12-3456", // area 000
      "666-12-3456", // area 666
      "900-12-3456", // area 900–999
      "123-00-6789", // group 00
      "123-45-0000", // serial 0000
    ]) {
      expect(hasType(`number ${ssn} here`, "ID"), ssn).toBe(false);
    }
  });
});

describe("Number-family precision — UUID exclusion (A3)", () => {
  it("does not read a UUID's digit runs as PHONE / ID / ACCT", () => {
    const text = "trace id 550e8400-e29b-41d4-a716-446655440000 logged";
    const entities = detectPII(text);
    expect(entities.some((e) => ["PHONE", "ID", "ACCT"].includes(e.type))).toBe(
      false,
    );
  });
});
