import { PublicKey } from '@solana/web3.js';
import { BRIDGED_SOL_MINT, SWAP_PROGRAM } from '@bordrless/sdk';

// Addresses B² and the scanner read. Bordrless's own come from @bordrless/sdk.

export { BRIDGED_SOL_MINT, SWAP_PROGRAM };

/** B²'s programs on mainnet, as Bordrless deployed them from the Workshop submission (programs/b2). */
export const B2_SCRIPT = new PublicKey('5HZP9Nn6ScGzduvsadvDEUuZnz5Xz7yynzxuxPRHmnre');
export const B2_HOOK = new PublicKey('8Bb1WwMZ4sZkvaDETUwdBgDgdA7NPQuEWd81Q5uDoorb');

/** The first B² coin. */
export const B2_FIRST_COIN = new PublicKey('4iWwcHf9tH6J6UjRgG9rXosXVxNdcKUFuqh1rbps6H7J');

/** wBORDR, BORDR's 1:1 twin on the Bordrless standard, and the BORDR SPL mint behind it. */
export const WBORDR_MINT = new PublicKey('APpT4aqDoXAVz6S9wVWCJdqayFcs4tvfj5jToffVncwv');
export const BORDR_SPL_MINT = new PublicKey('6Mix12LiHrQFojaQEnfPUC65Qkwd6X4Y5Qg93oFbordr');
/** The wBORDR/SOL pool B² buys wBORDR on (30 bps). */
export const WBORDR_SOL_POOL = new PublicKey('BtVzohbo3J6sBqk3L8MQVEKP4Bzg1YPmqX3Pc3oWxKnL');

/** The launchpad's graduation threshold for 1-billion-token launches: real SOL in the curve. */
export const GRADUATION_QUOTE_LAMPORTS = 108_953_308_326n;
