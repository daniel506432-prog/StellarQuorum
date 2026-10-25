export type ProposalStatus =
  | 'Pending' | 'Active' | 'Passed' | 'Failed'
  | 'Queued'  | 'Executed' | 'Cancelled';

export type VoteSupport = 0 | 1 | 2; // 0=Against 1=For 2=Abstain

export interface Proposal {
  id: bigint;
  proposer: string;
  title: string;
  description: string;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  snapshotLedger: number;
  startLedger: number;
  endLedger: number;
  queueLedger: number;
  quorumRequired: bigint;
  status: ProposalStatus;
}

export interface GovernanceConfig {
  token: string;
  quorumBps: number;
  votingPeriod: number;
  timelockPeriod: number;
  proposalThreshold: bigint;
  admin: string;
}

export interface QuorumClientConfig {
  /** A single endpoint (legacy) or an ordered failover list. */
  rpcUrl: string | string[];
  /** Alias for rpcUrl when multiple providers are configured. */
  rpcUrls?: string[];
  networkPassphrase: string;
  governanceContractId: string;
  tokenContractId?: string;
  requestTimeoutMs?: number;
  readRetryAttempts?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
  pollIntervalMs?: number;
  confirmationTimeoutMs?: number;
  /** Read caching is off unless cache.enabled is true. TTLs are milliseconds. */
  cache?: ReadCacheConfig;
  /** Opt in to JSON-RPC batch simulations for concurrent proposal reads. */
  batchSimulation?: boolean;
  /** Transactions per batch, 1..100 (default 50). */
  simulationBatchSize?: number;
}

export type ReadMethod =
  | 'getProposal' | 'getProposalCount' | 'getConfig' | 'getVote'
  | 'getLatestLedger' | 'getVotingPower' | 'getBalance' | 'getTokenDecimals'
  | 'balance' | 'getPastBalance' | 'allowance' | 'totalSupply';

export interface ReadCacheConfig {
  enabled: boolean;
  /** Default 5 seconds; zero disables caching for a method. */
  ttlMs?: number;
  methodTtlMs?: Partial<Record<ReadMethod, number>>;
  /** Maximum entries retained per client, default 1000. */
  maxEntries?: number;
}

export interface ReadOptions {
  /** Fetch fresh data without reading or populating the cache. */
  bypassCache?: boolean;
  /** Evict this method + arguments before fetching and caching fresh data. */
  invalidateCache?: boolean;
}

export interface TransactionConfirmationOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Polling options for `waitForProposalStatus` (issue #274). */
export interface WaitForStatusOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * Fee breakdown for a built transaction, in stroops (issue #277).
 *
 * `totalFee` is what the network charges if the transaction is submitted at
 * current pricing: show it before the signing prompt.
 */
export interface FeeEstimate {
  /** Classic inclusion fee, excluding any Soroban resource fee. */
  inclusionFee: bigint;
  /** Soroban resource fee for the simulated footprint at current pricing. */
  resourceFee: bigint;
  /** `inclusionFee + resourceFee`. */
  totalFee: bigint;
}

export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Pagination window for proposal listing (issue #118).
 *
 * `offset` is the number of oldest proposals to skip (0-based), `limit` is
 * the maximum number of proposals to return. When omitted, callers that pass
 * no options get the historical behaviour (all proposals).
 */
export interface GetProposalsOptions extends ReadOptions {
  limit?: number;
  offset?: number;
}
