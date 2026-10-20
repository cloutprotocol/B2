# programs/b2: the B² Workshop pair

The pair as submitted to the Bordrless Workshop:

```
hook/         the hook: the 1% SOL cut, Dip Buy pricing (buys 0%, sells 3% under -15% of its 6 h reference)
script/       the companion script: holds, waits, dip buys, the split into coin/SOL and coin/wBORDR at graduation
submission/   the files as sent (companion/, hook/, details.md, terms.md); mirrors script/ and hook/
tests/        LiteSVM tests against the Bordrless programs dumped from mainnet (fixtures/)
scripts/      build.sh: builds both, checks the Workshop's source rules, runs the tests
```

## Deployed

Bordrless deployed it under their own ids:

| | mainnet |
| --- | --- |
| script | `5HZP9Nn6ScGzduvsadvDEUuZnz5Xz7yynzxuxPRHmnre` |
| hook | `8Bb1WwMZ4sZkvaDETUwdBgDgdA7NPQuEWd81Q5uDoorb` |
| first coin | `4iWwcHf9tH6J6UjRgG9rXosXVxNdcKUFuqh1rbps6H7J` |

The `declare_id!`s in the source are our local keypairs', used for the tests.

## Build and test

```sh
# once: a keypair for each half to build under (keys/ is gitignored, never commit it)
mkdir -p keys
solana-keygen new --no-bip39-passphrase -o keys/my_hook-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/workshop_script-keypair.json
# put each keypair's address in its program's declare_id! (hook/src, script/src):
solana address -k keys/my_hook-keypair.json
solana address -k keys/workshop_script-keypair.json

scripts/build.sh                                # build both halves and run the Workshop source checks
cargo test --release -p bordr-pair-tests        # LiteSVM tests against fixtures/ (mainnet dumps)
```

`scripts/build.sh` checks that each `declare_id!` matches its keypair, so a fresh clone fails fast until
both are set.

`scripts/build.sh` needs the Solana CLI (`cargo build-sbf --tools-version v1.57 --arch v3`).
