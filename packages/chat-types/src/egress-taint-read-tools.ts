// Read tools whose results feed the egress-taint ledger.
//
// The enclave's within-turn egress-taint guard harvests plaintext from these
// READ tools and blocks a later web.fetch that reproduces it. The client mirrors
// this set so it can detect — per turn — whether ANY private read happened: when
// one has, the next Calypso follow-up omits the prior assistant answer from the
// replayed model context entirely (see calypso-follow-up.ts), so private content
// read last turn is never re-exposed to a fresh (empty-ledger) gateway.
//
// Keep this in sync with the enclave's harvestEgressTaint switch.

/** Tools whose results feed the egress-taint ledger. */
export const EGRESS_TAINT_READ_TOOLS: ReadonlySet<string> = new Set([
  "memory.read",
  "memory.list",
  "file.read",
  "folder.read",
  // folder.list returns model-visible private filenames (+ byte lengths); a
  // sensitive filename echoed into a follow-up replay is exfiltratable, so a
  // folder.list-only turn must also mark the turn as a private read.
  "folder.list",
  "image.ocr",
  "image.inspect",
  "image.transform",
  "audio.transcribe",
  "audio.inspect",
  "audio.transform",
  "video.transcribe",
  "video.inspect",
  "video.transform",
  "document.edit",
  "pdf.edit",
]);
