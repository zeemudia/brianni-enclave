import type {
  ToolCallLedgerEntry,
  ToolResultFrame,
  ToolResultOutcome,
} from '@calypso/chat-types';

import type { DispatchResult } from './index';

type BaseLedger = Omit<
  ToolCallLedgerEntry,
  'id' | 'outcome' | 'reason' | 'scope' | 'approvedPath'
>;

const BRIDGE_REASON_MAX_CHARS = 64;

const BRIDGE_REASON_BY_OUTCOME: Record<
  Exclude<ToolResultOutcome, 'ok'>,
  string
> = {
  denied_by_user: 'BRIDGE_DENIED',
  gateway_rejected: 'BRIDGE_REJECTED',
  error: 'BRIDGE_ERROR',
};

const BRIDGE_TIMEOUT_RE = /\b(timeout|timed out|aborted)\b/i;

export function sanitiseBridgeReason(result: {
  outcome: unknown;
  reason?: string;
}): string | undefined {
  const outcome = normaliseBridgeOutcome(result.outcome);
  if (outcome === 'ok') return undefined;
  const reason =
    result.outcome === 'error' && BRIDGE_TIMEOUT_RE.test(result.reason ?? '')
      ? 'BRIDGE_TIMEOUT'
      : BRIDGE_REASON_BY_OUTCOME[outcome];
  return reason.slice(0, BRIDGE_REASON_MAX_CHARS);
}

function normaliseBridgeOutcome(outcome: unknown): ToolResultOutcome {
  switch (outcome) {
    case 'ok':
    case 'denied_by_user':
    case 'gateway_rejected':
    case 'error':
      return outcome;
    default:
      return 'error';
  }
}

export function sanitiseBridgeResultForDispatch(
  result: ToolResultFrame,
  baseLedger: BaseLedger,
  scope: string,
  approvedPath: string | null,
  okResultJson?: unknown,
): DispatchResult {
  if (result.outcome !== 'ok') {
    const outcome = normaliseBridgeOutcome(result.outcome);
    const reason = sanitiseBridgeReason(result);
    return {
      invocationId: result.invocationId,
      outcome,
      reason,
      ledgerEntry: {
        ...baseLedger,
        scope,
        approvedPath,
        outcome,
        reason: reason ?? null,
      },
    };
  }

  return {
    invocationId: result.invocationId,
    outcome: 'ok',
    ...(okResultJson === undefined ? {} : { resultJson: okResultJson }),
    ledgerEntry: {
      ...baseLedger,
      scope,
      approvedPath,
      outcome: 'ok',
      reason: null,
    },
  };
}
