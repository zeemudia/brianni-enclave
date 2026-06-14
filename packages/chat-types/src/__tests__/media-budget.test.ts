import { describe, expect, it } from 'vitest';
import {
  encodeMediaBudgetRequest,
  decodeMediaBudgetRequest,
  decodeMediaBudgetReserveResult,
  decodeMediaBudgetReconcileResult,
  encodeMediaBudgetReserveResult,
  encodeMediaBudgetReconcileResult,
  MAX_MEDIA_BUDGET_RPC_BYTES,
} from '../media-budget';

describe('media-budget RPC contract', () => {
  it('round-trips a reserve request', () => {
    const req = {
      op: 'reserve' as const,
      userId: 'user_1',
      planId: 'PRO',
      mediaJobId: 'mj_abc',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate' as const,
    };
    const bytes = encodeMediaBudgetRequest(req);
    expect(decodeMediaBudgetRequest(bytes)).toEqual(req);
  });

  it('defaults routeKind to image_generate on a reserve request', () => {
    const bytes = encodeMediaBudgetRequest({
      op: 'reserve',
      userId: 'user_1',
      planId: 'PRO',
      mediaJobId: 'mj_abc',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
    });
    const decoded = decodeMediaBudgetRequest(bytes);
    expect(decoded.op).toBe('reserve');
    if (decoded.op === 'reserve') expect(decoded.routeKind).toBe('image_generate');
  });

  it('round-trips a reconcile request (debited with actual units)', () => {
    const req = {
      op: 'reconcile' as const,
      userId: 'user_1',
      holdId: 'hold_1',
      status: 'debited' as const,
      actualQuotaUnits: 4,
      billingReceiptId: 'rcpt_1',
    };
    const bytes = encodeMediaBudgetRequest(req);
    expect(decodeMediaBudgetRequest(bytes)).toEqual(req);
  });

  it('round-trips a reconcile request (released, no actual units)', () => {
    const req = {
      op: 'reconcile' as const,
      userId: 'user_1',
      holdId: 'hold_1',
      status: 'released' as const,
    };
    const bytes = encodeMediaBudgetRequest(req);
    expect(decodeMediaBudgetRequest(bytes)).toEqual(req);
  });

  it('rejects an unknown op', () => {
    expect(() =>
      decodeMediaBudgetRequest(Buffer.from(JSON.stringify({ op: 'nope' }))),
    ).toThrow();
  });

  it('rejects extra/unknown keys (strict)', () => {
    expect(() =>
      encodeMediaBudgetRequest({
        op: 'reserve',
        userId: 'user_1',
        planId: 'PRO',
        mediaJobId: 'mj_abc',
        quotaUnits: 4,
        providerId: 'openai',
        modelId: 'gpt-image-2',
        prompt: 'leak me',
      } as never),
    ).toThrow();
  });

  it('enforces the size cap on decode', () => {
    const huge = Buffer.alloc(MAX_MEDIA_BUDGET_RPC_BYTES + 1, 0x20);
    expect(() => decodeMediaBudgetRequest(huge)).toThrow(/too large/i);
  });

  it('round-trips reserve results (ok + failure)', () => {
    expect(
      decodeMediaBudgetReserveResult(
        encodeMediaBudgetReserveResult({ ok: true, holdId: 'hold_9' }),
      ),
    ).toEqual({ ok: true, holdId: 'hold_9' });
    expect(
      decodeMediaBudgetReserveResult(
        encodeMediaBudgetReserveResult({ ok: false, reason: 'USER_BUDGET_EXCEEDED' }),
      ),
    ).toEqual({ ok: false, reason: 'USER_BUDGET_EXCEEDED' });
  });

  it('round-trips reconcile results (ok + failure)', () => {
    expect(
      decodeMediaBudgetReconcileResult(
        encodeMediaBudgetReconcileResult({ ok: true }),
      ),
    ).toEqual({ ok: true });
    expect(
      decodeMediaBudgetReconcileResult(
        encodeMediaBudgetReconcileResult({ ok: false, reason: 'HOLD_NOT_FOUND' }),
      ),
    ).toEqual({ ok: false, reason: 'HOLD_NOT_FOUND' });
  });
});
