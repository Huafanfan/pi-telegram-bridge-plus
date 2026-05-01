import { isAllowed, isOwnerUser, type AccessPolicy, type ChatLike } from './telegram-routing.js';

export type RuntimeAccessPolicy = AccessPolicy & {
  runtimeAllowedUserIds: Set<number>;
};

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'not_allowed'; canRequestPairing: boolean; message: string };

export function isRuntimeAllowed(policy: RuntimeAccessPolicy, chat: ChatLike | undefined, userId?: number): boolean {
  if (typeof userId === 'number' && policy.runtimeAllowedUserIds.has(userId)) return true;
  return isAllowed(policy, chat, userId);
}

export function isRuntimeOwner(policy: RuntimeAccessPolicy, userId?: number): boolean {
  return isOwnerUser(policy, userId);
}

export function accessDecision(policy: RuntimeAccessPolicy, chat: ChatLike | undefined, userId: number | undefined, pairingEnabled: boolean): AccessDecision {
  if (isRuntimeAllowed(policy, chat, userId)) return { allowed: true };
  const pairingHint = pairingEnabled ? ' Send /pair to request access.' : '';
  return {
    allowed: false,
    reason: 'not_allowed',
    canRequestPairing: pairingEnabled,
    message: `This chat/user is not allowed to control this bridge.${pairingHint}`,
  };
}
