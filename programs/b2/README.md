# programs/b2: the B² Workshop pair

The pair as we submitted it to the Bordrless Workshop (copied from `bauls/bordrless/bordr_pair`):

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
# once: the keypairs the tests build under (gitignored, never committed)
cp -r ../../../bauls/bordrless/bordr_pair/keys ./keys
scripts/build.sh
```

`scripts/build.sh` needs the Solana CLI (`cargo build-sbf --tools-version v1.57 --arch v3`).
