import type {
  ConnectedConnectorContext,
  ConnectorDescriptor,
  ConnectorOperation,
} from '@calypso/chat-types';

import type {
  RuntimeConnectorOperationView,
  RuntimeConnectorView,
} from './prompt';
import { getConnector } from '../connectors/registry';

export function buildRuntimeConnectorView(input: {
  connectedConnectors: readonly ConnectedConnectorContext[];
  scopeToConnectorId?: string;
}): RuntimeConnectorView[] {
  const view: RuntimeConnectorView[] = [];
  for (const connector of input.connectedConnectors) {
    if (
      input.scopeToConnectorId !== undefined &&
      connector.connectorId !== input.scopeToConnectorId
    ) {
      continue;
    }
    if (connector.status !== 'connected') continue;

    const descriptor = getConnector(connector.connectorId);
    if (!descriptor) continue;

    const operations: RuntimeConnectorOperationView[] = descriptor.operations
      .filter((operation) => operation.binary !== true)
      .filter((operation) =>
        connectorOperationScopeSatisfied(
          descriptor,
          operation,
          connector.grantedScopes,
        ),
      )
      .map((operation) => {
        const item: RuntimeConnectorOperationView = {
          id: operation.id,
          mutating: operation.mutating,
          paramsSchema: operation.paramsSchema,
        };
        if (operation.contentFields !== undefined) {
          item.contentFields = operation.contentFields;
        }
        if (operation.maxWindowDays !== undefined) {
          item.maxWindowDays = operation.maxWindowDays;
        }
        if (operation.maxResults !== undefined) {
          item.maxResults = operation.maxResults;
        }
        if (operation.windowParams !== undefined) {
          item.windowParams = operation.windowParams;
        }
        if (operation.maxResultsParam !== undefined) {
          item.maxResultsParam = operation.maxResultsParam;
        }
        return item;
      });

    view.push({
      connectorId: connector.connectorId,
      displayName: connector.displayName,
      operations,
    });
  }
  return view;
}

export function connectorOperationScopeSatisfied(
  descriptor: ConnectorDescriptor,
  operation: ConnectorOperation,
  grantedScopes: readonly string[],
): boolean {
  const requiredScopes = Array.isArray(operation.requiredScope)
    ? operation.requiredScope
    : [operation.requiredScope];
  return requiredScopes.some((requiredScope) =>
    grantedScopes.some((grantedScope) =>
      grantCoversRequiredScope(descriptor, grantedScope, requiredScope),
    ),
  );
}

function grantCoversRequiredScope(
  descriptor: ConnectorDescriptor,
  grantedScope: string,
  requiredScope: string,
): boolean {
  if (scopeTokenMatches(grantedScope, requiredScope)) return true;
  return (
    descriptor.scopeSubsumes?.some(
      (rule) =>
        scopeTokenMatches(grantedScope, rule.grant) &&
        rule.covers.some((coveredScope) =>
          scopeTokenMatches(coveredScope, requiredScope),
        ),
    ) ?? false
  );
}

function scopeTokenMatches(left: string, right: string): boolean {
  return (
    left === right ||
    left.endsWith(`/${right}`) ||
    right.endsWith(`/${left}`)
  );
}
