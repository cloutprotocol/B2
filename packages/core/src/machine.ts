import { type Connection, PublicKey } from '@solana/web3.js';
import { BRIDGED_SOL_MINT, companionCreatorAddress, decodeLaunch, decodePool, fetchCompanionSol, launchAddress, launchPoolAddress } from '@bordrless/sdk';

// Any launch coin's machine, read from chain: the launch and its pool, and its companion when the
// coin was launched by one (its SOL, its split, what it has bought, burned and shared). The indexer
// adds the rules in words from Bordrless's API; B² coins also get `b2.ts`'s reading.

export type LaunchMachine = {
  mint: string;
  at: number;
  launch: { status: 'curve' | 'graduated'; realQuoteSol: number; graduationSol: number; progress: number; creatorFeeBps: number; lpFeeBps: number; creator: string };
  pool: { address: string; priceSol: number; curve: boolean };
  companion: {
    address: string;
    sol: number;
    split: { buybackBps: number; holdersBps: number; beneficiaryBps: number; potBps: number };
    game: string | null;
    pendingBuybackSol: number;
    pendingHoldersSol: number;
    pendingPotSol: number;
    claimedSol: number;
    spentSol: number;
    burnedTokens: number;
    sharedSol: number;
    paidBeneficiarySol: number;
    bountiesSol: number;
  } | null;
};

const sol = (l: bigint) => Number(l) / 1e9;

export async function readLaunchMachine(conn: Connection, mintKey: PublicKey): Promise<LaunchMachine | null> {
  const launchInfo = await conn.getAccountInfo(launchAddress(mintKey));
  if (!launchInfo) return null;
  const launch = decodeLaunch(launchInfo.data);
  const poolKey = launchPoolAddress(mintKey, BRIDGED_SOL_MINT, launch.lpFeeBps);
  const creatorIsCompanion = launch.creator.equals(companionCreatorAddress(mintKey));
  const [poolInfo, comp] = await Promise.all([conn.getAccountInfo(poolKey), creatorIsCompanion ? fetchCompanionSol(conn, mintKey).catch(() => null) : null]);
  if (!poolInfo) return null;
  const pool = decodePool(poolInfo.data);
  const base = Number(pool.baseReserve + pool.virtualBase) / 1e6;
  const quote = Number(pool.quoteReserve + pool.virtualQuote) / 1e9;
  const c = comp?.companion;
  return {
    mint: mintKey.toBase58(),
    at: Math.floor(Date.now() / 1000),
    launch: {
      status: launch.status === 1 ? 'graduated' : 'curve',
      realQuoteSol: sol(pool.quoteReserve),
      graduationSol: sol(launch.graduationQuote),
      progress: launch.status === 1 ? 1 : Math.min(1, Number(pool.quoteReserve) / Number(launch.graduationQuote || 1n)),
      creatorFeeBps: launch.creatorFeeBps,
      lpFeeBps: launch.lpFeeBps,
      creator: launch.creator.toBase58(),
    },
    pool: { address: poolKey.toBase58(), priceSol: base ? quote / base : 0, curve: pool.curve },
    companion: c
      ? {
          address: companionCreatorAddress(mintKey).toBase58(),
          sol: sol(comp!.sol),
          split: { ...c.split, potBps: c.potBps ?? 0 },
          game: c.gameHook ? String(c.gameKind ?? 'game') : null,
          pendingBuybackSol: sol(c.pendingBuyback),
          pendingHoldersSol: sol(c.pendingHolders),
          pendingPotSol: sol(c.pendingPot ?? 0n),
          claimedSol: sol(c.claimedTotal),
          spentSol: sol(c.spentTotal),
          burnedTokens: Number(c.burnedTotal) / 1e6,
          sharedSol: sol(c.sharedTotal),
          paidBeneficiarySol: sol(c.paidBeneficiaryTotal),
          bountiesSol: sol(c.bountiesTotal),
        }
      : null,
  };
}
