import { validateAndParseAddress } from 'starknet';
import { Delegate, Governance } from '../.checkpoint/models';
import { STARKNET_INDEXER_NAME } from './constants';

export const DECIMALS = 0;

export const BIGINT_ZERO = BigInt(0);

export const ZERO_ADDRESS = validateAndParseAddress('0x0');

export async function getDelegate(id: string, governanceId: string): Promise<Delegate> {
  let delegate = await Delegate.loadEntity(`${governanceId}/${id}`, STARKNET_INDEXER_NAME);

  if (!delegate) {
    delegate = new Delegate(`${governanceId}/${id}`, STARKNET_INDEXER_NAME);
    delegate.governance = governanceId;
    delegate.user = id;

    if (id != ZERO_ADDRESS) {
      const governance = await getGovernance(governanceId);
      governance.totalDelegates += 1;
      await governance.save();
    }
  }

  return delegate;
}

export async function getGovernance(id: string): Promise<Governance> {
  let governance = await Governance.loadEntity(id, STARKNET_INDEXER_NAME);

  if (!governance) {
    governance = new Governance(id, STARKNET_INDEXER_NAME);
    governance.currentDelegates = 0;
    governance.totalDelegates = 0;
  }

  return governance;
}
