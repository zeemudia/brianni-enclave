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

  // =====================================================================
  // Mutation-hardening: exact decoded VALUES for the multi-byte integer
  // argument widths (readArgument, additional info 24/25/26/27). These kill
  // DataView offset-arithmetic mutants, the MAX_SAFE_INTEGER comparison
  // mutant, and the number-vs-bigint branch mutant.
  // =====================================================================
  describe('uint argument widths (readArgument)', () => {
    it('decodes a 1-byte (additional-info 24) uint to its exact value', () => {
      // 0x18 = major 0, additional 24; next byte is the value.
      expect(decodeCBOR(new Uint8Array([0x18, 0x18]))).toBe(24);
      expect(decodeCBOR(new Uint8Array([0x18, 0xff]))).toBe(255);
    });

    it('decodes a 2-byte (additional-info 25) uint to its exact value', () => {
      // 0x19 0x01 0x00 = uint16 0x0100 = 256 (big-endian).
      expect(decodeCBOR(new Uint8Array([0x19, 0x01, 0x00]))).toBe(256);
      // Distinguishes hi/lo byte order: 0x0102 = 258, not 0x0201 = 513.
      expect(decodeCBOR(new Uint8Array([0x19, 0x01, 0x02]))).toBe(258);
      expect(decodeCBOR(new Uint8Array([0x19, 0xff, 0xff]))).toBe(65535);
    });

    it('throws when a 2-byte uint argument is truncated', () => {
      // 0x19 declares 2 argument bytes but only 1 is present.
      expect(() => decodeCBOR(new Uint8Array([0x19, 0x01]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('decodes a 4-byte (additional-info 26) uint to its exact value', () => {
      // 0x1a 00 01 00 00 = uint32 0x00010000 = 65536 (big-endian).
      expect(decodeCBOR(new Uint8Array([0x1a, 0x00, 0x01, 0x00, 0x00]))).toBe(65536);
      // 0x1a 12 34 56 78 = 0x12345678 = 305419896 — byte-order sensitive.
      expect(decodeCBOR(new Uint8Array([0x1a, 0x12, 0x34, 0x56, 0x78]))).toBe(305419896);
      expect(decodeCBOR(new Uint8Array([0x1a, 0xff, 0xff, 0xff, 0xff]))).toBe(4294967295);
    });

    it('throws when a 4-byte uint argument is truncated', () => {
      // 0x1a declares 4 argument bytes but only 3 are present.
      expect(() => decodeCBOR(new Uint8Array([0x1a, 0x00, 0x01, 0x00]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('decodes an 8-byte (additional-info 27) uint <= MAX_SAFE_INTEGER as a number', () => {
      // 0x1b 00 00 00 01 00 00 00 00 = 2^32 = 4294967296 (exercises hi*2^32+lo).
      const v = decodeCBOR(new Uint8Array([0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
      expect(typeof v).toBe('number');
      expect(v).toBe(4294967296);
    });

    it('decodes an 8-byte uint exactly equal to MAX_SAFE_INTEGER as a number', () => {
      // 9007199254740991 = 0x001FFFFFFFFFFFFF. The boundary is `<=`, so this
      // stays a number (kills a `<`-vs-`<=` comparison mutant).
      const v = decodeCBOR(new Uint8Array([0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      expect(typeof v).toBe('number');
      expect(v).toBe(Number.MAX_SAFE_INTEGER);
      expect(v).toBe(9007199254740991);
    });

    it('decodes an 8-byte uint just above MAX_SAFE_INTEGER as an exact bigint', () => {
      // 9007199254740992 = 2^53 = 0x0020000000000000 — one past the boundary.
      const v = decodeCBOR(new Uint8Array([0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      expect(typeof v).toBe('bigint');
      expect(v).toBe(9007199254740992n);
    });

    it('decodes the maximum 8-byte uint as an exact bigint', () => {
      // 0xFFFFFFFFFFFFFFFF = 18446744073709551615 — exercises hi*2^32+lo with
      // both words at max (kills the 0x100000000 multiplier mutant).
      const v = decodeCBOR(new Uint8Array([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      expect(typeof v).toBe('bigint');
      expect(v).toBe(18446744073709551615n);
    });

    it('throws when an 8-byte uint argument is truncated', () => {
      // 0x1b declares 8 argument bytes but only 7 are present.
      expect(() => decodeCBOR(new Uint8Array([0x1b, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });
  });

  // =====================================================================
  // Mutation-hardening: negative integers (major type 1). Kills the
  // UnaryOperator / ArithmeticOperator mutants on the -(value+1) formulas
  // and the number-vs-bigint branch.
  // =====================================================================
  describe('negative integers (major type 1)', () => {
    it('decodes 0x20 to exactly -1', () => {
      expect(decodeCBOR(new Uint8Array([0x20]))).toBe(-1);
    });

    it('decodes 0x29 to exactly -10', () => {
      // additional-info 9 → -(9+1) = -10.
      expect(decodeCBOR(new Uint8Array([0x29]))).toBe(-10);
    });

    it('decodes 0x37 to exactly -24 (largest single-byte negative)', () => {
      // additional-info 23 → -(23+1) = -24.
      expect(decodeCBOR(new Uint8Array([0x37]))).toBe(-24);
    });

    it('decodes a multi-byte negative to its exact value', () => {
      // 0x38 0xff = major 1, additional 24, arg 255 → -(255+1) = -256.
      expect(decodeCBOR(new Uint8Array([0x38, 0xff]))).toBe(-256);
      // 0x39 0x01 0x00 = arg 256 → -(256+1) = -257.
      expect(decodeCBOR(new Uint8Array([0x39, 0x01, 0x00]))).toBe(-257);
    });

    it('decodes a large negative requiring the bigint path to an exact bigint', () => {
      // 0x3b 0xFF..FF = arg 18446744073709551615n → -(val+1n)
      //   = -18446744073709551616.
      const v = decodeCBOR(new Uint8Array([0x3b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      expect(typeof v).toBe('bigint');
      expect(v).toBe(-18446744073709551616n);
    });

    it('decodes a negative one past the safe-integer boundary as an exact bigint', () => {
      // 0x3b 0x0020.. = arg 9007199254740992n (>MAX_SAFE) → -(val+1n)
      //   = -9007199254740993.
      const v = decodeCBOR(new Uint8Array([0x3b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      expect(typeof v).toBe('bigint');
      expect(v).toBe(-9007199254740993n);
    });

    it('advances correctly past a bigint negative inside an array (bytesRead in the bigint branch)', () => {
      // [array(2): -18446744073709551616n (0x3b ff×8), 7]. The negative-integer
      // BIGINT branch has its own `bytesRead: pos - offset`; a `pos + offset`
      // mutant there mis-positions the trailing 7. Distinct from the number
      // branch already covered by the [-10, 100] test.
      const v = decodeCBOR(
        new Uint8Array([0x82, 0x3b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07]),
      ) as unknown[];
      expect(v[0]).toBe(-18446744073709551616n);
      expect(v[1]).toBe(7);
    });
  });

  // =====================================================================
  // Mutation-hardening: unsigned integers (major type 0) exact values.
  // =====================================================================
  describe('unsigned integers (major type 0)', () => {
    it('decodes 0x00 to exactly 0 and 0x17 to exactly 23', () => {
      expect(decodeCBOR(new Uint8Array([0x00]))).toBe(0);
      // additional-info 23 is the largest inline value (no argument bytes).
      expect(decodeCBOR(new Uint8Array([0x17]))).toBe(23);
    });
  });

  // =====================================================================
  // Mutation-hardening: definite-length byte/text string bounds + content.
  // =====================================================================
  describe('definite byte/text strings (major types 2/3)', () => {
    it('decodes a definite byte string to its exact bytes', () => {
      // 0x43 = bstr(3), content 0x01 0x02 0x03.
      const v = decodeCBOR(new Uint8Array([0x43, 0x01, 0x02, 0x03]));
      expect(v).toBeInstanceOf(Uint8Array);
      expect(v).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    });

    it('decodes an empty definite byte string to a zero-length Uint8Array', () => {
      const v = decodeCBOR(new Uint8Array([0x40]));
      expect(v).toBeInstanceOf(Uint8Array);
      expect(v).toEqual(new Uint8Array(0));
    });

    it('throws when a byte string declares more bytes than the buffer holds', () => {
      // 0x44 = bstr(4) but only 3 content bytes present.
      expect(() => decodeCBOR(new Uint8Array([0x44, 0x01, 0x02, 0x03]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws CLEANLY on a byte string whose declared length exceeds Number.MAX_SAFE_INTEGER', () => {
      // 0x5b = bstr, additional-info 27 (8-byte length); declared length =
      // 0x0020000000000000 = 2^53 (> MAX_SAFE_INTEGER), so readArgument returns
      // a BIGINT. The decoder MUST normalise it (`argNum = Number(arg.value)`)
      // before the `pos + argNum > data.length` bounds check, which then throws
      // the decoder's own 'Unexpected end of CBOR data'. Without that
      // normalisation `pos + argNum` mixes number + bigint and throws a raw JS
      // `TypeError: Cannot mix BigInt` instead — a reachable hostile-input
      // behaviour difference (Codex PR #156 P2). MAX_CBOR_INPUT_BYTES bounds the
      // actual buffer size, NOT the declared length, so this bigint path is
      // genuinely reachable.
      const bytes = new Uint8Array([0x5b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(() => decodeCBOR(bytes)).toThrow(/Unexpected end of CBOR data/);
    });

    it('throws CLEANLY on a text string whose declared length exceeds Number.MAX_SAFE_INTEGER', () => {
      // Same as above on the text-string path (0x7b = tstr, additional-info 27).
      const bytes = new Uint8Array([0x7b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(() => decodeCBOR(bytes)).toThrow(/Unexpected end of CBOR data/);
    });

    it('decodes a definite text string to its exact string', () => {
      // 0x65 = tstr(5) "hello".
      expect(decodeCBOR(new Uint8Array([0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toBe('hello');
    });

    it('decodes a multi-byte UTF-8 text string correctly', () => {
      // 0x62 = tstr(2), bytes 0xC3 0xA9 = "é".
      expect(decodeCBOR(new Uint8Array([0x62, 0xc3, 0xa9]))).toBe('é');
    });

    it('throws when a text string declares more bytes than the buffer holds', () => {
      // 0x65 = tstr(5) but only 4 content bytes present.
      expect(() => decodeCBOR(new Uint8Array([0x65, 0x68, 0x65, 0x6c, 0x6c]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });
  });

  // =====================================================================
  // Mutation-hardening: definite-length arrays and maps exact contents.
  // =====================================================================
  describe('definite arrays and maps (major types 4/5)', () => {
    it('decodes a definite array to its exact contents in order', () => {
      // 0x83 = array(3): 1, 2, 3.
      expect(decodeCBOR(new Uint8Array([0x83, 0x01, 0x02, 0x03]))).toEqual([1, 2, 3]);
    });

    it('decodes an empty definite array to an empty array', () => {
      expect(decodeCBOR(new Uint8Array([0x80]))).toEqual([]);
    });

    it('decodes a definite array of mixed types preserving order', () => {
      // 0x83 = array(3): 1, "a" (tstr 0x61 0x61), bstr 0x41 0xbb.
      const v = decodeCBOR(new Uint8Array([0x83, 0x01, 0x61, 0x61, 0x41, 0xbb])) as unknown[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBe(1);
      expect(v[1]).toBe('a');
      expect(v[2]).toEqual(new Uint8Array([0xbb]));
    });

    it('decodes a multi-entry definite map to its exact entries', () => {
      // 0xa2 = map(2): {1:2, 3:4}.
      const v = decodeCBOR(new Uint8Array([0xa2, 0x01, 0x02, 0x03, 0x04])) as Map<number, number>;
      expect(v).toBeInstanceOf(Map);
      expect(v.size).toBe(2);
      expect(v.get(1)).toBe(2);
      expect(v.get(3)).toBe(4);
    });

    it('throws when a definite array item is truncated', () => {
      // 0x82 = array(2) but only 1 item present.
      expect(() => decodeCBOR(new Uint8Array([0x82, 0x01]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws when a definite map value is truncated', () => {
      // 0xa1 = map(1), key 0x01 present but no value byte.
      expect(() => decodeCBOR(new Uint8Array([0xa1, 0x01]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });
  });

  // =====================================================================
  // Mutation-hardening: simple values (major type 7) — exact mappings and
  // the unsupported-value throw.
  // =====================================================================
  describe('simple values (major type 7)', () => {
    it('decodes 0xf4 to false, 0xf5 to true, 0xf6 to null', () => {
      expect(decodeCBOR(new Uint8Array([0xf4]))).toBe(false);
      expect(decodeCBOR(new Uint8Array([0xf5]))).toBe(true);
      expect(decodeCBOR(new Uint8Array([0xf6]))).toBeNull();
    });

    it('throws on an unsupported simple value (0xf7 / additional-info 23)', () => {
      expect(() => decodeCBOR(new Uint8Array([0xf7]))).toThrow(
        /Unsupported CBOR simple value/,
      );
    });
  });

  // =====================================================================
  // Mutation-hardening: top-level guards — empty input, BREAK outside a
  // container, depth limit, and the input-size cap.
  // =====================================================================
  describe('decoder guards', () => {
    it('throws on empty input (offset >= length)', () => {
      expect(() => decodeCBOR(new Uint8Array(0))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('throws on a bare BREAK byte with the BREAK-specific message', () => {
      expect(() => decodeCBOR(new Uint8Array([0xff]))).toThrow(
        /BREAK marker outside indefinite-length container/,
      );
    });

    it('accepts nesting exactly at the depth limit (32 levels)', () => {
      // 32 nested array(1) headers + terminal int. MAX_CBOR_DEPTH = 32 and the
      // guard is `depth > 32`, so the deepest item is at depth 32 and must NOT
      // throw (kills a `>`-vs-`>=` boundary mutant).
      const bytes = new Uint8Array(33);
      bytes.fill(0x81, 0, 32); // array(1) x 32
      bytes[32] = 0x07; // terminal uint 7
      const decoded = decodeCBOR(bytes);
      // Walk down 32 array layers to the leaf.
      let cur: unknown = decoded;
      for (let i = 0; i < 32; i++) {
        expect(Array.isArray(cur)).toBe(true);
        cur = (cur as unknown[])[0];
      }
      expect(cur).toBe(7);
    });

    it('throws when nesting exceeds the depth limit (33 levels)', () => {
      const bytes = new Uint8Array(34);
      bytes.fill(0x81, 0, 33); // array(1) x 33 — one past the limit
      bytes[33] = 0x01;
      expect(() => decodeCBOR(bytes)).toThrow(/depth/i);
    });

    it('accepts input exactly at the size cap (1 MiB)', () => {
      // Exactly MAX_CBOR_INPUT_BYTES must NOT throw "too large" (the guard is
      // `> MAX`, not `>=`). A single bstr(0) header padded out to 1 MiB still
      // decodes to an empty byte string (trailing bytes are ignored).
      const atCap = new Uint8Array(1024 * 1024);
      atCap[0] = 0x40; // bstr(0)
      const v = decodeCBOR(atCap);
      expect(v).toBeInstanceOf(Uint8Array);
      expect(v).toEqual(new Uint8Array(0));
    });

    it('throws on input one byte over the size cap', () => {
      const tooBig = new Uint8Array(1024 * 1024 + 1);
      tooBig[0] = 0x40;
      expect(() => decodeCBOR(tooBig)).toThrow(/too large/i);
    });
  });

  // =====================================================================
  // Mutation-hardening: indefinite-length string/array/map content + the
  // chunk-type-mismatch and truncation throws (L136-L196).
  // =====================================================================
  describe('indefinite-length container content (exact)', () => {
    it('concatenates indefinite byte-string chunks in order', () => {
      // 0x5f, chunks bstr(2) 0xaa 0xbb, bstr(1) 0xcc, BREAK.
      const v = decodeCBOR(new Uint8Array([0x5f, 0x42, 0xaa, 0xbb, 0x41, 0xcc, 0xff]));
      expect(v).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    });

    it('decodes an empty indefinite byte string (immediate BREAK) to zero bytes', () => {
      const v = decodeCBOR(new Uint8Array([0x5f, 0xff]));
      expect(v).toEqual(new Uint8Array(0));
    });

    it('concatenates indefinite text-string chunks in order', () => {
      // 0x7f, chunks tstr(1) "a", tstr(2) "bc", BREAK.
      expect(decodeCBOR(new Uint8Array([0x7f, 0x61, 0x61, 0x62, 0x62, 0x63, 0xff]))).toBe('abc');
    });

    it('rejects an indefinite text string containing a byte-string chunk', () => {
      // 0x7f = major 3 (text), but chunk 0x41 0xaa is a byte string (major 2).
      expect(() => decodeCBOR(new Uint8Array([0x7f, 0x41, 0xaa, 0xff]))).toThrow(
        /chunk major-type mismatch|contained non-string chunk/,
      );
    });

    it('rejects an indefinite byte string truncated before BREAK', () => {
      // 0x5f, one chunk bstr(1) 0xaa, but no BREAK.
      expect(() => decodeCBOR(new Uint8Array([0x5f, 0x41, 0xaa]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('decodes an indefinite array of mixed types preserving order', () => {
      // 0x9f, items: 1, "a", bstr 0xbb, BREAK.
      const v = decodeCBOR(new Uint8Array([0x9f, 0x01, 0x61, 0x61, 0x41, 0xbb, 0xff])) as unknown[];
      expect(v).toEqual([1, 'a', new Uint8Array([0xbb])]);
    });

    it('decodes an empty indefinite array (immediate BREAK)', () => {
      expect(decodeCBOR(new Uint8Array([0x9f, 0xff]))).toEqual([]);
    });

    it('decodes an indefinite map to its exact entries', () => {
      // 0xbf, pairs {"a":1, "b":2}, BREAK.
      const v = decodeCBOR(
        new Uint8Array([0xbf, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02, 0xff]),
      ) as Map<string, number>;
      expect(v).toBeInstanceOf(Map);
      expect(v.size).toBe(2);
      expect(v.get('a')).toBe(1);
      expect(v.get('b')).toBe(2);
    });

    it('decodes an empty indefinite map (immediate BREAK)', () => {
      const v = decodeCBOR(new Uint8Array([0xbf, 0xff])) as Map<unknown, unknown>;
      expect(v).toBeInstanceOf(Map);
      expect(v.size).toBe(0);
    });

    it('rejects an indefinite map truncated after a complete key/value pair', () => {
      // 0xbf, pair {1:2}, but no BREAK afterwards.
      expect(() => decodeCBOR(new Uint8Array([0xbf, 0x01, 0x02]))).toThrow(
        /Unexpected end of CBOR data/,
      );
    });

    it('drives nested items through assertProgress without stalling', () => {
      // Each nested item reports a positive bytesRead so the indefinite-array
      // loop advances and terminates at BREAK. Exercises the assertProgress
      // pass-through path on every inner decode.
      const v = decodeCBOR(new Uint8Array([0x9f, 0x18, 0x2a, 0x41, 0x05, 0xff])) as unknown[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBe(42); // 0x18 0x2a
      expect(v[1]).toEqual(new Uint8Array([0x05])); // 0x41 0x05
    });
  });

  // =====================================================================
  // Mutation-hardening: ENCODER. Exact header bytes across the encodeLength
  // thresholds (24 / 0x100 / 0x10000), negative numbers, simple values, and
  // the unsupported-type throw.
  // =====================================================================
  describe('encoder length thresholds (encodeLength)', () => {
    it('encodes a short (<24) byte string with an inline-length header', () => {
      // length 3 < 24 → single header byte (major 2 << 5) | 3 = 0x43.
      expect(Array.from(encodeCBOR(new Uint8Array([1, 2, 3])))).toEqual([0x43, 1, 2, 3]);
    });

    it('encodes a 24-byte byte string with a 0x18 (1-byte length) header', () => {
      const out = encodeCBOR(new Uint8Array(24));
      expect(out.length).toBe(26); // 2 header + 24 content
      expect(out[0]).toBe(0x58); // major 2 | 24
      expect(out[1]).toBe(24); // length byte
    });

    it('encodes a 255-byte byte string with a 1-byte length header (still 0x18)', () => {
      // 255 < 0x100 → 0x18 form, length byte = 0xff.
      const out = encodeCBOR(new Uint8Array(255));
      expect(out[0]).toBe(0x58);
      expect(out[1]).toBe(0xff);
      expect(out.length).toBe(257);
    });

    it('encodes a 256-byte byte string with a 0x19 (2-byte length) header', () => {
      // 256 >= 0x100 → uint16 length 0x0100.
      const out = encodeCBOR(new Uint8Array(256));
      expect(out[0]).toBe(0x59); // major 2 | 25
      expect(out[1]).toBe(0x01); // high byte of 256
      expect(out[2]).toBe(0x00); // low byte
      expect(out.length).toBe(259);
    });

    it('encodes a 65535-byte byte string with a 2-byte length header (still 0x19)', () => {
      const out = encodeCBOR(new Uint8Array(65535));
      expect(out[0]).toBe(0x59);
      expect(out[1]).toBe(0xff);
      expect(out[2]).toBe(0xff);
    });

    it('encodes a 65536-byte byte string with a 0x1a (4-byte length) header', () => {
      // 65536 >= 0x10000 → uint32 length 0x00010000.
      const out = encodeCBOR(new Uint8Array(65536));
      expect(out[0]).toBe(0x5a); // major 2 | 26
      expect(out[1]).toBe(0x00);
      expect(out[2]).toBe(0x01);
      expect(out[3]).toBe(0x00);
      expect(out[4]).toBe(0x00);
      expect(out.length).toBe(65541);
    });

    it('encodes a string header using major type 3 with the right threshold', () => {
      // "hi" → tstr(2): (3<<5)|2 = 0x62 followed by UTF-8 bytes.
      expect(Array.from(encodeCBOR('hi'))).toEqual([0x62, 0x68, 0x69]);
    });

    it('encodes an array header using major type 4', () => {
      // [1,2,3] → array(3): 0x83 then 0x01 0x02 0x03.
      expect(Array.from(encodeCBOR([1, 2, 3]))).toEqual([0x83, 0x01, 0x02, 0x03]);
    });
  });

  describe('encoder values', () => {
    it('encodes a non-negative number with major type 0', () => {
      expect(Array.from(encodeCBOR(0))).toEqual([0x00]);
      expect(Array.from(encodeCBOR(23))).toEqual([0x17]);
      expect(Array.from(encodeCBOR(24))).toEqual([0x18, 24]);
      expect(Array.from(encodeCBOR(256))).toEqual([0x19, 0x01, 0x00]);
    });

    it('encodes -1 as 0x20 (major type 1)', () => {
      // -(-1 + 1) = 0 → (1<<5)|0 = 0x20.
      expect(Array.from(encodeCBOR(-1))).toEqual([0x20]);
    });

    it('encodes -256 with a major-1 1-byte length header', () => {
      // -(-256 + 1) = 255 → (1<<5)|24, 0xff = 0x38 0xff.
      expect(Array.from(encodeCBOR(-256))).toEqual([0x38, 0xff]);
    });

    it('encodes -257 with a major-1 2-byte length header', () => {
      // -(-257 + 1) = 256 → (1<<5)|25, 0x01, 0x00 = 0x39 0x01 0x00.
      expect(Array.from(encodeCBOR(-257))).toEqual([0x39, 0x01, 0x00]);
    });

    it('encodes null, false, and true to their fixed simple-value bytes', () => {
      expect(Array.from(encodeCBOR(null))).toEqual([0xf6]);
      expect(Array.from(encodeCBOR(false))).toEqual([0xf4]);
      expect(Array.from(encodeCBOR(true))).toEqual([0xf5]);
    });

    it('throws on an unsupported encode type (plain object)', () => {
      expect(() => encodeCBOR({} as never)).toThrow(/Cannot CBOR-encode/);
    });

    it('throws on an unsupported encode type (bigint)', () => {
      expect(() => encodeCBOR(5n as never)).toThrow(/Cannot CBOR-encode/);
    });

    it('round-trips a nested array containing each supported type', () => {
      const original = [42, 'Signature1', new Uint8Array([0xde, 0xad]), null, true, false, -7];
      const decoded = decodeCBOR(encodeCBOR(original)) as unknown[];
      expect(decoded).toHaveLength(7);
      expect(decoded[0]).toBe(42);
      expect(decoded[1]).toBe('Signature1');
      expect(decoded[2]).toEqual(new Uint8Array([0xde, 0xad]));
      expect(decoded[3]).toBeNull();
      expect(decoded[4]).toBe(true);
      expect(decoded[5]).toBe(false);
      expect(decoded[6]).toBe(-7);
    });
  });

  describe('additional-info edges + nested bytesRead', () => {
    it('throws on a reserved additional-info value (28) for a uint', () => {
      // 0x1c = major 0, additional-info 28 (reserved). Kills the
      // `additionalInfo === 27` branch widening and the readArgument fallthrough.
      expect(() => decodeCBOR(new Uint8Array([0x1c]))).toThrow(
        /Unsupported CBOR additional info/,
      );
    });

    it('throws on additional-info 31 for a non-container major type', () => {
      // 0x1f = major 0 + additional-info 31. The indefinite-length path is
      // gated on majorType 2..5; major 0 must fall through to the throw.
      // Kills the `majorType >= 2` / `majorType <= 5` guard widening.
      expect(() => decodeCBOR(new Uint8Array([0x1f]))).toThrow(
        /Unsupported CBOR additional info/,
      );
    });

    it('advances correctly past a negative integer inside an array (exact bytesRead)', () => {
      // [array(2): -10, 100]. If the negative-integer item reports the wrong
      // bytesRead (`pos + offset` instead of `pos - offset`) the array mis-
      // advances and the trailing 100 is lost / mis-read.
      const decoded = decodeCBOR(new Uint8Array([0x82, 0x29, 0x18, 0x64]));
      expect(decoded).toEqual([-10, 100]);
    });

    it('advances correctly past an indefinite-length byte string inside an array', () => {
      // [array(2): (indefinite bstr "a"), 5]. Kills the indefinite-container
      // bytesRead arithmetic (`chunkPos + offset`) and the post-BREAK advance:
      // a wrong width corrupts the position of the trailing 5.
      const decoded = decodeCBOR(
        new Uint8Array([0x82, 0x5f, 0x41, 0x61, 0xff, 0x05]),
      );
      expect(Array.isArray(decoded)).toBe(true);
      const arr = decoded as unknown[];
      expect(arr[0]).toEqual(new Uint8Array([0x61]));
      expect(arr[1]).toBe(5);
    });

    // --- Mutation-hardening (nitro-verify session): trailing-item bytesRead
    // arithmetic on EACH indefinite/multi-byte container path. A wrong-sign
    // `pos +/- offset` or a `mapPos/arrPos -= 1` post-BREAK advance corrupts
    // the position of the trailing item, so reading it back exactly kills the
    // arithmetic + assignment mutants on the text-string (L162), array
    // (L171/L178), map (L187/L196), and multi-byte-uint (L209) paths.

    it('advances correctly past an indefinite-length TEXT string inside an array (L162)', () => {
      // [array(2): (indefinite tstr "ab"), 7]. Exercises the text-string
      // `bytesRead: chunkPos - offset` return distinctly from the byte path.
      const decoded = decodeCBOR(
        new Uint8Array([0x82, 0x7f, 0x61, 0x61, 0x61, 0x62, 0xff, 0x07]),
      ) as unknown[];
      expect(decoded[0]).toBe('ab');
      expect(decoded[1]).toBe(7);
    });

    it('advances correctly past an indefinite-length ARRAY inside an array (L171/L178)', () => {
      // [array(2): (indefinite array [9]), 7]. Kills `arrPos += 1 -> -= 1`
      // (post-BREAK advance) and `arrPos - offset -> + offset`.
      const decoded = decodeCBOR(
        new Uint8Array([0x82, 0x9f, 0x09, 0xff, 0x07]),
      ) as unknown[];
      expect(decoded[0]).toEqual([9]);
      expect(decoded[1]).toBe(7);
    });

    it('advances correctly past an indefinite-length MAP inside an array (L187/L196)', () => {
      // [array(2): (indefinite map {1:2}), 7]. Kills `mapPos += 1 -> -= 1`
      // and `mapPos - offset -> + offset`.
      const decoded = decodeCBOR(
        new Uint8Array([0x82, 0xbf, 0x01, 0x02, 0xff, 0x07]),
      ) as unknown[];
      expect((decoded[0] as Map<number, number>).get(1)).toBe(2);
      expect(decoded[1]).toBe(7);
    });

    it('advances correctly past a multi-byte unsigned integer inside an array (L209)', () => {
      // [array(2): 256 (0x19 0x01 0x00), 7]. A `pos - offset -> pos + offset`
      // bytesRead mutant on the unsigned-integer case mis-positions the
      // trailing 7.
      const decoded = decodeCBOR(
        new Uint8Array([0x82, 0x19, 0x01, 0x00, 0x07]),
      ) as unknown[];
      expect(decoded[0]).toBe(256);
      expect(decoded[1]).toBe(7);
    });
  });

  // =====================================================================
  // Mutation-hardening (nitro-verify session): the nesting-depth DoS guard
  // (`depth > MAX_CBOR_DEPTH`) is enforced on EVERY recursive descent, but
  // the pre-existing depth tests only drive DEFINITE arrays. A `depth + 1 ->
  // depth - 1` mutant on the indefinite-string-chunk, indefinite-array,
  // indefinite-map, or definite-map descent would let a hostile attestation
  // document recurse without bound (the depth never grows) — a remote
  // stack-exhaustion vector on the FIRST operation over host input. Each
  // bomb below exceeds the limit THROUGH a specific descent so its `depth+1`
  // mutant is killed.
  // =====================================================================
  describe('depth guard on every recursive descent (DoS hardening)', () => {
    it('rejects an indefinite-array bomb deeper than the depth limit (L174)', () => {
      // 33 nested indefinite arrays (0x9f) + terminal int + 33 BREAKs.
      const head = new Array(33).fill(0x9f);
      const tail = new Array(33).fill(0xff);
      expect(() => decodeCBOR(new Uint8Array([...head, 0x01, ...tail]))).toThrow(
        /depth/i,
      );
    });

    it('accepts an indefinite-array nest exactly at the depth limit (32)', () => {
      const head = new Array(32).fill(0x9f);
      const tail = new Array(32).fill(0xff);
      expect(() =>
        decodeCBOR(new Uint8Array([...head, 0x01, ...tail])),
      ).not.toThrow();
    });

    it('rejects an indefinite-map bomb deeper than the depth limit on the VALUE descent (L192)', () => {
      // 33 nested indefinite maps (0xbf), each with one key/value pair whose
      // value is the next map, terminal int as the innermost value, then BREAKs.
      // {1: {1: {1: ... 1 ...}}} — the value descent at L192 carries the depth.
      let inner: number[] = [0x01]; // innermost value
      for (let i = 0; i < 33; i++) inner = [0xbf, 0x01, ...inner, 0xff];
      expect(() => decodeCBOR(new Uint8Array(inner))).toThrow(/depth/i);
    });

    it('rejects an indefinite-map bomb deeper than the depth limit on the KEY descent (L190)', () => {
      // Symmetric to the value bomb but nests the maps on the KEY side:
      // {{{...}: 0}: 0} — so the KEY-decode descent at L190 (a distinct
      // `depth + 1` from the value descent) carries the depth past the limit.
      let node: number[] = [0xbf, 0x00, 0x00, 0xff]; // innermost map {0: 0}
      for (let i = 0; i < 33; i++) node = [0xbf, ...node, 0x00, 0xff]; // {<node>: 0}
      expect(() => decodeCBOR(new Uint8Array(node))).toThrow(/depth/i);
    });

    it('rejects a definite-map bomb deeper than the depth limit on the VALUE descent (L248)', () => {
      // 33 nested definite maps map(1) {0: map(1) {0: ... 1 ...}}.
      let inner: number[] = [0x01];
      for (let i = 0; i < 33; i++) inner = [0xa1, 0x00, ...inner];
      expect(() => decodeCBOR(new Uint8Array(inner))).toThrow(/depth/i);
    });

    it('rejects a definite-map bomb deeper than the depth limit on the KEY descent (L246)', () => {
      // Symmetric to the value bomb but nests the maps on the KEY side:
      // {{{...}: 0}: 0} — so the KEY-decode descent at L246 (distinct from the
      // value descent at L248) carries the depth past the limit.
      let node: number[] = [0xa1, 0x00, 0x00]; // innermost map {0: 0}
      for (let i = 0; i < 33; i++) node = [0xa1, ...node, 0x00]; // {<node>: 0}
      expect(() => decodeCBOR(new Uint8Array(node))).toThrow(/depth/i);
    });

    it('rejects an indefinite-string chunk decoded past the depth limit (L147)', () => {
      // 32 definite array(1) wrappers (depth 0..31), then an indefinite byte
      // string whose chunk is decoded at depth 33 > 32. With `depth - 1` the
      // chunk would decode at depth 31 and never throw.
      const head = new Array(32).fill(0x81);
      expect(() =>
        decodeCBOR(new Uint8Array([...head, 0x5f, 0x41, 0xaa, 0xff])),
      ).toThrow(/depth/i);
    });

    it('accepts an indefinite-string chunk one level within the limit (31 wrappers)', () => {
      const head = new Array(31).fill(0x81);
      expect(() =>
        decodeCBOR(new Uint8Array([...head, 0x5f, 0x41, 0xaa, 0xff])),
      ).not.toThrow();
    });
  });

  // =====================================================================
  // Mutation-hardening (nitro-verify session): the indefinite-length gate
  // (`additionalInfo === 31 && majorType >= 2 && majorType <= 5`) must NOT
  // admit major type 6 (CBOR tags) or 7. `majorType <= 5 -> true` would route
  // 0xdf (major 6 + ai 31) into the indefinite path and mis-decode it as an
  // empty map instead of rejecting it. And the `default:` switch arm + its
  // message are reachable via major type 6 with a DEFINITE additional-info
  // (0xc0) — the prior triage wrongly called this arm structurally
  // unreachable, but CBOR major type 6 (tags) is unhandled and DOES reach it.
  // =====================================================================
  describe('unhandled major types are rejected, not mis-decoded', () => {
    it('rejects major type 6 + indefinite marker (0xdf), not as a map (L136)', () => {
      expect(() => decodeCBOR(new Uint8Array([0xdf, 0xff]))).toThrow(
        /Unsupported CBOR additional info/,
      );
    });

    it('rejects a definite major type 6 (CBOR tag 0xc0) via the default arm (L261/L262)', () => {
      // 0xc0 = major 6, additional-info 0 — a CBOR tag, which this minimal
      // decoder does not support. Reaches the `default:` switch arm and throws
      // with the major-type message. Removing the arm body (or emptying the
      // message) leaves this unthrown / mis-messaged.
      expect(() => decodeCBOR(new Uint8Array([0xc0]))).toThrow(
        /Unsupported CBOR major type: 6/,
      );
    });

    it('rejects an indefinite byte string whose chunk is a non-string item (L148/L149)', () => {
      // 0x5f = indefinite byte string; chunk 0x80 is an empty array (major 4),
      // neither Uint8Array nor string -> the chunk-type guard throws. This arm
      // was previously NoCoverage.
      expect(() => decodeCBOR(new Uint8Array([0x5f, 0x80, 0xff]))).toThrow(
        /contained non-string chunk/,
      );
    });
  });
});
