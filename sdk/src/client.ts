import { rpc, Contract, Transaction, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, Address, Account, xdr } from '@stellar/stellar-sdk';
import type { Proposal, GovernanceConfig, QuorumClientConfig, VoteSupport, GetProposalsOptions, ProposalStatus, TransactionConfirmationOptions, WaitForStatusOptions, FeeEstimate, ReadMethod, ReadOptions } from './types.js';
import { ReadCache } from './cache.js';
import { SimulationBatcher, postSimulationBatch } from './batch.js';
import { GovernanceError, parseGovernanceError, RpcTimeoutError, TransactionFailedError, contractErrorCode } from './errors.js';

/**
 * Source account used for read-only simulation.
 *
 * Simulating a contract call still requires a source account to build the
 * transaction, but a simulation is never signed or submitted, so the all-zero
 * ed25519 account works and means reads need no funded account.
 */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Whether a plain-HTTP RPC URL may be used.
 *
 * The stellar-sdk refuses insecure URLs unless `allowHttp` is set; allow
 * them only for loopback hosts (local nodes, the test mock RPC) so every
 * remote endpoint keeps the SDK's HTTPS requirement.
 */
function allowsInsecureRpc(rpcUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Default page size for paginated proposal listing (issue #118).
 *
 * Matches the recommendation in `docs/proposal-list-performance.md`: 50 cards
 * is one screenful, ~200 KiB per page at 4 KiB/proposal stays under public
 * RPC response caps, with diminishing returns above 50.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_READ_RETRY_ATTEMPTS = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;
export const DEFAULT_RETRY_JITTER_MS = 50;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;

// ─── Typed governance errors (issue #115) ────────────────────────────────────
// The contract surfaces failures as `GovernanceError` codes; a simulation
// failure string looks like `... Error(Contract, #12) ...`. These map the
// timelock / status paths to typed errors so callers can branch on them
// instead of parsing strings.

export class ProposalNotFoundError extends Error {
  constructor(proposalId?: bigint | string) {
    super(`Proposal not found${proposalId !== undefined ? `: ${String(proposalId)}` : ''}`);
    this.name = 'ProposalNotFoundError';
  }
}

export class VotingNotActiveError extends Error {
  constructor(message = 'Voting window is still open; proposal cannot be finalized yet') {
    super(message);
    this.name = 'VotingNotActiveError';
  }
}

export class ProposalNotPassedError extends Error {
  constructor(message = 'Proposal is not queued and cannot be executed') {
    super(message);
    this.name = 'ProposalNotPassedError';
  }
}

export class TimelockNotExpiredError extends Error {
  constructor(message = 'Timelock has not expired; proposal cannot be executed yet') {
    super(message);
    this.name = 'TimelockNotExpiredError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Caller is not authorized for this action') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * `waitForProposalStatus` stopped polling before the proposal reached the
 * target status (issue #274). `lastStatus` is the status seen on the final poll.
 */
export class ProposalStatusTimeoutError extends Error {
  readonly proposalId: bigint;
  readonly targetStatus: ProposalStatus;
  readonly lastStatus: ProposalStatus;

  constructor(proposalId: bigint, targetStatus: ProposalStatus, lastStatus: ProposalStatus, timeoutMs: number) {
    super(`Proposal ${String(proposalId)} did not reach ${targetStatus} within ${timeoutMs}ms (last status: ${lastStatus})`);
    this.name = 'ProposalStatusTimeoutError';
    this.proposalId = proposalId;
    this.targetStatus = targetStatus;
    this.lastStatus = lastStatus;
  }
}

function mapGovernanceSimulationError(method: string, raw: unknown): Error {
  const message = raw instanceof Error ? raw.message : String(raw);
  if (/#\s*3\b/.test(message) || /ProposalNotFound/.test(message)) {
    return new ProposalNotFoundError();
  }
  if (/#\s*4\b/.test(message) || /VotingNotActive/.test(message)) {
    return new VotingNotActiveError(`Simulation of ${method} failed: voting is not active (${message})`);
  }
  if (/#\s*7\b/.test(message) || /ProposalNotPassed/.test(message)) {
    return new ProposalNotPassedError(`Simulation of ${method} failed: proposal has not passed (${message})`);
  }
  if (/#\s*12\b/.test(message) || /TimelockNotExpired/.test(message)) {
    return new TimelockNotExpiredError(`Simulation of ${method} failed: timelock not expired (${message})`);
  }
  if (/#\s*2\b/.test(message) || /Unauthorized/.test(message)) {
    return new UnauthorizedError(`Simulation of ${method} failed: unauthorized (${message})`);
  }
  return new Error(`Simulation of ${method} failed: ${message}`);
}

export class QuorumClient {
  private server: rpc.Server;
  private readonly servers: rpc.Server[];
  private serverIndex = 0;
  private governance: Contract;
  private token: Contract | null;
  private config: QuorumClientConfig;
  private readonly cache: ReadCache;
  private readonly batcher?: SimulationBatcher;

  constructor(config: QuorumClientConfig) {
    this.config = config;
    this.cache = new ReadCache(config.cache);
    if (config.batchSimulation) {
      this.batcher = new SimulationBatcher(
        transactions => this.read('batch simulate', () => postSimulationBatch(
          (config.rpcUrls?.[0] ?? (Array.isArray(config.rpcUrl) ? config.rpcUrl[0] : config.rpcUrl)), transactions, config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        )),
        config.simulationBatchSize ?? DEFAULT_PAGE_SIZE,
      );
    }
    const configuredUrls = config.rpcUrls ?? (Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl]);
    if (configuredUrls.length === 0) throw new Error('At least one RPC URL is required');
    this.servers = configuredUrls.map(url => new rpc.Server(url, {
      allowHttp: allowsInsecureRpc(url),
      timeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }));
    this.server = this.servers[0];
    this.governance = new Contract(config.governanceContractId);
    // tokenContractId is required by the config type but older callers
    // (e.g. bench RPC mode) only pass a governance id — stay usable and fail
    // with a clear message only when a token method is actually used.
    this.token = config.tokenContractId ? new Contract(config.tokenContractId) : null;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /** Evict all reads, one method, or one method + arguments. */
  invalidateCache(method?: ReadMethod, ...args: unknown[]): void {
    this.cache.invalidate(method, args.length ? args : undefined);
  }

  /** A proposal by id, or `null` if the contract reports ProposalNotFound. */
  async getProposal(id: bigint, options?: ReadOptions): Promise<Proposal | null> {
    return this.cache.read('getProposal', [id], options, async () => {
      try {
        const raw = await this.simulate<RawProposal>('get_proposal', nativeToScVal(id, { type: 'u64' }));
        return decodeProposal(raw);
      } catch (error) {
        if (parseGovernanceError(error) === GovernanceError.ProposalNotFound) return null;
        throw error;
      }
    });
  }

  async getProposalCount(options?: ReadOptions): Promise<bigint> {
    return this.cache.read('getProposalCount', [], options, async () =>
      BigInt(await this.simulate<bigint | number>('get_proposal_count')));
  }

  async getLatestLedger(options?: ReadOptions): Promise<number> {
    return this.cache.read('getLatestLedger', [], options, async () =>
      (await this.read('getLatestLedger', () => this.server.getLatestLedger())).sequence);
  }

  async getVotingPower(voter: string, snapshotLedger: number, options?: ReadOptions): Promise<bigint> {
    return this.cache.read('getVotingPower', [voter, snapshotLedger], options, async () => {
      const token = await this.tokenContract(options);
      return BigInt(await this.simulateOn<bigint | number>(token, 'get_past_votes', new Address(voter).toScVal(), nativeToScVal(snapshotLedger, { type: 'u32' })));
    });
  }

  /** Current representative, including delegations made directly on the token. */
  async getDelegate(holder: string): Promise<string> {
    return this.simulate<string>('get_delegate', new Address(holder).toScVal());
  }

  async getBalance(voter: string, options?: ReadOptions): Promise<bigint> {
    return this.cache.read('getBalance', [voter], options, async () => {
      const token = await this.tokenContract(options);
      return BigInt(await this.simulateOn<bigint | number>(token, 'balance', new Address(voter).toScVal()));
    });
  }

  async getTokenDecimals(options?: ReadOptions): Promise<number> {
    return this.cache.read('getTokenDecimals', [], options, async () => {
      const token = await this.tokenContract(options);
      return this.simulateOn<number>(token, 'decimals');
    });
  }

  async getConfig(options?: ReadOptions): Promise<GovernanceConfig> {
    return this.cache.read('getConfig', [], options, async () => {
      const raw = await this.simulate<RawConfig>('get_config');
      return {
        token: raw.token,
        quorumBps: raw.quorum_bps,
        votingPeriod: raw.voting_period,
        timelockPeriod: raw.timelock_period,
        proposalThreshold: raw.proposal_threshold,
        admin: raw.admin,
      };
    });
  }

  async hasVoted(proposalId: bigint, voter: string, options?: ReadOptions): Promise<boolean> {
    // has_voted and get_vote read the same storage entry, so one round trip
    // answers both questions.
    return (await this.getVote(proposalId, voter, options)) !== null;
  }

  /**
   * The choice a voter recorded on a proposal, or `null` if they have not
   * voted.
   *
   * @param proposalId Proposal to look up.
   * @param voter Stellar address of the voter.
   * @returns `0` Against, `1` For, `2` Abstain, or `null`.
   */
  async getVote(proposalId: bigint, voter: string, options?: ReadOptions): Promise<VoteSupport | null> {
    return this.cache.read('getVote', [proposalId, voter], options, async () => {
      const support = await this.simulate<number | null | undefined>(
        'get_vote',
        nativeToScVal(proposalId, { type: 'u64' }),
        new Address(voter).toScVal(),
      );
      // The contract returns Option<u32>; None decodes to null/undefined.
      return support === null || support === undefined ? null : (support as VoteSupport);
    });
  }

  async getProposalsByStatus(status: Proposal['status'], options?: GetProposalsOptions): Promise<Proposal[]> {
    // Filtering happens after pagination, so callers needing a complete
    // filtered set should omit pagination (fetch all, then filter).
    const all = await this.getAllProposals(options);
    return all.filter(p => p.status === status);
  }

  /**
   * Paginated proposal listing (issue #118).
   *
   * Fetches only the requested window instead of the whole list, so a list
   * screen rendering one page costs `1 + min(limit, remaining)` RPC calls
   * rather than `1 + N`. Defaults to the first `DEFAULT_PAGE_SIZE` proposals.
   *
   * Once the contract exposes a single-call paginated read
   * (`get_proposals(start, count)` or equivalent), this is the method that
   * should switch to it so listing N proposals costs `O(N / page)` calls;
   * until then it fans out one `getProposal()` per id *within the window*.
   *
   * @param options.limit max proposals to return (default {@link DEFAULT_PAGE_SIZE}).
   * @param options.offset number of oldest proposals to skip (default 0).
   */
  async getProposals(options?: GetProposalsOptions): Promise<Proposal[]> {
    const limit = options?.limit ?? DEFAULT_PAGE_SIZE;
    const offset = options?.offset ?? 0;
    return this.fetchProposalWindow(offset, limit, options);
  }

  /**
   * All proposals, or a single window when `limit`/`offset` are given
   * (issue #118).
   *
   * Without options this keeps the historical behaviour (fetch everything).
   * Pass `{ limit, offset }` to fetch one page: proposal ids are 1-based, so
   * `offset: 0, limit: 50` returns ids 1..50.
   */
  async getAllProposals(options?: GetProposalsOptions): Promise<Proposal[]> {
    return this.fetchProposalWindow(options?.offset ?? 0, options?.limit, options);
  }

  private async fetchProposalWindow(offset: number, limit: number | undefined, options?: ReadOptions): Promise<Proposal[]> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`Invalid offset ${String(offset)}: must be a non-negative integer`);
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error(`Invalid limit ${String(limit)}: must be a non-negative integer`);
    }
    if (limit === 0) {
      return [];
    }
    const count = await this.getProposalCount(options);
    const total = Number(count);
    if (offset >= total) {
      return [];
    }
    const end = limit === undefined ? total : Math.min(total, offset + limit);
    const ids: bigint[] = [];
    // Proposal ids are 1-based; offset 0 → id 1.
    for (let id = offset + 1; id <= end; id += 1) {
      ids.push(BigInt(id));
    }
    const proposals = await Promise.all(ids.map(id => this.getProposal(id, options)));
    return proposals.filter(Boolean) as Proposal[];
  }

  // ─── Token reads (issue #117) ────────────────────────────────────────────
  // All reads go through the same `simulateTransaction` path as governance
  // reads — nothing is signed or submitted, so they cost no fee.

  private requireToken(): Contract {
    if (!this.token) {
      throw new Error('tokenContractId is not configured; cannot call token methods');
    }
    return this.token;
  }

  /**
   * Live QUORUM balance of `owner`.
   */
  async balance(owner: string, options?: ReadOptions): Promise<bigint> {
    return this.cache.read('balance', [owner], options, () => this.simulateToken<bigint>(
      'balance',
      new Address(owner).toScVal(),
    ));
  }

  /**
   * Raw balance of `owner` as of the end of `ledger`, excluding delegation.
   * Use `getVotingPower` for the effective weight at a proposal snapshot.
   */
  async getPastBalance(owner: string, ledger: number, options?: ReadOptions): Promise<bigint> {
    return this.cache.read('getPastBalance', [owner, ledger], options, () => this.simulateToken<bigint>(
      'get_past_balance',
      new Address(owner).toScVal(),
      nativeToScVal(ledger, { type: 'u32' }),
    ));
  }

  /**
   * Amount `spender` may still draw from `owner` (0 once expired).
   */
  async allowance(owner: string, spender: string, options?: ReadOptions): Promise<bigint> {
    return this.cache.read('allowance', [owner, spender], options, () => this.simulateToken<bigint>(
      'allowance',
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
    ));
  }

  /**
   * Total QUORUM supply.
   */
  async totalSupply(options?: ReadOptions): Promise<bigint> {
    return this.cache.read('totalSupply', [], options, () => this.simulateToken<bigint>('total_supply'));
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * The token contract, resolved on first use.
   *
   * `tokenContractId` is the deployment-time hint. When it is absent the
   * governance config is the authority, so a caller that only knows the
   * governance contract still gets correct balances.
   */
  private async tokenContract(options?: ReadOptions): Promise<Contract> {
    if (this.config.tokenContractId) {
      return new Contract(this.config.tokenContractId);
    }
    const { token } = await this.getConfig(options);
    return new Contract(token);
  }

  /**
   * Calls a read-only contract method through `simulateTransaction` and decodes
   * the return value.
   *
   * Nothing is signed or submitted, so this costs no fee and needs no funded
   * account.
   */
  private async simulate<T>(method: string, ...args: xdr.ScVal[]): Promise<T> {
    return this.simulateOn<T>(this.governance, method, ...args);
  }

  private async simulateToken<T>(method: string, ...args: xdr.ScVal[]): Promise<T> {
    return this.simulateOn<T>(this.requireToken(), method, ...args);
  }

  private async simulateOn<T>(contract: Contract, method: string, ...args: xdr.ScVal[]): Promise<T> {
    return this.simulateWith<T>(contract, method, ...args);
  }

  private async simulateWith<T>(contract: Contract, method: string, ...args: xdr.ScVal[]): Promise<T> {
    const source = new Account(READ_ONLY_SOURCE, '0');
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const request = async (): Promise<T> => {
      const simulation = await this.read(`simulate:${method}`, () => this.server.simulateTransaction(tx));
      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation of ${method} failed: ${simulation.error}`);
      }
      if (!simulation.result) {
        throw new Error(`Simulation of ${method} returned no result`);
      }
      return scValToNative(simulation.result.retval) as T;
    };
    if (this.batcher && contract === this.governance && method === 'get_proposal') {
      return this.batcher.enqueue(tx.toXDR(), request);
    }
    return request();
  }

  private async read<T>(operation: string, request: () => Promise<T>): Promise<T> {
    const attempts = (this.config.readRetryAttempts ?? DEFAULT_READ_RETRY_ATTEMPTS) + 1;
    let lastError: unknown;
    for (let endpoint = 0; endpoint < this.servers.length; endpoint += 1) {
      this.server = this.servers[(this.serverIndex + endpoint) % this.servers.length];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const result = await this.withTimeout(operation, request());
          this.serverIndex = (this.serverIndex + endpoint) % this.servers.length;
          return result;
        } catch (error) {
          lastError = isTimeoutError(error)
            ? new RpcTimeoutError(operation, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
            : error;
          if (!isTransientRpcError(error) || attempt === attempts - 1) break;
          const base = this.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
          const jitter = this.config.retryJitterMs ?? DEFAULT_RETRY_JITTER_MS;
          await delay(base * 2 ** attempt + Math.floor(Math.random() * (jitter + 1))); // nosemgrep
        }
      }
    }
    throw lastError;
  }
  private async withTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RpcTimeoutError(operation, timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Submit already-signed XDR once, then poll until the network confirms it. */
  async submitAndWait(signedXdr: string, options?: TransactionConfirmationOptions): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const transaction = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
    const submitted = await this.withTimeout('sendTransaction', this.server.sendTransaction(transaction));
    if (submitted.status === 'ERROR') {
      const message = formatTransactionFailure(submitted);
      throw new TransactionFailedError(submitted.hash, message, contractErrorCode(message));
    }

    const pollIntervalMs = options?.pollIntervalMs ?? this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.config.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.read('getTransaction', () => this.server.getTransaction(submitted.hash));
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return result;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        const message = formatTransactionFailure(result);
        throw new TransactionFailedError(result.txHash, message, contractErrorCode(message));
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new RpcTimeoutError('transaction confirmation', timeoutMs);
  }

  /**
   * Polls `getProposal()` until the proposal reaches `targetStatus` (issue #274).
   *
   * Use it after `finalize()` or `execute()` to wait for the status change the
   * transaction causes. Every poll bypasses the read cache, so a cached `Active`
   * cannot hide a `Queued` that has already landed.
   *
   * @param proposalId Proposal to watch.
   * @param targetStatus Status to wait for.
   * @param options.pollIntervalMs Delay between polls (default: the client's
   * `pollIntervalMs`, then {@link DEFAULT_POLL_INTERVAL_MS}).
   * @param options.timeoutMs Give up after this long (default {@link DEFAULT_CONFIRMATION_TIMEOUT_MS}).
   * @returns The proposal as observed when it first had `targetStatus`.
   * @throws {ProposalNotFoundError} the proposal does not exist.
   * @throws {ProposalStatusTimeoutError} the status was not reached in time.
   * @example
   * await client.submitAndWait(signedFinalizeXdr);
   * const queued = await client.waitForProposalStatus(7n, 'Queued');
   */
  async waitForProposalStatus(
    proposalId: bigint,
    targetStatus: ProposalStatus,
    options?: WaitForStatusOptions,
  ): Promise<Proposal> {
    const pollIntervalMs = options?.pollIntervalMs ?? this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const proposal = await this.getProposal(proposalId, { bypassCache: true });
      if (!proposal) throw new ProposalNotFoundError(proposalId);
      if (proposal.status === targetStatus) return proposal;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ProposalStatusTimeoutError(proposalId, targetStatus, proposal.status, timeoutMs);
      }
      await delay(Math.min(pollIntervalMs, remainingMs));
    }
  }

  /**
   * Previews the fee a built transaction will pay, before it is signed (issue #277).
   *
   * Simulates the transaction again, so the resource fee reflects current network
   * pricing rather than the value captured when it was built. Works on every
   * `build*` output. A resource fee the transaction already declares is replaced
   * by the fresh estimate, so it is never counted twice.
   *
   * Simulation is read-only: nothing is signed or submitted.
   *
   * @param transactionXdr Base64 transaction XDR, as returned by a `build*` method.
   * @returns Fees in stroops.
   * @throws {Error} the simulation failed.
   * @example
   * const xdr = await client.buildVote(voter, 7n, 1);
   * const fee = await client.estimateFees(xdr);
   * showUser(`Network fee: ${Number(fee.totalFee) / 10_000_000} XLM`);
   * const { signedXdr } = await signWithFreighter(xdr, { networkPassphrase });
   */
  async estimateFees(transactionXdr: string): Promise<FeeEstimate> {
    const tx = TransactionBuilder.fromXDR(transactionXdr, this.config.networkPassphrase);
    if (!(tx instanceof Transaction)) {
      throw new Error('estimateFees does not accept fee-bump transactions');
    }

    const simulation = await this.read('simulate:estimateFees', () => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Fee estimate failed: ${simulation.error}`);
    }

    const resourceFee = BigInt(simulation.minResourceFee);
    const inclusionFee = BigInt(tx.fee) - declaredResourceFee(tx);
    return { inclusionFee, resourceFee, totalFee: inclusionFee + resourceFee };
  }

  /**
   * Builds, simulates and assembles a signable transaction.
   *
   * Fetches the source account for its sequence number, simulates first so
   * the returned transaction carries an accurate resource footprint, and
   * returns base64 XDR for the caller to sign (e.g. with Freighter) and
   * submit. Simulation failures are re-thrown as typed governance errors
   * where the contract code is recognisable.
   */
  private async buildGovernanceTransaction(
    source: string,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<string> {
    const sourceAccount = await this.server.getAccount(source);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.governance.call(method, ...args))
      .setTimeout(30)
      .build();

    try {
      const prepared = await this.server.prepareTransaction(tx);
      return prepared.toXDR();
    } catch (error) {
      throw mapGovernanceSimulationError(method, error);
    }
  }

  private async buildTokenTransaction(
    source: string,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<string> {
    const token = this.requireToken();
    const sourceAccount = await this.server.getAccount(source);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(token.call(method, ...args))
      .setTimeout(30)
      .build();

    try {
      const prepared = await this.server.prepareTransaction(tx);
      return prepared.toXDR();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Simulation of ${method} failed: ${message}`);
    }
  }

  // ─── Transaction Builders ────────────────────────────────────────────────
  // These return unsigned XDR strings — the caller signs with Freighter and submits.

  /**
   * Builds signable XDR for `create_proposal(proposer, title, description)` (issue #113).
   *
   * Creates a new governance proposal. `proposer` must sign and must hold at
   * least `proposalThreshold` tokens at the governance contract's snapshot
   * ledger. `source` pays the fee and defaults to `proposer`.
   *
   * @throws {Error} proposal threshold or other contract errors.
   */
  async buildCreateProposal(proposer: string, title: string, description: string, source?: string): Promise<string> {
    return this.buildGovernanceTransaction(
      source ?? proposer,
      'create_proposal',
      new Address(proposer).toScVal(),
      nativeToScVal(title, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
    );
  }

  /**
   * Builds signable XDR for `vote(voter, proposal_id, support)` (issue #114).
   *
   * Casts a vote on an active proposal. `support` is `0` (Against), `1` (For),
   * or `2` (Abstain). `voter` must sign. A voter who has already voted may
   * vote again while the window is open to change their choice. `source` pays
   * the fee and defaults to `voter`.
   *
   * @throws {ProposalNotFoundError} unknown proposal id.
   * @throws {VotingNotActiveError} proposal voting window is closed.
   */
  async buildVote(voter: string, proposalId: bigint, support: VoteSupport, source?: string): Promise<string> {
    return this.buildGovernanceTransaction(
      source ?? voter,
      'vote',
      new Address(voter).toScVal(),
      nativeToScVal(proposalId, { type: 'u64' }),
      nativeToScVal(support, { type: 'u32' }),
    );
  }

  /** Assign voting power without moving tokens. The holder must authorize. */
  async buildDelegate(delegator: string, delegatee: string, source?: string): Promise<string> {
    return this.buildGovernanceTransaction(
      source ?? delegator,
      'delegate',
      new Address(delegator).toScVal(),
      new Address(delegatee).toScVal(),
    );
  }

  /** Clear delegation and restore the holder's own voting power. */
  async buildUndelegate(delegator: string, source?: string): Promise<string> {
    return this.buildGovernanceTransaction(
      source ?? delegator,
      'undelegate',
      new Address(delegator).toScVal(),
    );
  }

  /**
   * Builds signable XDR for `finalize(proposal_id)` (issue #115).
   *
   * `finalize` takes no signer in the contract — anyone may call it once the
   * voting window has closed — so the fee-paying `source` account is an
   * explicit parameter. The returned XDR is unsigned; sign with Freighter.
   *
   * @throws {ProposalNotFoundError} unknown proposal id.
   * @throws {VotingNotActiveError} voting window has not closed yet.
   */
  async buildFinalize(source: string, proposalId: bigint): Promise<string> {
    return this.buildGovernanceTransaction(
      source,
      'finalize',
      nativeToScVal(proposalId, { type: 'u64' }),
    );
  }

  /**
   * Builds signable XDR for `execute(proposal_id)` (issue #115).
   *
   * `execute(executor, proposal_id)` requires the executor's authorization, so
   * `source` is both the executor and the fee payer. Only a `Queued` proposal
   * whose timelock has expired can be executed.
   *
   * @throws {ProposalNotFoundError} unknown proposal id.
   * @throws {ProposalNotPassedError} proposal is not `Queued` (still active,
   * failed, already executed, or cancelled).
   * @throws {TimelockNotExpiredError} timelock has not elapsed yet.
   */
  async buildExecute(source: string, proposalId: bigint): Promise<string> {
    return this.buildGovernanceTransaction(
      source,
      'execute',
      new Address(source).toScVal(),
      nativeToScVal(proposalId, { type: 'u64' }),
    );
  }

  /**
   * Builds signable XDR for `cancel(caller, proposal_id)` (issue #116).
   *
   * Restricted by the contract to the proposer or the admin — anyone else
   * fails with `Unauthorized`. `caller` must sign (via Freighter); `source`
   * pays the fee and defaults to `caller` for the common single-wallet flow.
   */
  async buildCancel(caller: string, proposalId: bigint, source?: string): Promise<string> {
    const feePayer = source ?? caller;
    return this.buildGovernanceTransaction(
      feePayer,
      'cancel',
      new Address(caller).toScVal(),
      nativeToScVal(proposalId, { type: 'u64' }),
    );
  }

  // ─── Token builders (issue #117) ─────────────────────────────────────────

  /**
   * Builds signable XDR for `transfer(from, to, amount)`.
   * `from` must sign; `source` pays the fee and defaults to `from`.
   */
  async buildTransfer(from: string, to: string, amount: bigint, source?: string): Promise<string> {
    return this.buildTokenTransaction(
      source ?? from,
      'transfer',
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }

  /**
   * Builds signable XDR for `approve(owner, spender, amount,
   * expiration_ledger)`.
   *
   * `expirationLedger` is a ledger sequence (u32), matching the contract's
   * current signature: a live approval (`amount > 0`) must not expire in the
   * past, while `amount == 0` revokes and accepts any expiration. `owner`
   * must sign; `source` pays the fee and defaults to `owner`.
   */
  async buildApprove(
    owner: string,
    spender: string,
    amount: bigint,
    expirationLedger: number,
    source?: string,
  ): Promise<string> {
    return this.buildTokenTransaction(
      source ?? owner,
      'approve',
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
      nativeToScVal(expirationLedger, { type: 'u32' }),
    );
  }

  /**
   * Builds signable XDR for `transfer_from(spender, from, to, amount)`.
   * `spender` must sign (the owner consented via `approve`); `source` pays
   * the fee and defaults to `spender`.
   */
  async buildTransferFrom(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
    source?: string,
  ): Promise<string> {
    return this.buildTokenTransaction(
      source ?? spender,
      'transfer_from',
      new Address(spender).toScVal(),
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTransientRpcError(error: unknown): boolean {
  const candidate = error as { response?: { status?: number }; status?: number; code?: string; message?: string };
  const status = candidate.response?.status ?? candidate.status;
  return (typeof status === 'number' && (status === 408 || status === 429 || status >= 500))
    || candidate.code === 'ECONNRESET'
    || candidate.code === 'ETIMEDOUT'
    || /(?:timeout|temporar|network|fetch failed|rate limit|try again)/i.test(candidate.message ?? '');
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate.code === 'ECONNABORTED' || candidate.code === 'ETIMEDOUT' || /timeout/i.test(candidate.message ?? '');
}

function formatTransactionFailure(response: { hash?: string; txHash?: string; errorResult?: unknown; resultXdr?: unknown }): string {
  const detail = response.errorResult ?? response.resultXdr;
  return detail ? `Transaction ${response.hash ?? response.txHash ?? ''} failed: ${String(detail)}` : `Transaction ${response.hash ?? response.txHash ?? ''} failed`;
}

/** Resource fee a prepared Soroban transaction already declares; zero for classic transactions. */
function declaredResourceFee(tx: Transaction): bigint {
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') return BigInt(0);
  const ext = envelope.v1.tx.ext;
  return ext.type === 'sorobanData' ? ext.sorobanData.resourceFee : BigInt(0);
}

// ─── Decoding ──────────────────────────────────────────────────────────────
// scValToNative output for the contract's #[contracttype] structs: field names
// stay snake_case, i128/u64 become bigint, u32 becomes number, Address becomes
// a strkey string, and a unit enum variant becomes a one-element [name] array.

interface RawProposal {
  id: bigint;
  proposer: string;
  title: string;
  description: string;
  for_votes: bigint;
  against_votes: bigint;
  abstain_votes: bigint;
  snapshot_ledger: number;
  start_ledger: number;
  end_ledger: number;
  queue_ledger: number;
  quorum_required: bigint;
  status: [string];
}

interface RawConfig {
  token: string;
  quorum_bps: number;
  voting_period: number;
  timelock_period: number;
  proposal_threshold: bigint;
  admin: string;
}

function decodeProposal(raw: RawProposal): Proposal {
  return {
    id: raw.id,
    proposer: raw.proposer,
    title: raw.title,
    description: raw.description,
    forVotes: raw.for_votes,
    againstVotes: raw.against_votes,
    abstainVotes: raw.abstain_votes,
    snapshotLedger: raw.snapshot_ledger,
    startLedger: raw.start_ledger,
    endLedger: raw.end_ledger,
    queueLedger: raw.queue_ledger,
    quorumRequired: raw.quorum_required,
    status: decodeStatus(raw.status),
  };
}

const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'Pending', 'Active', 'Passed', 'Failed', 'Queued', 'Executed', 'Cancelled',
];

/** Unit enum variant `[name]` → ProposalStatus, rejecting names the SDK does not know. */
function decodeStatus(raw: [string]): ProposalStatus {
  const name = raw[0];
  if (!(PROPOSAL_STATUSES as readonly string[]).includes(name)) {
    throw new Error(`Unknown ProposalStatus variant: ${String(name)}`);
  }
  return name as ProposalStatus;
}

export const TESTNET: Partial<QuorumClientConfig> = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

export const MAINNET: Partial<QuorumClientConfig> = {
  rpcUrl: 'https://soroban-rpc.stellar.org',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
};
