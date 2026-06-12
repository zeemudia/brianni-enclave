/**
 * Minimal CBOR decoder/encoder for Nitro attestation documents.
 *
 * Only handles the CBOR types present in COSE_Sign1 attestation documents:
 *   - Major 0: unsigned integer
 *   - Major 1: negative integer
 *   - Major 2: byte string
 *   - Major 3: text string
 *   - Major 4: array
 *   - Major 5: map
 *   - Major 7: simple values (false, true, null)
 *
 * This avoids adding a third-party CBOR dependency for security-critical code.
 */

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

export type CBORValue =
  | number
  | bigint
  | Uint8Array
  | string
  | CBORValue[]
  | Map<CBORValue, CBORValue>
  | boolean
  | null;

interface DecodeResult {
  value: CBORValue;
  bytesRead: number;
}

// H1 error-handling-audit hardening. decodeCBOR is the FIRST operation on
// the host-supplied attestation document, so the decoder must be hostile-
// input safe: every truncated form throws, no loop can run without making
// byte progress, and input size / nesting depth are bounded well above
// anything a real NSM attestation document produces (~20 KiB, ~4 levels).
const MAX_CBOR_INPUT_BYTES = 1024 * 1024;
const MAX_CBOR_DEPTH = 32;

/**
 * Guard against decoder stalls: a malformed item that reports a non-finite
 * or non-positive bytesRead would make the container loops below spin
 * forever (the original H1 bug: a truncated additional-info-24 argument
 * produced bytesRead = NaN, and `pos += NaN` defeated every loop guard).
 */
function assertProgress(item: DecodeResult): DecodeResult {
  if (!Number.isFinite(item.bytesRead) || item.bytesRead <= 0) {
    throw new Error('Malformed CBOR: decoder made no progress');
  }
  return item;
}

function readArgument(
  data: Uint8Array,
  offset: number,
  additionalInfo: number,
): { value: number | bigint; bytesRead: number } {
  if (additionalInfo < 24) {
    return { value: additionalInfo, bytesRead: 0 };
  }
  // Bounds-check BEFORE reading. additional-info 24 previously read
  // data[offset] unchecked: at end-of-buffer it returned value=undefined,
  // which poisoned bytesRead to NaN downstream (H1 infinite-loop vector
  // [0x9f, 0x58]). 25/26/27 were only incidentally protected by DataView's
  // RangeError — make all four explicit and uniform.
  if (additionalInfo === 24) {
    if (offset + 1 > data.length) throw new Error('Unexpected end of CBOR data');
    return { value: data[offset], bytesRead: 1 };
  }
  if (additionalInfo === 25) {
    if (offset + 2 > data.length) throw new Error('Unexpected end of CBOR data');
    const view = new DataView(data.buffer, data.byteOffset + offset, 2);
    return { value: view.getUint16(0), bytesRead: 2 };
  }
  if (additionalInfo === 26) {
    if (offset + 4 > data.length) throw new Error('Unexpected end of CBOR data');
    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    return { value: view.getUint32(0), bytesRead: 4 };
  }
  if (additionalInfo === 27) {
    if (offset + 8 > data.length) throw new Error('Unexpected end of CBOR data');
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const val = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
    if (val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: Number(val), bytesRead: 8 };
    }
    return { value: val, bytesRead: 8 };
  }
  // additionalInfo === 31 (indefinite-length marker + BREAK) is handled by
  // decodeItem before calling readArgument, so reaching this branch means
  // the caller passed us something out-of-contract — throw loudly.
  throw new Error(`Unsupported CBOR additional info: ${additionalInfo}`);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function decodeItem(data: Uint8Array, offset: number, depth: number): DecodeResult {
  if (offset >= data.length) {
    throw new Error('Unexpected end of CBOR data');
  }
  if (depth > MAX_CBOR_DEPTH) {
    throw new Error(`CBOR nesting depth exceeds limit (${MAX_CBOR_DEPTH})`);
  }

  const initial = data[offset];
  const majorType = initial >> 5;
  const additionalInfo = initial & 0x1f;
  let pos = offset + 1;

  // BREAK (0xff = major 7 + additional 31) is a sentinel that closes an
  // indefinite-length string/array/map — it has no value and is not a valid
  // encoded CBOR data item on its own (RFC 8949 §3.2.1). The indefinite-
  // length loops below detect BREAK directly via `data[pos] === 0xff` before
  // recursing into decodeItem, so reaching this branch means BREAK was
  // encountered outside any container — malformed input, throw.
  if (majorType === 7 && additionalInfo === 31) {
    throw new Error('BREAK marker outside indefinite-length container');
  }

  // Indefinite-length container/string (additional info 31, major types 2-5).
  if (additionalInfo === 31 && majorType >= 2 && majorType <= 5) {
    if (majorType === 2 || majorType === 3) {
      // A series of definite-length chunks of the same major type, ended by BREAK.
      const chunks: Uint8Array[] = [];
      let chunkPos = pos;
      while (true) {
        if (chunkPos >= data.length) throw new Error('Unexpected end of CBOR data');
        if (data[chunkPos] === 0xff) {
          chunkPos += 1;
          break;
        }
        const chunk = assertProgress(decodeItem(data, chunkPos, depth + 1));
        if (!(chunk.value instanceof Uint8Array) && typeof chunk.value !== 'string') {
          throw new Error('Indefinite-length string contained non-string chunk');
        }
        if (majorType === 2 && chunk.value instanceof Uint8Array) {
          chunks.push(chunk.value);
        } else if (majorType === 3 && typeof chunk.value === 'string') {
          chunks.push(new TextEncoder().encode(chunk.value));
        } else {
          throw new Error('Indefinite-length chunk major-type mismatch');
        }
        chunkPos += chunk.bytesRead;
      }
      const joined = concatBytes(chunks);
      if (majorType === 2) return { value: joined, bytesRead: chunkPos - offset };
      return { value: new TextDecoder().decode(joined), bytesRead: chunkPos - offset };
    }

    if (majorType === 4) {
      const arr: CBORValue[] = [];
      let arrPos = pos;
      while (true) {
        if (arrPos >= data.length) throw new Error('Unexpected end of CBOR data');
        if (data[arrPos] === 0xff) {
          arrPos += 1;
          break;
        }
        const item = assertProgress(decodeItem(data, arrPos, depth + 1));
        arr.push(item.value);
        arrPos += item.bytesRead;
      }
      return { value: arr, bytesRead: arrPos - offset };
    }

    // majorType === 5, indefinite map
    const map = new Map<CBORValue, CBORValue>();
    let mapPos = pos;
    while (true) {
      if (mapPos >= data.length) throw new Error('Unexpected end of CBOR data');
      if (data[mapPos] === 0xff) {
        mapPos += 1;
        break;
      }
      const key = assertProgress(decodeItem(data, mapPos, depth + 1));
      mapPos += key.bytesRead;
      const val = assertProgress(decodeItem(data, mapPos, depth + 1));
      mapPos += val.bytesRead;
      map.set(key.value, val.value);
    }
    return { value: map, bytesRead: mapPos - offset };
  }

  const arg = readArgument(data, pos, additionalInfo);
  pos += arg.bytesRead;
  const argNum = typeof arg.value === 'bigint' ? Number(arg.value) : arg.value;

  switch (majorType) {
    case 0: // unsigned integer
      return { value: arg.value, bytesRead: pos - offset };

    case 1: // negative integer
      if (typeof arg.value === 'bigint') {
        return { value: -(arg.value + 1n), bytesRead: pos - offset };
      }
      return { value: -(arg.value + 1), bytesRead: pos - offset };

    case 2: {
      // byte string — declared length must fit inside the buffer; slice()
      // would otherwise silently truncate (fail-open on malformed input).
      if (pos + argNum > data.length) throw new Error('Unexpected end of CBOR data');
      const bytes = data.slice(pos, pos + argNum);
      return { value: bytes, bytesRead: pos + argNum - offset };
    }

    case 3: {
      // text string — same bounds rule as byte strings.
      if (pos + argNum > data.length) throw new Error('Unexpected end of CBOR data');
      const textBytes = data.slice(pos, pos + argNum);
      const text = new TextDecoder().decode(textBytes);
      return { value: text, bytesRead: pos + argNum - offset };
    }

    case 4: {
      // array
      const arr: CBORValue[] = [];
      let arrPos = pos;
      for (let i = 0; i < argNum; i++) {
        const item = assertProgress(decodeItem(data, arrPos, depth + 1));
        arr.push(item.value);
        arrPos += item.bytesRead;
      }
      return { value: arr, bytesRead: arrPos - offset };
    }

    case 5: {
      // map
      const map = new Map<CBORValue, CBORValue>();
      let mapPos = pos;
      for (let i = 0; i < argNum; i++) {
        const key = assertProgress(decodeItem(data, mapPos, depth + 1));
        mapPos += key.bytesRead;
        const val = assertProgress(decodeItem(data, mapPos, depth + 1));
        mapPos += val.bytesRead;
        map.set(key.value, val.value);
      }
      return { value: map, bytesRead: mapPos - offset };
    }

    case 7: // simple values
      if (additionalInfo === 20) return { value: false, bytesRead: 1 };
      if (additionalInfo === 21) return { value: true, bytesRead: 1 };
      if (additionalInfo === 22) return { value: null, bytesRead: 1 };
      throw new Error(`Unsupported CBOR simple value: ${additionalInfo}`);

    default:
      throw new Error(`Unsupported CBOR major type: ${majorType}`);
  }
}

export function decodeCBOR(data: Uint8Array): CBORValue {
  if (data.length > MAX_CBOR_INPUT_BYTES) {
    throw new Error(
      `CBOR input too large: ${data.length} bytes (max ${MAX_CBOR_INPUT_BYTES})`,
    );
  }
  const result = decodeItem(data, 0, 0);
  return result.value;
}

// ---------------------------------------------------------------------------
// Encoder (for COSE Sig_structure)
// ---------------------------------------------------------------------------

function encodeLength(majorType: number, length: number): Uint8Array {
  const major = majorType << 5;
  if (length < 24) {
    return new Uint8Array([major | length]);
  }
  if (length < 0x100) {
    return new Uint8Array([major | 24, length]);
  }
  if (length < 0x10000) {
    const buf = new Uint8Array(3);
    buf[0] = major | 25;
    new DataView(buf.buffer).setUint16(1, length);
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = major | 26;
  new DataView(buf.buffer).setUint32(1, length);
  return buf;
}

function encodeValue(value: CBORValue): Uint8Array {
  if (value === null) return new Uint8Array([0xf6]);
  if (value === false) return new Uint8Array([0xf4]);
  if (value === true) return new Uint8Array([0xf5]);

  if (typeof value === 'number') {
    if (value >= 0) {
      return encodeLength(0, value);
    }
    return encodeLength(1, -(value + 1));
  }

  if (typeof value === 'string') {
    const encoded = new TextEncoder().encode(value);
    const header = encodeLength(3, encoded.length);
    const result = new Uint8Array(header.length + encoded.length);
    result.set(header);
    result.set(encoded, header.length);
    return result;
  }

  if (value instanceof Uint8Array) {
    const header = encodeLength(2, value.length);
    const result = new Uint8Array(header.length + value.length);
    result.set(header);
    result.set(value, header.length);
    return result;
  }

  if (Array.isArray(value)) {
    const header = encodeLength(4, value.length);
    const parts = [header, ...value.map(encodeValue)];
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result;
  }

  throw new Error(`Cannot CBOR-encode value of type ${typeof value}`);
}

export function encodeCBOR(value: CBORValue): Uint8Array {
  return encodeValue(value);
}
