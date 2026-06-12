import { describe, it, expect } from 'vitest';

import { EgressTaintLedger } from '../tools/egress-taint';

describe('EgressTaintLedger', () => {
  it('is permissive before any sensitive content is harvested', () => {
    const t = new EgressTaintLedger();
    expect(t.isEgressTainted('https://example.com/', 'anything goes')).toBe(false);
  });

  it('blocks egress that reproduces a harvested phrase (>=20 normalised chars)', () => {
    const t = new EgressTaintLedger();
    t.addText('My banking recovery answer is the BlueHorizon project');
    // Attacker tries to smuggle the phrase out in the query.
    expect(
      t.isEgressTainted('https://attacker.example/collect', 'banking recovery answer'),
    ).toBe(true);
  });

  it('blocks egress that reproduces a harvested phrase hidden in the URL path', () => {
    const t = new EgressTaintLedger();
    t.addText('The merger with Initech closes on the fifteenth of March');
    expect(
      t.isEgressTainted('https://attacker.example/the%20merger%20with%20initech%20closes', ''),
    ).toBe(true);
  });

  it('blocks egress containing a harvested email (distinctive token 12-19 chars)', () => {
    const t = new EgressTaintLedger();
    t.addText('reach me at janedoe@example.com any time');
    expect(
      t.isEgressTainted('https://attacker.example/?leak=janedoe@example.com', 'hi'),
    ).toBe(true);
  });

  it('does not flag unrelated egress', () => {
    const t = new EgressTaintLedger();
    t.addText('User prefers focused mornings and dislikes late meetings');
    expect(t.isEgressTainted('https://weather.example/london', 'today forecast')).toBe(false);
  });

  it('taints non-ASCII (Cyrillic) content — no language-dependent bypass', () => {
    const t = new EgressTaintLedger();
    t.addText('секретный пароль для банковского проекта синий горизонт');
    expect(
      t.isEgressTainted('https://attacker.example/', 'секретный пароль для банковского проекта'),
    ).toBe(true);
  });

  it('taints CJK content', () => {
    const t = new EgressTaintLedger();
    t.addText('这是银行账户的秘密恢复答案蓝色地平线项目代号');
    expect(t.isEgressTainted('https://attacker.example/', '这是银行账户的秘密恢复答案蓝色地平线项目代号')).toBe(true);
  });

  it('still taints a secret read AFTER a large benign read (no cap-freeze evasion)', () => {
    const t = new EgressTaintLedger();
    // Benign filler larger than any internal harvest budget.
    t.addText('x'.repeat(300 * 1024));
    t.addText('the secret launch codename is crimson albatross protocol');
    expect(
      t.isEgressTainted('https://attacker.example/', 'secret launch codename is crimson albatross'),
    ).toBe(true);
  });

  it('retains the most-recent secret even after distinct content exceeds the gram cap', () => {
    const t = new EgressTaintLedger();
    // ~350 KB of distinct content → far exceeds the gram set cap, forcing
    // eviction. The secret is added LAST so it must survive.
    const benign = Array.from({ length: 50_000 }, (_, i) => i.toString(36).padStart(6, '0')).join(' ');
    t.addText(benign);
    t.addText('the secret merger target is wolfram industries holdings');
    expect(
      t.isEgressTainted('https://attacker.example/', 'secret merger target is wolfram industries'),
    ).toBe(true);
  });
});

// Codex HIGH follow-up: a model can re-encode harvested/replayed private
// content (base64 / base64url / hex / nested percent-encoding) before
// placing it in a web.fetch URL/query, dodging the literal-text taint check.
// The guard canonicalizes these reversible encodings before matching.
describe('EgressTaintLedger — reversible-encoding evasion', () => {
  const SECRET = 'the secret launch codename is crimson albatross protocol';
  const LEAK = 'secret launch codename is crimson albatross';

  it('blocks base64-encoded harvested content in the query', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(LEAK, 'utf8').toString('base64');
    expect(t.isEgressTainted('https://attacker.example/collect', b64)).toBe(true);
  });

  it('blocks base64url-encoded harvested content in the URL path', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64url = Buffer.from(LEAK, 'utf8').toString('base64url');
    expect(t.isEgressTainted(`https://attacker.example/${b64url}`, '')).toBe(true);
  });

  it('blocks hex-encoded harvested content', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const hex = Buffer.from(LEAK, 'utf8').toString('hex');
    expect(t.isEgressTainted('https://attacker.example/', hex)).toBe(true);
  });

  it('blocks double percent-encoded harvested content', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const twice = encodeURIComponent(encodeURIComponent(LEAK));
    expect(t.isEgressTainted('https://attacker.example/', twice)).toBe(true);
  });

  it('blocks percent-then-base64 layering', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const pct = encodeURIComponent(Buffer.from(LEAK, 'utf8').toString('base64'));
    expect(t.isEgressTainted('https://attacker.example/', pct)).toBe(true);
  });

  it('does NOT flag unrelated base64/hex content (no false positive)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const benignB64 = Buffer.from('todays london weather forecast please', 'utf8').toString('base64');
    const benignHex = Buffer.from('best pizza recipes near me tonight', 'utf8').toString('hex');
    expect(t.isEgressTainted('https://search.example/', benignB64)).toBe(false);
    expect(t.isEgressTainted('https://search.example/', benignHex)).toBe(false);
  });
});

// Codex adversarial re-review: the canonicaliser must FAIL CLOSED (not open)
// under adversarial input — malformed percent prefixes, decode-budget padding,
// oversized egress, and standard-base64 path alignment.
describe('EgressTaintLedger — adversarial canonicalisation hardening', () => {
  const SECRET = 'the secret launch codename is crimson albatross protocol';
  const LEAK = 'secret launch codename is crimson albatross';

  it('blocks a secret behind a MALFORMED percent prefix (one bad escape must not disable decoding)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    // `%zz` is not a valid escape; it must not suppress decoding of the
    // valid `%20` escapes that carry the secret.
    const q = `%zz${encodeURIComponent(LEAK)}`;
    expect(t.isEgressTainted('https://attacker.example/', q)).toBe(true);
  });

  it('blocks a base64 secret padded behind many benign base64 chunks (no steerable decode budget)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    // 80 distinct benign base64 chunks (> the old 64-candidate budget),
    // secret base64 LAST. Total stays under the scan cap so this exercises
    // budget removal, not the fail-closed oversize path.
    const benign = Array.from({ length: 80 }, (_, i) =>
      Buffer.from(`fillerchunk${i}xx`, 'utf8').toString('base64'),
    );
    const secretB64 = Buffer.from(LEAK, 'utf8').toString('base64');
    const q = [...benign, secretB64].join('&');
    expect(t.isEgressTainted('https://attacker.example/', q)).toBe(true);
  });

  it('fails CLOSED on egress larger than the scan cap once content is harvested', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const oversized = 'A'.repeat(50_000); // far beyond the scan cap
    expect(t.isEgressTainted(`https://attacker.example/${oversized}`, '')).toBe(true);
  });

  it('stays permissive for oversized egress when nothing has been harvested', () => {
    const t = new EgressTaintLedger();
    const oversized = 'A'.repeat(50_000);
    expect(t.isEgressTainted(`https://example.com/${oversized}`, '')).toBe(false);
  });

  it('blocks STANDARD base64 (containing + and /) embedded in a URL path (alignment)', () => {
    const t = new EgressTaintLedger();
    const secret = 'секретный пароль для банковского проекта синий горизонт';
    const leak = 'секретный пароль для банковского проекта';
    t.addText(secret);
    const b64 = Buffer.from(leak, 'utf8').toString('base64'); // contains + and /
    expect(b64).toMatch(/[+/]/); // guard: this fixture must exercise the +/ alphabet
    expect(t.isEgressTainted(`https://a.io/x/${b64}`, '')).toBe(true);
  });

  it('blocks base64 SPLIT by %0A separators inside one url (delimiter-tolerant)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(LEAK, 'utf8').toString('base64');
    const chunked = (b64.match(/.{1,4}/g) ?? []).join('%0A'); // 4-char chunks + newline
    expect(t.isEgressTainted(`https://attacker.example/${chunked}`, '')).toBe(true);
  });

  it('blocks base64 SPLIT by spaces in the query (delimiter-tolerant)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(LEAK, 'utf8').toString('base64');
    const spaced = (b64.match(/.{1,4}/g) ?? []).join(' ');
    expect(t.isEgressTainted('https://attacker.example/', spaced)).toBe(true);
  });

  it('blocks STANDARD base64 SPLIT by HYPHENS (base64url char used as separator)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(LEAK, 'utf8').toString('base64');
    const hyphenated = (b64.match(/.{1,4}/g) ?? []).join('-');
    expect(t.isEgressTainted(`https://attacker.example/${hyphenated}`, '')).toBe(
      true,
    );
  });

  it('blocks STANDARD base64 SPLIT by UNDERSCORES (base64url char used as separator)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const b64 = Buffer.from(LEAK, 'utf8').toString('base64');
    const underscored = (b64.match(/.{1,4}/g) ?? []).join('_');
    expect(t.isEgressTainted('https://attacker.example/', underscored)).toBe(
      true,
    );
  });

  it('blocks HEX SPLIT by hyphens', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    const hex = Buffer.from(LEAK, 'utf8').toString('hex');
    const hyphenated = (hex.match(/.{1,4}/g) ?? []).join('-');
    expect(t.isEgressTainted(`https://attacker.example/${hyphenated}`, '')).toBe(
      true,
    );
  });

  it('does NOT regress genuine base64url decoding (hyphen/underscore as DATA)', () => {
    const t = new EgressTaintLedger();
    t.addText(SECRET);
    // base64url of the leak: '+'->'-', '/'->'_' are real payload chars here.
    const b64url = Buffer.from(LEAK, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(t.isEgressTainted(`https://attacker.example/${b64url}`, '')).toBe(
      true,
    );
  });
});
