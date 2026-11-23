import {
  addToPendingQueue,
  clearPendingQueue,
  getPendingQueue,
  registerBackgroundSyncWorker as registerPrimaryBackgroundSyncWorker,
  removeFromPendingQueue,
} from './offlineQueue';

export function registerBackgroundSyncWorker(onTriggerSync?: () => void) {
  return registerPrimaryBackgroundSyncWorker(onTriggerSync);
}

export interface QueuedOperation {
  id: string;
  type: 'ADD_SALE' | 'UPDATE_SALE' | 'DELETE_SALE' | 'ADD_PAYMENT' | 'DELETE_PAYMENT' | 'UPDATE_INVENTORY' | 'UPDATE_LIST';
  collectionName: string;
  payload: any;
  timestamp: number;
  attempts: number;
}

export async function enqueueOfflineOp(op: Omit<QueuedOperation, 'id' | 'timestamp' | 'attempts'>) {
  const typeMap: Record<string, string> = {
    ADD_SALE: 'CREATE_CONTRACT',
    UPDATE_SALE: 'UPDATE_CONTRACT',
    DELETE_SALE: 'DELETE_CONTRACT',
    ADD_PAYMENT: 'CREATE_PAYMENT',
    DELETE_PAYMENT: 'DELETE_PAYMENT',
    UPDATE_INVENTORY: 'UPDATE_INVENTORY',
    UPDATE_LIST: 'UPDATE_CUSTOMER_LIST',
  };
  const mappedType = typeMap[op.type] || op.type;
  const action = await addToPendingQueue(mappedType, op.payload);
  return action?.id || null;
}

export async function getPendingOfflineOps(): Promise<QueuedOperation[]> {
  const queue = await getPendingQueue();
  return queue.map((item) => ({
    id: item.id,
    type: item.type as QueuedOperation['type'],
    collectionName: item.type,
    payload: item.payload,
    timestamp: item.timestamp,
    attempts: item.retryCount || 0,
  }));
}

export async function removeOfflineOp(id: string) {
  await removeFromPendingQueue(id);
}

export async function clearAllOfflineOps() {
  await clearPendingQueue();
}
