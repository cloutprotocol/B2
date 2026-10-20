# B²: terms

| Term | Value |
|---|---|
| Builder share (the Workshop's 50% of the launcher's part, or nothing) | **50%.** Paid by the companion out of the launcher's part of each claim, never the pot. The script itself pays no one. |
| Builder's wallet (the earning wallet that signs in to the Workshop) | `5opKD1pbKzi98T2wvohsgzWPTS7AzYY1ys1xx2Nygfr3` |
| Config fee | 1% in all, fixed when the pair's launch config is made |
| Launcher's share of the fee (keeper.json `launcherShareBps`) | 4,000: 40% to the launcher's creator fee, 60% to the pot |
| Step interval (keeper.json `stepSecs`) | 60 seconds |
| SOL cut caps (hook.json) | buys 100 bps, sells 300 bps |
| Liquidity split | 50% coin/SOL (the launch pool), 50% coin/wBORDR (`LIQ_SOL_POOL_BPS` = 5,000) |
| coin/wBORDR LP fee (keeper.json `feeBps`, `PAIR_LP_FEE_BPS`) | 100 bps |
| wBORDR/SOL pool (keeper.json `feeBps`) | Bordrless's native pool, 30 bps: `BtVzohbo3J6sBqk3L8MQVEKP4Bzg1YPmqX3Pc3oWxKnL` |
| Before graduation | at most half the pot (`PREGRAD_POT_BPS` = 5,000) |

What one SOL of trading pays, with the 1% fee and the hook's 1% cut (Bordrless's 25% share taken from
both): the builder 0.15%, the launcher 0.15%, and the pot 1.2%, all of which becomes locked
liquidity.
