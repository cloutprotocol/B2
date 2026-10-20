import { createHash } from 'node:crypto';
import { type Connection, PublicKey } from '@solana/web3.js';
import {
  companionCreatorAddress,
  decodeHolding,
  decodeLaunch,
  decodePool,
  fetchCompanionSol,
  holdingAddress,
  launchAddress,
  launchPoolAddress,
  BRIDGED_SOL_MINT,
  scriptStateAddress,
} from '@bordrless/sdk';
import { B2_HOOK } from './ids.ts';

// B²'s machine, read from chain: the hook's dip state, the script's state, the companion's pot and
// held coin, the launch and its pool. Layouts mirror programs/b2 (hook/src/lib.rs DipState,
// script/src/lib.rs PairState and Stepped); keep them in step with the deployed build.

/** 2^48 fixed point: quote base units per base unit. */
const PRICE_SHIFT = 48n;

/** The rules as the programs hold them (programs/b2). */
export const B2_RULES = {
  /** The hook's SOL cut on every curve trade, and in a dip. */
  cutBps: 100,
  dipBuyBps: 0,
  dipSellBps: 300,
  /** A dip: this far under the hook's reference. */
  dipDepthBps: 1_500,
  hookReferenceSecs: 21_600,
  /** The script buys only up to this far over its own reference. */
  guardBps: 300,
  scriptReferenceSecs: 3_600,
  /** Before graduation the script spends at most this share of all SOL in. */
  pregradPotBps: 5_000,
  maxSpendLamports: 500_000_000,
  stepSecs: 60,
  pairLpFeeBps: 100,
} as const;

export const ACTION_NAMES: Record<number, string> = {
  0: 'observe',
  1: 'buy wBORDR',
  2: 'buy coin',
  3: 'create pair',
  4: 'add pair',
  5: 'dip buy',
  6: 'hold',
  7: 'add SOL pool',
  8: 'heal pair',
};

class Reader {
  private i = 0;
  constructor(private b: Buffer) {}
  skip(n: number) {
    this.i += n;
  }
  u8() {
    return this.b.readUInt8(this.i++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.i);
    this.i += 8;
    return v;
  }
  i64() {
    const v = this.b.readBigInt64LE(this.i);
    this.i += 8;
    return Number(v);
  }
  u128() {
    const lo = this.b.readBigUInt64LE(this.i);
    const hi = this.b.readBigUInt64LE(this.i + 8);
    this.i += 16;
    return (hi << 64n) | lo;
  }
  key() {
    const k = new PublicKey(this.b.subarray(this.i, this.i + 32));
    this.i += 32;
    return k.toBase58();
  }
  left() {
    return this.b.length - this.i;
  }
}

/** SOL per whole token from a 2^48 fixed price (quote lamports per base unit). */
export const fixedToSol = (p: bigint, baseDecimals = 6) => (Number(p) / 2 ** 48) * 10 ** (baseDecimals - 9);

export type DipState = {
  reference: bigint;
  price: bigint;
  movedAt: number;
  dip: boolean;
  dipSince: number;
  dips: number;
  trades: number;
};

export function decodeDipState(data: Buffer): DipState {
  const r = new Reader(data);
  r.skip(8 + 1 + 1 + 32);
  return {
    reference: r.u128(),
    price: r.u128(),
    movedAt: r.i64(),
    dip: r.bool(),
    dipSince: r.i64(),
    dips: Number(r.u64()),
    trades: Number(r.u64()),
  };
}

export type PairState = {
  coinHold: bigint;
  coinForSol: bigint;
  coinForPair: bigint;
  wbordrHeld: bigint;
  coinReference: bigint;
  coinPrice: bigint;
  coinMovedAt: number;
  wbordrReference: bigint;
  wbordrPrice: bigint;
  wbordrMovedAt: number;
  solLeg: bigint;
  pairLeg: bigint;
  pregradSpent: bigint;
  dipStreak: number;
  lastStepAt: number;
  steps: number;
  lastAction: number;
  solToDip: bigint;
  dipBought: bigint;
  solPoolLpLocked: bigint;
  pairLpLocked: bigint;
  graduatedSeen: boolean;
};

export function decodePairState(data: Buffer): PairState {
  const r = new Reader(data);
  r.skip(8 + 1 + 32);
  return {
    coinHold: r.u64(),
    coinForSol: r.u64(),
    coinForPair: r.u64(),
    wbordrHeld: r.u64(),
    coinReference: r.u128(),
    coinPrice: r.u128(),
    coinMovedAt: r.i64(),
    wbordrReference: r.u128(),
    wbordrPrice: r.u128(),
    wbordrMovedAt: r.i64(),
    solLeg: r.u64(),
    pairLeg: r.u64(),
    pregradSpent: r.u64(),
    dipStreak: r.u8(),
    lastStepAt: r.i64(),
    steps: Number(r.u64()),
    lastAction: r.u8(),
    solToDip: r.u64(),
    dipBought: r.u64(),
    solPoolLpLocked: r.u64(),
    pairLpLocked: r.u64(),
    graduatedSeen: r.bool(),
  };
}

export const hookStateAddressOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('state'), mint.toBuffer()], B2_HOOK)[0];

/** Everything the machine view draws, at one moment, in display units (SOL, whole tokens). */
export type Machine = {
  mint: string;
  at: number;
  launch: { status: 'curve' | 'graduated'; realQuoteSol: number; graduationSol: number; progress: number; creatorFeeBps: number };
  pool: { address: string; priceSol: number };
  hook: { referenceSol: number; dipLineSol: number; dip: boolean; dips: number; trades: number; movedAt: number } | null;
  script: {
    referenceSol: number;
    guardSol: number;
    lastStepAt: number;
    steps: number;
    lastAction: string;
    pregradSpentSol: number;
    solLegSol: number;
    pairLegSol: number;
    solToDipSol: number;
    lpLocked: { solPool: number; pair: number };
    graduatedSeen: boolean;
  } | null;
  companion: {
    address: string;
    potSol: number;
    heldCoin: number;
    heldWbordr: number;
    /** The pre-graduation floor: the pot can't go below half of all SOL in. */
    floorSol: number;
  };
};

export async function readMachine(conn: Connection, mintKey: PublicKey): Promise<Machine | null> {
  const creator = companionCreatorAddress(mintKey);
  const keys = [
    launchAddress(mintKey),
    hookStateAddressOf(mintKey),
    scriptStateAddress(mintKey),
    creator,
    holdingAddress(mintKey, creator),
  ];
  const [[launchInfo, hookInfo, stateInfo, , heldInfo], companionSol] = await Promise.all([
    conn.getMultipleAccountsInfo(keys),
    fetchCompanionSol(conn, mintKey).catch(() => null),
  ]);
  if (!launchInfo) return null;
  const launch = decodeLaunch(launchInfo.data);
  const poolKey = launchPoolAddress(mintKey, BRIDGED_SOL_MINT, launch.lpFeeBps);
  const poolInfo = await conn.getAccountInfo(poolKey);
  if (!poolInfo) return null;
  const pool = decodePool(poolInfo.data);
  const priceFixed = ((pool.quoteReserve + pool.virtualQuote) << PRICE_SHIFT) / (pool.baseReserve + pool.virtualBase || 1n);

  const hook = hookInfo ? decodeDipState(hookInfo.data) : null;
  const state = stateInfo ? decodePairState(stateInfo.data) : null;
  const potLamports = companionSol?.sol ?? 0n;
  const held = heldInfo ? decodeHolding(heldInfo.data).amount : 0n;
  const spent = state?.pregradSpent ?? 0n;

  const sol = (l: bigint) => Number(l) / 1e9;
  return {
    mint: mintKey.toBase58(),
    at: Math.floor(Date.now() / 1000),
    launch: {
      status: launch.status === 1 ? 'graduated' : 'curve',
      realQuoteSol: sol(pool.quoteReserve),
      graduationSol: sol(launch.graduationQuote),
      progress: launch.status === 1 ? 1 : Math.min(1, Number(pool.quoteReserve) / Number(launch.graduationQuote || 1n)),
      creatorFeeBps: launch.creatorFeeBps,
    },
    pool: { address: poolKey.toBase58(), priceSol: fixedToSol(priceFixed) },
    hook: hook
      ? {
          referenceSol: fixedToSol(hook.reference),
          dipLineSol: fixedToSol(hook.reference) * (1 - B2_RULES.dipDepthBps / 10_000),
          dip: hook.dip,
          dips: hook.dips,
          trades: hook.trades,
          movedAt: hook.movedAt,
        }
      : null,
    script: state
      ? {
          referenceSol: fixedToSol(state.coinReference),
          guardSol: fixedToSol(state.coinReference) * (1 + B2_RULES.guardBps / 10_000),
          lastStepAt: state.lastStepAt,
          steps: state.steps,
          lastAction: ACTION_NAMES[state.lastAction] ?? String(state.lastAction),
          pregradSpentSol: sol(state.pregradSpent),
          solLegSol: sol(state.solLeg),
          pairLegSol: sol(state.pairLeg),
          solToDipSol: sol(state.solToDip),
          lpLocked: { solPool: Number(state.solPoolLpLocked) / 1e9, pair: Number(state.pairLpLocked) / 1e9 },
          graduatedSeen: state.graduatedSeen,
        }
      : null,
    companion: {
      address: creator.toBase58(),
      potSol: sol(potLamports),
      heldCoin: Number(held) / 1e6,
      heldWbordr: Number(state?.wbordrHeld ?? 0n) / 1e6,
      floorSol: sol((potLamports + spent) / 2n),
    },
  };
}

// ---- Steps ---------------------------------------------------------------------------------------

const eventDisc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const STEPPED = eventDisc('Stepped');

export type Step = { signature: string; slot: number; at: number; action: string; sol: number; amount: number; pot: number };

/** B²'s `Stepped` events in a transaction's logs (`emit!`, "Program data:" lines). */
export function steppedOf(logs: string[]): Omit<Step, 'signature' | 'slot' | 'at'>[] {
  const out: Omit<Step, 'signature' | 'slot' | 'at'>[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const raw = Buffer.from(line.slice('Program data: '.length), 'base64');
    if (raw.length < 8 || !raw.subarray(0, 8).equals(STEPPED)) continue;
    const r = new Reader(raw);
    r.skip(8);
    r.key();
    const action = r.u8();
    const sol = r.u64();
    const amount = r.u64();
    if (r.left() >= 16) r.u64(); // the first build's royalty
    const pot = r.u64();
    out.push({ action: ACTION_NAMES[action] ?? String(action), sol: Number(sol) / 1e9, amount: Number(amount) / 1e6, pot: Number(pot) / 1e9 });
  }
  return out;
}

/** The latest steps of a B² coin, newest first: every transaction that wrote its script state, read for `Stepped`. */
export async function fetchSteps(rpcUrl: string, mintKey: PublicKey, limit = 25): Promise<Step[]> {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'b2-indexer' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: any; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const sigs: { signature: string; slot: number; blockTime: number | null; err: unknown }[] = await call('getSignaturesForAddress', [
    scriptStateAddress(mintKey).toBase58(),
    { limit },
  ]);
  const out: Step[] = [];
  await Promise.all(
    sigs
      .filter((s) => !s.err)
      .map(async (s) => {
        const tx = await call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
        for (const e of steppedOf(tx?.meta?.logMessages ?? [])) out.push({ signature: s.signature, slot: s.slot, at: s.blockTime ?? 0, ...e });
      }),
  );
  return out.sort((a, b) => b.slot - a.slot);
}
