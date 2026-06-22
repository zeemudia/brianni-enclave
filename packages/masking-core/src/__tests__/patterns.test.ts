import { describe, it, expect } from "vitest";
import { detectPII } from "../patterns";

const roleTitleWords = [
  "Senior",
  "Junior",
  "Lead",
  "Principal",
  "Staff",
  "Chief",
  "Head",
  "Vice",
  "Deputy",
  "Associate",
  "Assistant",
  "Global",
  "Regional",
  "Group",
  "Product",
  "Project",
  "Program",
  "Programme",
  "Engineering",
  "Engineer",
  "Software",
  "Hardware",
  "Data",
  "Platform",
  "Systems",
  "Solutions",
  "Manager",
  "Director",
  "Officer",
  "Executive",
  "President",
  "Analyst",
  "Designer",
  "Developer",
  "Architect",
  "Consultant",
  "Specialist",
  "Coordinator",
  "Administrator",
  "Founder",
  "Partner",
  "Advisor",
  "Adviser",
  "Strategist",
  "Scientist",
  "Researcher",
  "Technician",
  "Representative",
  "Supervisor",
  "Recruiter",
  "Marketing",
  "Sales",
  "Operations",
  "Finance",
  "Legal",
  "Counsel",
  "Intern",
];

const curatedNonNamePhrases = [
  "Costa Rica",
  "El Niño",
  "El Salvador",
  "Hong Kong",
  "La Niña",
  "Puerto Rico",
  "San Diego",
  "San Francisco",
  "Santa Monica",
  "Sierra Leone",
];

describe("Regex PII detection", () => {
  it("should detect email addresses", () => {
    const entities = detectPII("Contact me at osazee@example.com please");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "EMAIL", text: "osazee@example.com" }),
    );
  });

  it("should detect UK phone numbers", () => {
    const entities = detectPII("Call me on 07700 900123");
    expect(entities).toContainEqual(expect.objectContaining({ type: "PHONE" }));
  });

  it("should detect +44 UK phone numbers", () => {
    const entities = detectPII("Call me on +44 7700 900123 tomorrow");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+44 7700 900123" }),
    );
  });

  it("should not detect +44 phone numbers embedded in longer numeric strings", () => {
    const entities = detectPII(
      "Reference 9+44 7700 900123 is not a phone field",
    );
    expect(entities).not.toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+44 7700 900123" }),
    );
  });

  it("should not detect +44 phone numbers embedded in alphanumeric tokens", () => {
    const entities = detectPII(
      "Reference x+44 7700 900123 is not a phone field",
    );
    expect(entities).not.toContainEqual(
      expect.objectContaining({ type: "PHONE", text: "+44 7700 900123" }),
    );
  });

  it("should detect names with title prefixes", () => {
    const entities = detectPII("My doctor is Dr. Osazee Edigin");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Dr. Osazee Edigin" }),
    );
  });

  it("should detect UK postcodes", () => {
    const entities = detectPII("I live at SE1 7PB");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "SE1 7PB" }),
    );
  });

  it("should detect NI numbers", () => {
    const entities = detectPII("My NI number is AB 12 34 56 C");
    expect(entities).toContainEqual(expect.objectContaining({ type: "ID" }));
  });

  it("should detect US phone numbers", () => {
    const entities = detectPII("Call me at (555) 123-4567");
    expect(entities).toContainEqual(expect.objectContaining({ type: "PHONE" }));
  });

  it("should detect dates of birth", () => {
    const entities = detectPII("Born on 15/03/1990");
    expect(entities).toContainEqual(expect.objectContaining({ type: "DOB" }));
  });

  it("should detect credit card numbers", () => {
    const entities = detectPII("Card: 4111 1111 1111 1111");
    expect(entities).toContainEqual(expect.objectContaining({ type: "ACCT" }));
  });

  it("should not detect credit-card-shaped numbers that fail Luhn", () => {
    const entities = detectPII("Reference: 4111 1111 1111 1112");
    expect(entities).not.toContainEqual(
      expect.objectContaining({ type: "ACCT", text: "4111 1111 1111 1112" }),
    );
  });

  it("should return empty array for no PII", () => {
    const entities = detectPII("The weather is nice today");
    expect(entities).toEqual([]);
  });

  it("should handle overlapping entities and keep highest confidence", () => {
    // A string that could match both US ZIP and SSN patterns
    // "123-45-6789" matches SSN with higher confidence
    const entities = detectPII("SSN: 123-45-6789");
    // Should have at most one match for overlapping range (highest confidence wins)
    const overlapping = entities.filter(
      (e) => e.text.includes("123-45-6789") || e.text.includes("123"),
    );
    // The key test: we don't get duplicate entries for the same text span
    const spans = overlapping.map((e) => `${e.startIndex}-${e.endIndex}`);
    const uniqueSpans = new Set(spans);
    // Each span should appear at most once
    expect(uniqueSpans.size).toBe(spans.length);
  });

  it("should replace overlapping entity with higher confidence match", () => {
    // Test a case where two patterns match overlapping text
    // "4111 1111 1111 1111" matches both ACCT (0.80) and could overlap with DOB patterns
    // Use a date-like number that also looks like a credit card: e.g. "12/03/4111 1111 1111 1111"
    // But simpler: use a string that triggers two patterns with overlap
    // "07700 123456" is a UK phone, and "07700" also matches as a US ZIP (lower confidence 0.60)
    const entities = detectPII("My number is 07700 123456");
    // Should only have one entity for overlapping region — the phone (higher confidence)
    const phoneEntities = entities.filter(
      (e) => e.type === "PHONE" && e.text.includes("07700"),
    );
    const zipEntities = entities.filter(
      (e) => e.type === "ADDR" && e.text === "07700",
    );
    // Phone should be kept (confidence 0.95), ZIP should be replaced/removed (0.60)
    expect(phoneEntities.length).toBeGreaterThanOrEqual(1);
    expect(zipEntities.length).toBe(0);
  });

  it("should detect US Social Security numbers", () => {
    const entities = detectPII("SSN is 123-45-6789");
    expect(entities).toContainEqual(expect.objectContaining({ type: "ID" }));
  });

  it.each([
    "000-45-6789",
    "000456789",
    "000 45 6789",
    "666-45-6789",
    "900-45-6789",
    "123-00-6789",
    "123-45-0000",
  ])("should suppress structurally invalid US SSNs: %s", (ssn) => {
    const entities = detectPII(`SSN is ${ssn}`);
    expect(entities).not.toContainEqual(
      expect.objectContaining({ type: "ID", text: ssn }),
    );
  });

  it("should detect US ZIP codes", () => {
    const entities = detectPII("ZIP code is 90210");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "ADDR", text: "90210" }),
    );
  });

  it("should detect dates in YYYY-MM-DD format", () => {
    const entities = detectPII("Born on 1990-03-15");
    expect(entities).toContainEqual(expect.objectContaining({ type: "DOB" }));
  });

  it("should detect natural-language dates only in birth-date context", () => {
    const birthDate = detectPII("My date of birth is 24 May 1990.");
    expect(birthDate).toContainEqual(
      expect.objectContaining({ type: "DOB", text: "24 May 1990" }),
    );

    const ordinaryDate = detectPII("Today is 24 May 2026.");
    expect(ordinaryDate).not.toContainEqual(
      expect.objectContaining({ type: "DOB", text: "24 May 2026" }),
    );
  });

  it("should detect numeric dates ONLY in birth-date context (not bare calendar dates)", () => {
    // Birth-date context → still masked (NINO/DOB privacy preserved).
    expect(detectPII("date of birth: 06/02/1990")).toContainEqual(
      expect.objectContaining({ type: "DOB", text: "06/02/1990" }),
    );
    expect(detectPII("dob 1990-03-15")).toContainEqual(
      expect.objectContaining({ type: "DOB", text: "1990-03-15" }),
    );

    // Bare calendar dates the agent must act on must NOT be masked. These
    // were the live A09 failure: a scheduling date / dated filename masked to
    // [DOB_1] left the drafted event/file unusable.
    for (const text of [
      "schedule a review on 2026-06-02 at 10:30",
      "schedule it for 06/02/2026 please",
      "create report-2026-06-02.md in my folder",
    ]) {
      expect(
        detectPII(text).some((e) => e.type === "DOB"),
        `bare date in: ${text}`,
      ).toBe(false);
    }
  });

  it("should NOT mask any all-role Title-Case phrase as a person name", () => {
    for (const word of roleTitleWords) {
      const phrase = word === "Engineer" ? "Engineer Senior" : `${word} Engineer`;
      expect(
        detectPII(`the ${phrase} role`).some((e) => e.type === "NAME"),
        `role word: ${word}`,
      ).toBe(false);
    }
  });

  it("should NOT mask Title-Case phrases that are entirely job/role words", () => {
    // These are not personal names; masking them stranded agent tasks that
    // must reference the role (e.g. A10 negotiation email for the offer).
    for (const phrase of [
      "Senior Product Engineer",
      "Product Manager",
      "Vice President",
      "Chief Executive Officer",
    ]) {
      expect(
        detectPII(`the ${phrase} offer`).some((e) => e.type === "NAME"),
        `role phrase: ${phrase}`,
      ).toBe(false);
    }
  });

  it("should STILL mask real personal names (no false suppression)", () => {
    // A mix of role + surname, or a plain name, must remain masked.
    expect(detectPII("email John Smith about it")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "John Smith" }),
    );
    expect(detectPII("Senior engineer Jane Okafor").some((e) => e.type === "NAME")).toBe(true);
    expect(detectPII("Dr Jane Doe").some((e) => e.type === "NAME")).toBe(true);
  });

  it("should not suppress titled names even when they include role words", () => {
    expect(detectPII("Please call Prof. Chief Engineer")).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Prof. Chief Engineer" }),
    );
  });

  it("should suppress curated place and non-name title-case phrases", () => {
    for (const phrase of [
      ...curatedNonNamePhrases,
      "Los Angeles",
      "New York",
    ]) {
      expect(
        detectPII(`weather in ${phrase} today`).some((e) => e.type === "NAME"),
        `non-name phrase: ${phrase}`,
      ).toBe(false);
    }
  });

  it("should detect personal profile handles inside GitHub URLs without masking the repo path", () => {
    const entities = detectPII(
      "See https://github.com/iosazee/claude-adv/actions/runs/123",
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "iosazee" }),
    );
    expect(entities).not.toContainEqual(
      expect.objectContaining({ text: "claude-adv" }),
    );
  });

  it("should detect profile handles for supported social/code hosts", () => {
    const entities = detectPII(
      "Profiles: gitlab.com/iosazee/thing bitbucket.org/work-user/repo x.com/zee_dev linkedin.com/in/zee-edigin",
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "iosazee" }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "work-user" }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "zee_dev" }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "HANDLE", text: "zee-edigin" }),
    );
  });

  it("should detect local user path prefixes while preserving the rest of the path", () => {
    const entities = detectPII(
      "/Users/example/Projects/public-fixture",
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "PATH", text: "/Users/example" }),
    );
  });

  it("should detect Linux home and Windows user path prefixes", () => {
    const entities = detectPII(
      String.raw`/home/zee/projects and C:\Users\Zee\Documents\file.txt`,
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "PATH", text: "/home/zee" }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "PATH", text: String.raw`C:\Users\Zee` }),
    );
  });

  it("should not let name detection span across newlines", () => {
    const entities = detectPII(
      "Amazon Web Services Sign-In\nCalypso\nSun 24 May 11:21",
    );
    expect(entities.some((entity) => entity.text.includes("\n"))).toBe(false);
  });

  it("should not treat common organisation tab titles as person names", () => {
    const entities = detectPII("Amazon Web Services Sign-In");
    expect(entities).not.toContainEqual(
      expect.objectContaining({
        type: "NAME",
        text: "Amazon Web Services Sign",
      }),
    );
  });

  it("should not suppress real-looking names that contain one organisation descriptor word", () => {
    const entities = detectPII("My contact is Jane Services");
    expect(entities).toContainEqual(
      expect.objectContaining({ type: "NAME", text: "Jane Services" }),
    );
  });

  it("should detect multiple PII entities in the same text", () => {
    const entities = detectPII(
      "Email me at osazee@test.com, phone 07700 123456",
    );
    const types = entities.map((e) => e.type);
    expect(types).toContain("EMAIL");
    expect(types).toContain("PHONE");
  });

  it("should include position and confidence data in entities", () => {
    const entities = detectPII("Contact osazee@example.com");
    const email = entities.find((e) => e.type === "EMAIL");
    expect(email).toBeDefined();
    expect(email!.startIndex).toBeGreaterThanOrEqual(0);
    expect(email!.endIndex).toBeGreaterThan(email!.startIndex);
    expect(email!.confidence).toBeGreaterThan(0);
  });
});
