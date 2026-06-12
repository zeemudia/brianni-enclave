export function parseStrictJsonFromModelText(text: string): unknown {
  return JSON.parse(stripSingleJsonFence(text));
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(
    trimmed,
  );
  return match ? match[1].trim() : trimmed;
}
