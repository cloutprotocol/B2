# B²

**A few words:** BORDR liquidity, locked forever.

## In the builder's words

B² turns a coin's pot into liquidity that nobody can ever take out, in two equal pools: the
coin's own pool against SOL, and a pool of the coin against wBORDR (BORDR bridged onto Bordrless).

**While the coin is on its curve**, fees already build the pot. After the first minute (and any
sniper window), the pot buys a little of the coin each step and holds it, at most 1% of the curve's
depth per buy and at most half the pot in all before graduation, so SOL is left for later. It does
not buy while the price is running more than 3% above its one-hour reference. **Dip Buy:** if the
coin dips more than 15% under the hook's six-hour reference, and the dip holds for two steps or two
minutes, the pot buys the dip, cheaply, and keeps that coin for the liquidity too (after
graduation, half for each pool). Nothing is burned.

**After graduation**, the coin the pot held is used first: half goes into the coin/SOL pool with
SOL from the pot, half into the coin/wBORDR pool (1% LP fee) with wBORDR the pot buys. From then on each step
buys for whichever pool has had less, keeping the two even. Every LP token goes to the launch's own
LP holding, which no instruction can move: the liquidity stays for good. The coin/wBORDR pool is
created on its first deposit, at the price the two SOL pools imply. If anyone has made it first at
another price, or trading has pushed it more than 3% off, the pot trades it back with the coin or
wBORDR it holds (buying whichever is cheap) before it adds. While coin/wBORDR can't take a deposit,
the pot goes on building the coin/SOL pool, and coin/wBORDR catches up once it can.

**The hook** takes 1% of the SOL on every buy and sell; Bordrless takes its usual share of that,
as of every creator fee, and the rest goes to the pot. In a dip, buys pay nothing and sells pay 3%.
The pot's own trades pay no cut. It never takes tokens, never blocks a transfer and writes nothing
into holdings, so holdings can always be closed.

**Every step is guarded:** at most 1% of a pool's depth, at most 0.5 SOL, a minimum output on every
swap, no buying into a run-up, no deposit while a pool's price has strayed more than 3%. A step with
nothing to do does not run, so the pot does not pay keeper bounties for empty steps.

**Every lamport the pot spends becomes locked liquidity.** The script pays no one. The builder
earns only the Workshop's builder share: half of the launcher's part of the creator fee, paid by
the companion out of each claim, never from the pot.

## Risks

- Half of the liquidity is paired with wBORDR, so its value moves with BORDR's price as well as
  the coin's.
- B² runs on Bordrless's programs (token, DEX, launchpad, companion, bridge), which have not been
  through an independent audit. The Workshop's checks are an AI reading and a test, not an audit.
- Locked liquidity can't be withdrawn by anyone, including the launcher and the builder. It is
  locked because Bordrless's launchpad, which holds the LP, has no instruction that moves it; the
  launchpad is upgradeable by Bordrless.
