/**
 * Types and decoders for every event the governance and token contracts emit.
 *
 * Both contracts publish `(Symbol(topic), …key entries)` topics with a struct
 * value (see `env.events().publish` in the contract sources). An indexer —
 * for example real-time vote counts — should not have to hand-roll that XDR
 * decoding, so the SDK maps it once:
 *
 * ```ts
 * const event = decodeEvent(logged);   // QuorumEvent | null
 * if (event?.type === 'vote_cast') tally(event.proposalId, event.votingPower);
 * ```
 *
 * Unknown topics decode to `null` rather than throwing, so one subscription
 * can carry events from other contracts without a decode failure.
 */
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ProposalStatus, VoteSupport } from './types.js';

/** The contract-emitted name of an event, as its first topic entry. */
export const EVENT_TOPICS = [
  'proposal_created',
  'vote_cast',
  'proposal_finalized',
  'proposal_queued',
  'proposal_executed',
  'proposal_cancelled',
  'transfer',
  'mint',
  'burn',
  'approve',
  'admin_transferred',
  'delegated',
  'contract_initialized',
  'contract_paused',
  'contract_unpaused',
] as const;

export type QuorumEventType = (typeof EVENT_TOPICS)[number];

// ─── Governance events ─────────────────────────────────────────────────────

export interface ProposalCreatedEvent {
  type: 'proposal_created';
  id: bigint;
  proposer: string;
  title: string;
  startLedger: number;
  endLedger: number;
  quorumRequired: bigint;
}

export interface VoteCastEvent {
  type: 'vote_cast';
  proposalId: bigint;
  voter: string;
  /** 0 Against, 1 For, 2 Abstain — the contract rejects anything else. */
  support: VoteSupport;
  /** Weight counted: effective voting power at the snapshot ledger. */
  votingPower: bigint;
}

export interface ProposalFinalizedEvent {
  type: 'proposal_finalized';
  id: bigint;
  status: ProposalStatus;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
}

export interface ProposalQueuedEvent {
  type: 'proposal_queued';
  id: bigint;
  queueLedger: number;
}

export interface ProposalExecutedEvent {
  type: 'proposal_executed';
  id: bigint;
}

export interface ProposalCancelledEvent {
  type: 'proposal_cancelled';
  id: bigint;
  caller: string;
}

// ─── Token events ──────────────────────────────────────────────────────────

export interface TransferEvent {
  type: 'transfer';
  from: string;
  to: string;
  amount: bigint;
}

export interface MintEvent {
  type: 'mint';
  to: string;
  amount: bigint;
  /** Supply *after* the mint, so indexers need no special case for deploy. */
  totalSupply: bigint;
}

export interface BurnEvent {
  type: 'burn';
  from: string;
  amount: bigint;
  /** Supply *after* the burn. */
  totalSupply: bigint;
}

export interface ApproveEvent {
  type: 'approve';
  owner: string;
  spender: string;
  amount: bigint;
  expirationLedger: number;
}

export interface AdminTransferredEvent {
  type: 'admin_transferred';
  previousAdmin: string;
  newAdmin: string;
}

export interface DelegatedEvent {
  type: 'delegated';
  delegator: string;
  delegatee: string;
}

export interface ContractInitializedEvent {
  type: 'contract_initialized';
  admin: string;
  guardian: string;
  token: string;
  quorumBps: number;
  votingPeriod: number;
  timelockPeriod: number;
  executionGracePeriod: number;
  proposalThreshold: bigint;
}

export interface ContractPauseEvent {
  type: 'contract_paused' | 'contract_unpaused';
  caller: string;
}

/** Any event emitted by the governance or token contract, discriminated by `type`. */
export type QuorumEvent =
  | ProposalCreatedEvent
  | VoteCastEvent
  | ProposalFinalizedEvent
  | ProposalQueuedEvent
  | ProposalExecutedEvent
  | ProposalCancelledEvent
  | TransferEvent
  | MintEvent
  | BurnEvent
  | ApproveEvent
  | AdminTransferredEvent
  | DelegatedEvent
  | ContractInitializedEvent
  | ContractPauseEvent;

/**
 * The parts of an RPC event the decoder needs.
 *
 * `SorobanRpc.Api.GetEventsResponse['events'][n]` satisfies this structurally,
 * so a subscription result can be passed straight through.
 */
export interface RawContractEvent {
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  paging_token?: string;
  ledger?: number;
}

export interface EventSubscriptionOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type EventSubscriptionFilters = Record<string, unknown>;
export type EventSource = {
  getEvents(request: Record<string, unknown>): Promise<{ events?: RawContractEvent[] }>;
};

/**
 * Polls an RPC event source and delivers each decodable event once.
 *
 * @example
 * const stop = subscribeToEvents(server, { filters: [{ type: 'contract' }] }, event => console.log(event));
 * // later: stop();
 */
export function subscribeToEvents(
  source: EventSource,
  filters: EventSubscriptionFilters,
  onEvent: (event: QuorumEvent) => void,
  options: EventSubscriptionOptions = {},
): () => void {
  const intervalMs = Math.max(250, options.pollIntervalMs ?? 5_000);
  let cursor: string | undefined;
  let stopped = false;
  const delivered = new Set<string>();
  const poll = async () => {
    if (stopped) return;
    const response = await source.getEvents({ ...filters, ...(cursor ? { cursor } : {}) });
    for (const raw of response.events ?? []) {
      const key = raw.paging_token ?? `${raw.ledger ?? ''}:${JSON.stringify(raw.topic)}:${JSON.stringify(raw.value)}`;
      if (delivered.has(key)) continue;
      delivered.add(key);
      const decoded = decodeEvent(raw);
      if (decoded) onEvent(decoded);
      if (raw.paging_token) cursor = raw.paging_token;
    }
  };
  const timer = setInterval(() => { void poll().catch(() => undefined); }, intervalMs);
  void poll().catch(() => undefined);
  const unsubscribe = () => { stopped = true; clearInterval(timer); };
  options.signal?.addEventListener('abort', unsubscribe, { once: true });
  return unsubscribe;
}

/** A known topic whose value could not be decoded. Unknown topics never throw. */
export class EventDecodeError extends Error {
  readonly topic: string;

  constructor(topic: string, detail: string) {
    super(`Cannot decode "${topic}" event: ${detail}`);
    this.name = 'EventDecodeError';
    this.topic = topic;
  }
}

/** The first topic entry as a string, or `null` if it is not a symbol/string. */
function topicName(topic: readonly unknown[] | undefined): string | null {
  const head = topic?.[0];
  if (typeof head === 'string') return head;
  if (!xdr.ScVal.is(head)) return null;
  if (head.type !== 'scvSymbol' && head.type !== 'scvString') return null;
  const name = scValToNative(head);
  return typeof name === 'string' ? name : null;
}

/** Decodes the event value as the struct the contract published. */
function struct(value: xdr.ScVal, topic: string): Record<string, unknown> {
  let native: unknown;
  try {
    native = scValToNative(value);
  } catch (error) {
    throw new EventDecodeError(topic, `value is not decodable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof native !== 'object' || native === null || Array.isArray(native)) {
    throw new EventDecodeError(topic, 'value is not a struct');
  }
  return native as Record<string, unknown>;
}

function field<T>(raw: Record<string, unknown>, key: string, topic: string): T {
  const value = raw[key];
  if (value === undefined || value === null) {
    throw new EventDecodeError(topic, `missing field "${key}"`);
  }
  return value as T;
}

/**
 * A unit enum variant decodes to a one-element array (`['Queued']`), matching
 * how `Proposal.status` is decoded elsewhere in the SDK.
 */
function unitVariant<T extends string>(raw: Record<string, unknown>, key: string, topic: string): T {
  const value = field<unknown>(raw, key, topic);
  if (Array.isArray(value)) {
    const name = value[0];
    if (typeof name === 'string') return name as T;
  }
  if (typeof value === 'string') return value as T;
  throw new EventDecodeError(topic, `field "${key}" is not a unit enum variant`);
}

/**
 * Decodes one raw event.
 *
 * @returns The typed event, or `null` when the topic is not one this SDK knows
 * (including non-symbol topics) — unknown events are ignored, never thrown on.
 * @throws {EventDecodeError} A known topic whose value is malformed.
 */
export function decodeEvent(event: RawContractEvent): QuorumEvent | null {
  const topic = topicName(event?.topic);
  if (topic === null) return null;
  if (!(EVENT_TOPICS as readonly string[]).includes(topic)) return null;

  const raw = struct(event.value, topic);

  switch (topic) {
    case 'delegated':
      return {
        type: 'delegated',
        delegator: field<string>(raw, 'delegator', topic),
        delegatee: field<string>(raw, 'delegatee', topic),
      };
    case 'contract_initialized':
      return {
        type: 'contract_initialized',
        admin: field<string>(raw, 'admin', topic),
        guardian: field<string>(raw, 'guardian', topic),
        token: field<string>(raw, 'token', topic),
        quorumBps: field<number>(raw, 'quorum_bps', topic),
        votingPeriod: field<number>(raw, 'voting_period', topic),
        timelockPeriod: field<number>(raw, 'timelock_period', topic),
        executionGracePeriod: field<number>(raw, 'execution_grace_period', topic),
        proposalThreshold: field<bigint>(raw, 'proposal_threshold', topic),
      };
    case 'contract_paused':
    case 'contract_unpaused':
      return { type: topic, caller: field<string>(raw, 'caller', topic) };
    case 'proposal_created':
      return {
        type: 'proposal_created',
        id: field<bigint>(raw, 'id', topic),
        proposer: field<string>(raw, 'proposer', topic),
        title: field<string>(raw, 'title', topic),
        startLedger: field<number>(raw, 'start_ledger', topic),
        endLedger: field<number>(raw, 'end_ledger', topic),
        quorumRequired: field<bigint>(raw, 'quorum_required', topic),
      };
    case 'vote_cast':
      return {
        type: 'vote_cast',
        proposalId: field<bigint>(raw, 'proposal_id', topic),
        voter: field<string>(raw, 'voter', topic),
        support: field<VoteSupport>(raw, 'support', topic),
        votingPower: field<bigint>(raw, 'voting_power', topic),
      };
    case 'proposal_finalized':
      return {
        type: 'proposal_finalized',
        id: field<bigint>(raw, 'id', topic),
        status: unitVariant<ProposalStatus>(raw, 'status', topic),
        forVotes: field<bigint>(raw, 'for_votes', topic),
        againstVotes: field<bigint>(raw, 'against_votes', topic),
        abstainVotes: field<bigint>(raw, 'abstain_votes', topic),
      };
    case 'proposal_queued':
      return {
        type: 'proposal_queued',
        id: field<bigint>(raw, 'id', topic),
        queueLedger: field<number>(raw, 'queue_ledger', topic),
      };
    case 'proposal_executed':
      return { type: 'proposal_executed', id: field<bigint>(raw, 'id', topic) };
    case 'proposal_cancelled':
      return {
        type: 'proposal_cancelled',
        id: field<bigint>(raw, 'id', topic),
        caller: field<string>(raw, 'caller', topic),
      };
    case 'transfer':
      return {
        type: 'transfer',
        from: field<string>(raw, 'from', topic),
        to: field<string>(raw, 'to', topic),
        amount: field<bigint>(raw, 'amount', topic),
      };
    case 'mint':
      return {
        type: 'mint',
        to: field<string>(raw, 'to', topic),
        amount: field<bigint>(raw, 'amount', topic),
        totalSupply: field<bigint>(raw, 'total_supply', topic),
      };
    case 'burn':
      return {
        type: 'burn',
        from: field<string>(raw, 'from', topic),
        amount: field<bigint>(raw, 'amount', topic),
        totalSupply: field<bigint>(raw, 'total_supply', topic),
      };
    case 'approve':
      return {
        type: 'approve',
        owner: field<string>(raw, 'owner', topic),
        spender: field<string>(raw, 'spender', topic),
        amount: field<bigint>(raw, 'amount', topic),
        expirationLedger: field<number>(raw, 'expiration_ledger', topic),
      };
    case 'admin_transferred':
      return {
        type: 'admin_transferred',
        previousAdmin: field<string>(raw, 'previous_admin', topic),
        newAdmin: field<string>(raw, 'new_admin', topic),
      };
    default:
      return null;
  }
}

/** Decodes a batch of events, dropping topics this SDK does not know. */
export function decodeEvents(events: readonly RawContractEvent[]): QuorumEvent[] {
  const decoded: QuorumEvent[] = [];
  for (const event of events) {
    const typed = decodeEvent(event);
    if (typed !== null) decoded.push(typed);
  }
  return decoded;
}
