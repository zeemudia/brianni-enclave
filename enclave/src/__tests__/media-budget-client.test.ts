import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../media-quota-client.js', () => ({
  reserveMediaBudget: vi.fn(),
  reconcileMediaBudget: vi.fn(),
}));

import {
  reserveMediaBudget,
  reconcileMediaBudget,
} from '../media-quota-client.js';
import { createMediaBudgetClient } from '../media-budget-client.js';

describe('createMediaBudgetClient', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('threads the request userId + planId into the broker reserve RPC', async () => {
    vi.mocked(reserveMediaBudget).mockResolvedValueOnce({ ok: true, holdId: 'h1' });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    const result = await client.reserve({
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result).toEqual({ ok: true, holdId: 'h1' });
    expect(reserveMediaBudget).toHaveBeenCalledWith({
      op: 'reserve',
      userId: 'user_7',
      planId: 'PRO',
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
  });

  it('forwards the caller-supplied routeKind so video reserves get video caps, not image caps', async () => {
    vi.mocked(reserveMediaBudget).mockResolvedValueOnce({ ok: true, holdId: 'hv' });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    await client.reserve({
      mediaJobId: 'mj_v',
      quotaUnits: 4200,
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      routeKind: 'video_generate',
    });
    expect(reserveMediaBudget).toHaveBeenCalledWith(
      expect.objectContaining({ routeKind: 'video_generate' }),
    );
  });

  it('propagates a broker over-quota failure (fail closed)', async () => {
    vi.mocked(reserveMediaBudget).mockResolvedValueOnce({
      ok: false,
      reason: 'USER_BUDGET_EXCEEDED',
    });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    const result = await client.reserve({
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result).toEqual({ ok: false, reason: 'USER_BUDGET_EXCEEDED' });
  });

  it('fails closed WITHOUT a broker call when there is no authenticated userId', async () => {
    const client = createMediaBudgetClient({ userId: '', planId: 'PRO' });
    const result = await client.reserve({
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result.ok).toBe(false);
    expect(reserveMediaBudget).not.toHaveBeenCalled();
  });

  it('threads reconcile status + actual units into the broker reconcile RPC', async () => {
    vi.mocked(reconcileMediaBudget).mockResolvedValueOnce({ ok: true });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    await client.reconcile({
      holdId: 'h1',
      status: 'debited',
      actualQuotaUnits: 4,
      billingReceiptId: 'rcpt_1',
    });
    expect(reconcileMediaBudget).toHaveBeenCalledWith({
      op: 'reconcile',
      userId: 'user_7',
      holdId: 'h1',
      status: 'debited',
      actualQuotaUnits: 4,
      billingReceiptId: 'rcpt_1',
    });
  });

  it('reconcile (released) omits actualQuotaUnits/billingReceiptId', async () => {
    vi.mocked(reconcileMediaBudget).mockResolvedValueOnce({ ok: true });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    await client.reconcile({ holdId: 'h1', status: 'released' });
    expect(reconcileMediaBudget).toHaveBeenCalledWith({
      op: 'reconcile',
      userId: 'user_7',
      holdId: 'h1',
      status: 'released',
    });
  });

  it('reconcile is best-effort: a broker failure does not throw', async () => {
    vi.mocked(reconcileMediaBudget).mockResolvedValueOnce({
      ok: false,
      reason: 'MEDIA_QUOTA_BROKER_UNREACHABLE',
    });
    const client = createMediaBudgetClient({ userId: 'user_7', planId: 'PRO' });
    await expect(
      client.reconcile({ holdId: 'h1', status: 'debited', actualQuotaUnits: 4 }),
    ).resolves.toBeUndefined();
  });
});
