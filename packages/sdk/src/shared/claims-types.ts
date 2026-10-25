// Claim shapes as served by /api/claims and /api/admin/claims (JSON form) — mirrors app/src/points/claims.ts.
export type ClaimKind = 'market' | 'limit'
export type ClaimStatus = 'open' | 'filled' | 'cancelled' | 'expired'
export interface ClaimJson { id: string; wallet: string; kind: ClaimKind; amountSol: number; maxPriceUsd: number | null; filledSol: number; potMicro: string; status: ClaimStatus; createdAt: string; expiresAt: string | null }
