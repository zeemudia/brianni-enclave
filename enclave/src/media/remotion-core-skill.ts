import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface InternalCoreSkill {
  id: "core.video.remotion";
  visibility: "internal";
  content: string;
}

export function loadRemotionCoreSkill(): InternalCoreSkill {
  return {
    id: "core.video.remotion",
    visibility: "internal",
    content: readFileSync(resolve(moduleDir, "core-skills/remotion.md"), "utf8"),
  };
}
