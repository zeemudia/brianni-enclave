// Read tools whose results feed the egress-taint ledger.
//
// The enclave's within-turn egress-taint guard harvests plaintext from these
// READ tools and blocks a later web.fetch that reproduces it. The client mirrors
// this set so it can detect — per turn — whether ANY private read happened: when
// one has, the next Calypso follow-up omits the prior assistant answer from the
// replayed model context entirely (see calypso-follow-up.ts), so private content
// read last turn is never re-exposed to a fresh (empty-ledger) gateway.
//
// Keep this in sync with the enclave's harvestEgressTaint switch. (connector.read
// is the one exception: its dispatch returns early and harvests via the dedicated
// harvestConnectorReadEgressTaint path, NOT the harvestEgressTaint switch — but it
// MUST be in this set so the cross-subtask + client-follow-up consumers below
// treat connector reads as private.)

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
  // connector.read surfaces PRIVATE external data (calendar; later mail/chat) into
  // the model context — a private read like folder.read/memory.read. Membership
  // here is load-bearing BEYOND the in-gateway egress ledger (dispatchConnector
  // harvests that directly): it also marks connector-read-derived ORCHESTRATOR
  // subtasks/working-memory as private (so an egress web worker in another subtask
  // can't replay it — executor.ts) and triggers the CLIENT follow-up omission
  // (tool-fulfiller.ts) so last turn's connector answer isn't re-exposed to a
  // fresh empty-ledger gateway. connector.act (mutation) and connector.list
  // (catalog metadata) are deliberately NOT private reads.
  "connector.read",
]);
