// Broker failure logging

import { logBrokerFailure } from '../repository/brokerRepository';

export async function logFailure(entry: {
  userId?: number;
  broker?: string;
  operation: string;
  errorCode?: string;
  errorMessage: string;
  retryCount?: number;
  request?: Record<string, unknown>;
}): Promise<void> {
  console.error(
    `[BROKER_FAILURE] op=${entry.operation} broker=${entry.broker ?? '—'} ` +
    `code=${entry.errorCode ?? '—'} msg=${entry.errorMessage}`,
  );
  await logBrokerFailure(entry);
}
