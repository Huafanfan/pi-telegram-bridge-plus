import crypto from 'node:crypto';

export type PairingRecord = {
  code: string;
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  createdAt: number;
  expiresAt: number;
};

export type PairingStore = {
  allowedUserIds: number[];
  pending: PairingRecord[];
};

export function normalizePairingStore(value: unknown): PairingStore {
  if (!value || typeof value !== 'object') return { allowedUserIds: [], pending: [] };
  const input = value as Partial<PairingStore>;
  return {
    allowedUserIds: Array.isArray(input.allowedUserIds) ? input.allowedUserIds.filter((id) => Number.isFinite(id)) : [],
    pending: Array.isArray(input.pending)
      ? input.pending.filter((item) => item && typeof item.code === 'string' && Number.isFinite(item.userId) && Number.isFinite(item.chatId) && Number.isFinite(item.expiresAt))
      : [],
  };
}

export function prunePairingRecords(records: Iterable<PairingRecord>, now = Date.now()): PairingRecord[] {
  return [...records].filter((record) => record.expiresAt > now);
}

export function createPairingCode(existingCodes: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!existingCodes.has(code)) return code;
  }
  throw new Error('Could not generate unique pairing code');
}

export function approvePairingRecord(store: PairingStore, record: PairingRecord): PairingStore {
  const allowed = new Set(store.allowedUserIds);
  allowed.add(record.userId);
  return {
    allowedUserIds: [...allowed].sort((a, b) => a - b),
    pending: store.pending.filter((item) => item.code !== record.code && item.userId !== record.userId),
  };
}

export function revokePairingUser(store: PairingStore, userId: number): { store: PairingStore; revoked: boolean } {
  const before = store.allowedUserIds.length;
  const allowedUserIds = store.allowedUserIds.filter((id) => id !== userId);
  return { store: { ...store, allowedUserIds }, revoked: allowedUserIds.length !== before };
}
