import { describe, expect, it } from 'vitest';
import { PaddedFrameEncoder, PaddedFrameDecoder } from '../padding';

// R4 media-delivery investigation (2026-06-14): generated images never reached
// the client — the enclave streamed all binary_work_item chunk frames but the
// client never dispatched/ACKed them, so the enclave blocked forever on the
// write-ACK and the turn rendered "couldn't finish". This regression guard
// proves the IN-REPO padded-SSE codec + SSE line parser correctly round-trip a
// large (~233 KB) binary `event: chunk` frame — i.e. the failure is NOT in this
// layer. It localises R4 to the live edge (CF/proxy) transformation of large
// SSE response frames; the fix is an edge-config audit, not a codec change.
//
// Mirror of apps/web/lib/agent/transport.ts readBodyAsPaddedText +
// parseSseTextChunks so the round-trip is exercised exactly as production does.
async function* readBodyAsPaddedText(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new PaddedFrameDecoder({ mode: 'response' });
  const textDecoder = new TextDecoder();
  for await (const value of chunks) {
    for (const frame of decoder.push(value)) {
      const text = textDecoder.decode(frame, { stream: true });
      if (text) yield text;
    }
  }
  decoder.endOfStream();
}

async function* parseSseTextChunks(
  chunks: AsyncIterable<string>,
): AsyncGenerator<{ event: string; data: string }> {
  let buf = '';
  let currentEvent = 'message';
  let dataBuf: string[] = [];
  const flush = () => {
    if (dataBuf.length === 0) return null;
    const ev = { event: currentEvent, data: dataBuf.join('\n') };
    dataBuf = [];
    currentEvent = 'message';
    return ev;
  };
  for await (const chunk of chunks) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        const ev = flush();
        if (ev) yield ev;
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataBuf.push(line.slice(5).trim());
        continue;
      }
    }
  }
  const trailing = flush();
  if (trailing) yield trailing;
}

function sseLine(event: string, data: string): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

// Feed encoded frames split into arbitrary network-sized reads (CF/LB re-chunks).
function networkChunks(frames: Uint8Array[], readSize: number): AsyncIterable<Uint8Array> {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    merged.set(f, off);
    off += f.length;
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < merged.length; i += readSize) {
        yield merged.subarray(i, Math.min(i + readSize, merged.length));
      }
    },
  };
}

async function collect(frames: Uint8Array[], readSize: number) {
  const events: { event: string; dataLen: number }[] = [];
  let threw: unknown = null;
  try {
    for await (const ev of parseSseTextChunks(readBodyAsPaddedText(networkChunks(frames, readSize)))) {
      events.push({ event: ev.event, dataLen: ev.data.length });
    }
  } catch (e) {
    threw = e;
  }
  return { events, threw };
}

describe('R4 repro: large binary chunk frame over padded SSE', () => {
  it('encodes + surfaces a SMALL chunk event (baseline)', async () => {
    const small = PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'aGVsbG8='));
    const { events, threw } = await collect([small], 4096);
    expect(threw).toBeNull();
    expect(events).toEqual([{ event: 'chunk', dataLen: 'aGVsbG8='.length }]);
  });

  it('surfaces a LARGE (128KB raw -> ~233KB b64) binary chunk event', async () => {
    // A real binary_work_item.chunk: 128KB raw -> base64 -> JSON -> encrypt -> base64 for SSE data.
    // Approximate the SSE data size: ~233KB of base64 text.
    const bigData = 'A'.repeat(233000);
    const frame = PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', bigData));
    const { events, threw } = await collect([frame], 16384);
    expect(threw).toBeNull();
    expect(events).toEqual([{ event: 'chunk', dataLen: bigData.length }]);
  });

  it('surfaces small orchestrator events FOLLOWED BY large binary chunks (the R4 sequence)', async () => {
    const frames = [
      PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'cGxhbg==')), // plan
      PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'YXJ0aWZhY3Q=')), // artifact
      PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'B'.repeat(233000))), // write_request-ish
      PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'C'.repeat(233000))), // chunk 1
      PaddedFrameEncoder.encodeResponseChunk(sseLine('chunk', 'D'.repeat(233000))), // chunk 2
    ];
    const { events, threw } = await collect(frames, 65536);
    expect(threw).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['chunk', 'chunk', 'chunk', 'chunk', 'chunk']);
  });
});
