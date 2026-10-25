#!/usr/bin/env node
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { MAINNET, QuorumClient, TESTNET } from '@quorum/sdk';

const args = process.argv.slice(2);
const command = args.shift();
const value = (name: string, required = true) => {
  const index = args.indexOf(`--${name}`);
  const result = index >= 0 ? args[index + 1] : undefined;
  if (required && !result) throw new Error(`Missing --${name}`);
  return result;
};

const network = value('network', false) ?? 'testnet';
const preset = network === 'mainnet'
  ? MAINNET
  : network === 'futurenet'
    ? { rpcUrl: 'https://rpc-futurenet.stellar.org', networkPassphrase: 'Test SDF Future Network ; October 2022' }
    : TESTNET;
const passphrase = network === 'custom' ? value('network-passphrase')! : preset.networkPassphrase!;
const rpcUrl = network === 'custom' ? value('rpc-url')! : (value('rpc-url', false) ?? preset.rpcUrl!);
const governanceContractId = process.env.QUORUM_GOVERNANCE_CONTRACT_ID ?? value('governance');
const tokenContractId = process.env.QUORUM_TOKEN_CONTRACT_ID;
const secret = process.env.QUORUM_SECRET_KEY ?? value('secret');
const keypair = secret ? Keypair.fromSecret(secret) : null;
const client = new QuorumClient({ rpcUrl, networkPassphrase: passphrase, governanceContractId, tokenContractId });

async function submit(builder: Promise<string>) {
  if (!keypair) throw new Error('QUORUM_SECRET_KEY or --secret is required for write commands');
  const unsigned = await builder;
  const signed = TransactionBuilder.fromXDR(unsigned, passphrase);
  signed.sign(keypair);
  const result = await client.submitAndWait(signed.toXDR());
  console.log(JSON.stringify({ hash: result.txHash, status: result.status }));
}

if (command === 'propose') await submit(client.buildCreateProposal(keypair?.publicKey() ?? value('proposer')!, value('title')!, value('description')!));
else if (command === 'vote') await submit(client.buildVote(keypair?.publicKey() ?? value('voter')!, BigInt(value('id')!), Number(value('support')) as 0 | 1 | 2));
else if (command === 'finalize') await submit(client.buildFinalize(keypair?.publicKey() ?? value('source')!, BigInt(value('id')!)));
else if (command === 'execute') await submit(client.buildExecute(keypair?.publicKey() ?? value('source')!, BigInt(value('id')!)));
else if (command === 'get') console.log(JSON.stringify(await client.getProposal(BigInt(value('id')!)), (_, item) => typeof item === 'bigint' ? item.toString() : item));
else throw new Error('Usage: quorum <propose|vote|finalize|execute|get> ...');
