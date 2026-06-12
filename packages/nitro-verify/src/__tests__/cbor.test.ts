import { describe, it, expect } from 'vitest';
import { decodeCBOR, encodeCBOR } from '../cbor';

describe('CBOR', () => {
  it('round-trips unsigned integers', () => {
    const encoded = encodeCBOR(42);
    expect(decodeCBOR(encoded)).toBe(42);
  });

  it('round-trips strings', () => {
    const encoded = encodeCBOR('Signature1');
    expect(decodeCBOR(encoded)).toBe('Signature1');
  });

  it('round-trips byte strings', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeCBOR(bytes);
    const decoded = decodeCBOR(encoded);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(bytes);
  });

  it('round-trips arrays', () => {
    const arr = ['Signature1', new Uint8Array([0xaa]), new Uint8Array(0), new Uint8Array([0xbb])];
    const encoded = encodeCBOR(arr);
    const decoded = decodeCBOR(encoded) as any[];
    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toBe('Signature1');
  });

  it('round-trips null and booleans', () => {
    expect(decodeCBOR(encodeCBOR(null))).toBeNull();
    expect(decodeCBOR(encodeCBOR(true))).toBe(true);
    expect(decodeCBOR(encodeCBOR(false))).toBe(false);
  });

  it('decodes CBOR maps', () => {
    // Major type 5, 1 pair: key=0 (uint), value=byte string [0xAA]
    const mapBytes = new Uint8Array([0xa1, 0x00, 0x41, 0xaa]);
    const decoded = decodeCBOR(mapBytes);
    expect(decoded).toBeInstanceOf(Map);
    const map = decoded as Map<any, any>;
    expect(map.get(0)).toEqual(new Uint8Array([0xaa]));
  });

  // Indefinite-length encoding (additional info = 31) is used by real AWS
  // Nitro COSE_Sign1 attestations. A decoder that only handles the definite-
  // length fast path fails every live attestation verify.
  describe('indefinite-length (RFC 8949 §3.2.2)', () => {
    it('decodes indefinite-length byte strings', () => {
      // 0x5f = major 2, additional 31. Two chunks 0x41 0xAA, 0x41 0xBB, then BREAK (0xff).
      const bytes = new Uint8Array([0x5f, 0x41, 0xaa, 0x41, 0xbb, 0xff]);
      expect(decodeCBOR(bytes)).toEqual(new Uint8Array([0xaa, 0xbb]));
    });

    it('decodes indefinite-length text strings', () => {
      // 0x7f = major 3, additional 31. Chunks "ab", "cd", then BREAK.
      const bytes = new Uint8Array([0x7f, 0x62, 0x61, 0x62, 0x62, 0x63, 0x64, 0xff]);
      expect(decodeCBOR(bytes)).toBe('abcd');
    });

    it('decodes indefinite-length arrays', () => {
      // 0x9f = major 4, additional 31. Items: 1, 2, 3, then BREAK.
      const bytes = new Uint8Array([0x9f, 0x01, 0x02, 0x03, 0xff]);
      expect(decodeCBOR(bytes)).toEqual([1, 2, 3]);
    });

    it('decodes indefinite-length maps', () => {
      // 0xbf = major 5, additional 31. Pairs: {1: 2, 3: 4}, then BREAK.
      const bytes = new Uint8Array([0xbf, 0x01, 0x02, 0x03, 0x04, 0xff]);
      const decoded = decodeCBOR(bytes) as Map<any, any>;
      expect(decoded).toBeInstanceOf(Map);
      expect(decoded.get(1)).toBe(2);
      expect(decoded.get(3)).toBe(4);
    });

    it('decodes nested indefinite-length containers (COSE_Sign1 shape)', () => {
      // Outer array (indefinite), containing: bstr "ph", map {}, bstr "p", bstr "s", BREAK.
      // Models the COSE_Sign1 [protected, unprotected, payload, signature] array.
      const bytes = new Uint8Array([
        0x9f,                          // array, indefinite
        0x42, 0x70, 0x68,              // bstr(2) "ph"
        0xa0,                          // map(0) — empty unprotected
        0x41, 0x70,                    // bstr(1) "p"
        0x41, 0x73,                    // bstr(1) "s"
        0xff,                          // BREAK
      ]);
      const decoded = decodeCBOR(bytes) as any[];
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded).toHaveLength(4);
      expect(decoded[0]).toEqual(new Uint8Array([0x70, 0x68]));
      expect(decoded[1]).toBeInstanceOf(Map);
      expect(decoded[2]).toEqual(new Uint8Array([0x70]));
      expect(decoded[3]).toEqual(new Uint8Array([0x73]));
    });

    // --- Bug 2 extended regressions (Workstream A) -----------------------

    it('rejects indefinite-length array truncated before BREAK (no hang)', () => {
      // 0x9f = array, indefinite. Items 1, 2 — but no BREAK byte.
      const bytes = new Uint8Array([0x9f, 0x01, 0x02]);
      expect(() => decodeCBOR(bytes)).toThrowError(/Unexpected end of CBOR data/);
    });

    it('rejects indefinite byte-string with text-string chunk', () => {
      // 0x5f = major 2 (byte string), indefinite. Chunk 0 is a text string
      // (major 3, 0x61 "a") which must be rejected — RFC 8949 §3.2.3 requires
      // chunk major type to match container major type.
      const bytes = new Uint8Array([0x5f, 0x61, 0x61, 0xff]);
      expect(() => decodeCBOR(bytes)).toThrowError(
        /chunk major-type mismatch|contained non-string chunk/,
      );
    });

    it('rejects a bare top-level BREAK byte', () => {
      // 0xff is the BREAK sentinel; it only has meaning *inside* an
      // indefinite-length container. RFC 8949 §3.2.1: BREAK is not a valid
      // encoded CBOR data item on its own. Decoding should throw, not return
      // a sentinel value that downstream code can't distinguish from a real
      // decode result.
      expect(() => decodeCBOR(new Uint8Array([0xff]))).toThrow();
    });

    // --- H1 error-handling-audit regressions ------------------------------
    // A truncated additional-info-24 argument used to read past the buffer,
    // yielding `bytesRead = NaN`. Inside an indefinite-length container the
    // NaN made every loop guard fail open: `arrPos += NaN` → `data[NaN]` →
    // an infinite loop that allocates forever. decodeCBOR is the FIRST
    // operation on the host-supplied attestation document, so this was a
    // remote hang/OOM vector. These vectors must THROW, never hang.

    it('throws on [0x9f, 0x58] — truncated bstr argument inside indefinite array (the hang vector)', () => {
      expect(() => decodeCBOR(new Uint8Array([0x9f, 0x58]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on a bare truncated-argument byte string [0x58]', () => {
      expect(() => decodeCBOR(new Uint8Array([0x58]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on truncated multi-byte arguments (additional info 25/26/27)', () => {
      // uint16 argument with only one byte present
      expect(() => decodeCBOR(new Uint8Array([0x19, 0x00]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
      // uint32 argument with no bytes present
      expect(() => decodeCBOR(new Uint8Array([0x1a]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
      // uint64 argument with one byte present
      expect(() => decodeCBOR(new Uint8Array([0x1b, 0x01]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on a definite map truncated before its key', () => {
      // map(1) with no key/value bytes
      expect(() => decodeCBOR(new Uint8Array([0xa1]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on an indefinite map with a truncated key', () => {
      // 0xbf = map indefinite; 0x61 = text(1) with no content byte and no BREAK
      expect(() => decodeCBOR(new Uint8Array([0xbf, 0x61]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on a byte string whose declared length exceeds the payload', () => {
      // bstr(5) with only 1 content byte — must not silently truncate
      expect(() => decodeCBOR(new Uint8Array([0x58, 0x05, 0x01]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on a text string whose declared length exceeds the payload', () => {
      // tstr(5) with only 1 content byte
      expect(() => decodeCBOR(new Uint8Array([0x78, 0x05, 0x61]))).toThrowError(
        /Unexpected end of CBOR data/,
      );
    });

    it('rejects nesting deeper than the decoder depth limit', () => {
      // 64 nested array(1) headers with a terminal int. Real attestation
      // documents nest ~4 levels; anything this deep is hostile input.
      const bytes = new Uint8Array(65);
      bytes.fill(0x81, 0, 64); // array(1) × 64
      bytes[64] = 0x01;
      expect(() => decodeCBOR(bytes)).toThrowError(/depth/i);
    });

    it('rejects inputs larger than the attestation-document size cap', () => {
      // 1 MiB + 1 of valid-looking CBOR (indefinite byte string padding).
      const big = new Uint8Array(1024 * 1024 + 1);
      big[0] = 0x40; // bstr(0) — content irrelevant, the size cap fires first
      expect(() => decodeCBOR(big)).toThrowError(/too large/i);
    });

    it('decodes deeply nested indefinite containers (array → map → byte string)', () => {
      // Outer: indefinite array containing one item.
      // Item: indefinite map { "k" : indefinite byte-string [0xaa, 0xbb] }.
      // Exercises the real COSE_Sign1 shape where multiple nesting layers
      // are independently indefinite-length.
      const bytes = new Uint8Array([
        0x9f,                          // outer array, indefinite
          0xbf,                        //   map, indefinite
            0x61, 0x6b,                //     key: text "k"
            0x5f,                      //     value: byte string, indefinite
              0x41, 0xaa,              //       chunk bstr(1) 0xaa
              0x41, 0xbb,              //       chunk bstr(1) 0xbb
            0xff,                      //     BREAK (byte string)
          0xff,                        //   BREAK (map)
        0xff,                          // BREAK (array)
      ]);
      const decoded = decodeCBOR(bytes) as any[];
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded).toHaveLength(1);
      const inner = decoded[0] as Map<unknown, unknown>;
      expect(inner).toBeInstanceOf(Map);
      expect(inner.get('k')).toEqual(new Uint8Array([0xaa, 0xbb]));
    });
  });
});
