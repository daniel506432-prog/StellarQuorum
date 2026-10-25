# @quorum/sdk

The CI bundle budget checks the minified ESM entry points after gzip: the root
entry is capped at 25 KiB and the optional `freighter` entry at 35 KiB. The
separate budget keeps wallet-only dependencies from leaking into Node users'
initial bundle.

TypeScript SDK for the Quorum governance protocol on Stellar/Soroban: read
proposals and config through `QuorumClient`, build transactions, sign them
with Freighter, and decode the events both contracts emit.

```bash
npm install @quorum/sdk
```

## Configure and make your first call

```typescript
import { QuorumClient, TESTNET } from '@quorum/sdk';

const client = new QuorumClient({
  ...TESTNET,
  governanceContractId: 'CC...', // deployed governance contract
  tokenContractId: 'CC...',      // deployed QUORUM token contract
});

const proposal = await client.getProposal(1n);
console.log(proposal?.title, proposal?.status);
```

`TESTNET` supplies Stellar testnet's RPC URL and network passphrase. Use
`MAINNET`, or provide `rpcUrl` and `networkPassphrase` yourself, for another
network. `tokenContractId` is optional when only governance methods are used.

Both module systems are supported — `import` resolves the ESM build,
`require()` the CommonJS build, and TypeScript picks up the matching types.

### Signing with Freighter

The wallet helper lives behind an optional entry point so Node consumers never
load it. It requires the peer dependency:

```bash
npm install @stellar/freighter-api
```

```typescript
import { signWithFreighter, FreighterError, FreighterErrorCode } from '@quorum/sdk/freighter';

const xdr = await client.buildFinalize(sourceAddress, proposalId);
const { signedXdr } = await signWithFreighter(xdr, { networkPassphrase });
```

Every failure is a `FreighterError` with a `code` — `NOT_INSTALLED`,
`LOCKED`, `ACCESS_DENIED`, `SIGNING_REJECTED` or `WALLET_ERROR`.

### Previewing fees before signing

`estimateFees` re-simulates a built transaction and returns the fee it will pay
at current network pricing, in stroops (1 XLM = 10,000,000 stroops):

```typescript
const xdr = await client.buildFinalize(sourceAddress, proposalId);
const fee = await client.estimateFees(xdr);
showUser(`Network fee: ${Number(fee.totalFee) / 10_000_000} XLM`);

const { signedXdr } = await signWithFreighter(xdr, { networkPassphrase });
```

`totalFee` is `inclusionFee + resourceFee`. The result is an estimate: pricing
can change between the preview and submission.

### Waiting for a status change

`waitForProposalStatus` polls until a proposal reaches a status, for example
after finalizing it. It rejects with `ProposalStatusTimeoutError` when the
status is not reached within `timeoutMs` (default 60 seconds):

```typescript
import { ProposalStatusTimeoutError } from '@quorum/sdk';

await client.submitAndWait(signedFinalizeXdr);
try {
  const queued = await client.waitForProposalStatus(proposalId, 'Queued', { timeoutMs: 120_000 });
} catch (error) {
  if (error instanceof ProposalStatusTimeoutError) console.log(error.lastStatus);
}
```

### Events

```typescript
import { decodeEvent, decodeEvents } from '@quorum/sdk';

for (const event of decodeEvents(rpcEvents)) {
  if (event.type === 'vote_cast') console.log(event.proposalId, event.votingPower);
}
```

Covers `proposal_created`, `vote_cast`, `proposal_finalized`,
`proposal_queued`, `proposal_executed`, `proposal_cancelled`, `transfer`,
`mint`, `burn`, `approve` and `admin_transferred`. Unknown topics decode to
`null` instead of throwing.

## Python read-only bindings

## Command-line governance tool

The `sdk/cli` package provides `@quorum/cli` commands for testnet, futurenet,
mainnet, or a custom RPC. Set `QUORUM_GOVERNANCE_CONTRACT_ID` and
`QUORUM_SECRET_KEY`, then run `npx @quorum/cli propose --title "..."
--description "..."`, `vote --id 1 --support 1`, `finalize --id 1`,
`execute --id 1`, or `get --id 1`. Use `--network custom --rpc-url ...
--network-passphrase ...` for a private network. The secret key is read only
for local signing and this CLI is not a mainnet custody solution; use a secure
wallet or signer for production funds.

Python services can install the governance query package from source. See
[the Python SDK README](python/README.md) for installation, typed result
shapes, and examples of `get_proposal`, `get_all_proposals`, `get_config`,
and `get_vote`. Write transaction building is outside its scope.

## Method status

The following `QuorumClient` methods are implemented:

- Governance reads: `getProposal`, `getProposalCount`, `getProposals`,
  `getAllProposals`, `getProposalsByStatus`, `getConfig`, `hasVoted`,
  `getVote`, `getLatestLedger`, `getVotingPower` and `getDelegate`
- Token reads: `getBalance`, `getTokenDecimals`, `balance`, `getPastBalance`,
  `allowance` and `totalSupply`
- Transaction flow: `buildFinalize`, `buildExecute`, `buildCancel`,
  `buildTransfer`, `buildApprove`, `buildTransferFrom`, `submitAndWait`,
  `waitForProposalStatus` and `estimateFees`

Upgrading from an earlier release? `buildFinalize` and `buildExecute` changed
signature in 0.2.0. See [MIGRATIONS.md](MIGRATIONS.md).

`getVotingPower` reads the token's delegated weight at the proposal snapshot
through `get_past_votes`. `buildDelegate` and `buildUndelegate` build unsigned
governance transactions; the holder must authorize even if a different source
account pays the fee. Self-delegation clears an existing assignment.

## Contract errors

`GovernanceError` and `TokenError` mirror the Rust `#[contracterror]` enums;
`parseGovernanceError(error)` maps `Error(Contract, #N)` to a code.

## Optional batch simulations

Set `batchSimulation: true` in `QuorumClientConfig` to coalesce concurrent
proposal reads into JSON-RPC batch HTTP requests. `getProposals()` and
`getAllProposals()` use this path, with the same ordered `Proposal[]` return
value. `simulationBatchSize` is 1..100 (default 50). Caching still applies;
only cache misses are simulated. A singleton uses an individual request.

Batching is opt-in because provider policies differ. The reference Stellar RPC
[configures a jrpc2 HTTP bridge](https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/jsonrpc.go),
whose [HTTP handler accepts batch requests](https://pkg.go.dev/github.com/creachadair/jrpc2/jhttp).
The JS Stellar SDK does not expose a batch simulation method, so this SDK
sends an array of `simulateTransaction` requests using native `fetch`.
This combines HTTP requests, not operations inside a transaction: each
simulation still contains exactly one contract invocation.

Providers rejecting batches (HTTP rejection, non-array/invalid responses,
missing/duplicate response IDs, or unsupported JSON-RPC envelopes) are retried
with individual reads. That client stops probing thereafter. Batch responses
are matched by ID, not array order. Contract errors retain individual-read
semantics; timeouts, authentication errors, and exhausted transient retries
surface to the caller. Only read simulations are batched.

After `npm run build`, run `node bench/batch-simulate.bench.mjs` from `sdk/`
to exercise both paths over a local mock HTTP provider. A 50-proposal page
uses 51 HTTP requests individually and 2 with batching (count + batch),
with identical decoded values. The benchmark measures HTTP request counts;
its local elapsed times do not predict public-provider latency.

## Optional read cache

Caching is disabled by default and is local to each client. Enable it with
`cache: { enabled: true, ttlMs: 5_000, methodTtlMs: { getConfig: 60_000 } }`
in `QuorumClientConfig`. TTLs are milliseconds, start after a successful RPC,
and can be set to zero to disable a method. Entries are keyed by method and
arguments; `maxEntries` bounds memory (default 1000). Errors are never cached,
and returned objects can be modified without changing the cached value.

Every single read accepts a final options argument:

```typescript
await client.getProposal(7n, { bypassCache: true }); // fresh, leaves cache alone
await client.getConfig({ invalidateCache: true }); // evict, fetch, and cache
client.invalidateCache('getProposal', 7n);         // evict this proposal
client.invalidateCache('getVote');                // evict every vote
client.invalidateCache();                         // evict everything
```

Proposal-list options also accept `bypassCache` and `invalidateCache`, applied
to the count and every proposal in the window. `hasVoted` shares `getVote`'s
cache. After submitting a write, invalidate the affected reads or bypass the
cache when immediate freshness matters; no write automatically clears it.

## Contributor notes

Run `npm ci`, `npm run build`, and `npm run test:browser` in `sdk/` to
check browser compatibility. CI bundles the emitted ESM entry with esbuild's
browser target, rejects Node built-in imports (including `node:` imports),
and loads the bundle without Node globals such as `Buffer` or `process`.
Dependencies are bundled too, using their browser exports; do not externalize
them or add Node polyfills to hide a failing shared SDK code path.

## Releasing

See [docs/publishing.md](https://github.com/StellarQuorum/StellarQuorum/blob/main/docs/publishing.md)
for the versioning policy and release checklist.

## License

MIT
