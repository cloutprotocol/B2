#!/usr/bin/env bash
# Builds both halves of BORDR Pair as the Workshop briefs say, checks them against the template
# rules, and (with `dump`) refreshes fixtures/ from mainnet:
#
#   scripts/build.sh          cargo build-sbf the hook (hook/target/deploy/my_hook.so) and the
#                             script (target/deploy/workshop_script.so), platform-tools v1.57,
#                             SBPF v3, Agave 4.3.0; then the source checks
#   scripts/build.sh dump     also solana program dump -u mainnet-beta every Bordrless program the
#                             tests load into fixtures/ (never bordrless/sbf/)
#
# Then: cargo test --release -p bordr-pair-tests (SBF_OUT_DIR is fixtures/, .cargo/config.toml).
# Nothing here deploys anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PATH="$HOME/.local/share/solana/install/releases/v4.3.0/solana-release/bin:$PATH"

# Each program is built under the id of its keypair in keys/ (declare_id! must match).
mkdir -p "$ROOT/hook/target/deploy" "$ROOT/target/deploy"
cp "$ROOT/keys/my_hook-keypair.json" "$ROOT/hook/target/deploy/"
cp "$ROOT/keys/workshop_script-keypair.json" "$ROOT/target/deploy/"

echo "==> cargo build-sbf hook"
(cd "$ROOT/hook" && cargo build-sbf --tools-version v1.57 --arch v3)
echo "==> cargo build-sbf script"
cargo build-sbf --tools-version v1.57 --arch v3 --manifest-path "$ROOT/script/Cargo.toml"

fail=0
check_half() {
  local half="$1" keypair="$2" no_cpi="$3"
  local files bytes
  files=$(find "$ROOT/$half/src" -type f | wc -l | tr -d ' ')
  bytes=$(cat "$ROOT/$half/src"/*.rs | wc -c | tr -d ' ')
  echo "--- $half: $files files, $bytes bytes of src/ (at most 8 and 120000)"
  [[ "$files" -le 8 && "$bytes" -le 120000 ]] || { echo "    over the limits"; fail=1; }
  find "$ROOT/$half/src" -type f ! -name '*.rs' -exec echo "    not a .rs file: {}" \; -exec false {} + || fail=1
  find "$ROOT/$half/src" -type f -name '*.rs' | grep -Ev '/src/[a-z0-9_]+\.rs$' && { echo "    a file name the Workshop refuses"; fail=1; }
  # The rules, on the code with comments taken out.
  local code
  code=$(cat "$ROOT/$half/src"/*.rs | sed -E 's#//.*$##')
  local forbidden='unsafe|asm!|global_asm!|macro_rules!|cfg_attr|extern |no_mangle|#\[link|include_str!|include_bytes!|include!|env!|option_env!|#\[path|std::fs|std::net|std::process|std::os|std::env|std::thread'
  if [[ "$no_cpi" == "1" ]]; then forbidden="$forbidden|invoke|CpiContext|::cpi|close *=|realloc|resize"; fi
  if grep -nE "$forbidden" <<<"$code"; then echo "    a forbidden construct"; fail=1; fi
  [[ $(grep -c 'declare_id!' <<<"$code") -eq 1 ]] || { echo "    declare_id! is not exactly once"; fail=1; }
  [[ $(grep -c '#\[program\]' <<<"$code") -eq 1 ]] || { echo "    #[program] is not exactly once"; fail=1; }
  local id; id=$(solana address -k "$ROOT/keys/$keypair")
  grep -q "declare_id!(\"$id\")" <<<"$code" || { echo "    declare_id! is not $id"; fail=1; }
  echo "    declare_id! $id (keys/$keypair), one #[program], no forbidden construct"
}
check_half hook my_hook-keypair.json 1
check_half script workshop_script-keypair.json 0
# The submission folder, as the Workshop form takes it: the same files, the same checks.
check_half submission/hook my_hook-keypair.json 1
check_half submission/companion workshop_script-keypair.json 0
for pair in "hook/src submission/hook/src" "script/src submission/companion/src" "hook/hook.json submission/hook/hook.json" "script/keeper.json submission/companion/keeper.json"; do
  set -- $pair
  diff -rq "$ROOT/$1" "$ROOT/$2" >/dev/null || { echo "submission: $2 differs from $1"; fail=1; }
done
find "$ROOT/submission" -type f | sed "s#$ROOT/##" | sort
if grep -niE "audited|\bsafe\b|guaranteed" "$ROOT"/submission/*.md; then echo "submission: a word the briefs rule out"; fail=1; fi
grep -q 'pub fn prepare(ctx: Context<Prepare>)' "$ROOT/hook/src/lib.rs" || { echo "hook: no standard prepare"; fail=1; }
ls -la "$ROOT/hook/target/deploy/my_hook.so" "$ROOT/target/deploy/workshop_script.so"

if [[ "${1:-}" == "dump" ]]; then
  while read -r name id; do
    echo "==> dump $name ($id)"
    solana program dump -u mainnet-beta "$id" "$ROOT/fixtures/$name.so" >/dev/null
  done <<'IDS'
bordrless_token 2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22
bordrless_swap GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk
bordrless_bridge CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7
bordrless_launch 1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC
bordrless_kit 14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH
tax_hook 8tjnVSreJGBRQFyDBf1SyyhBgLsdBxa2rHYh9sbxFyX7
half_life 53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8
lottery_hook HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr
bordrless_companion 6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo
hook_timelock BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ
hook_vault 5cojoUStG7WFhHJiSncCUEwTqDuhDLKu4a9BqTbF8jzG
loss_cover_hook 6KMdXC3Fxovp3pnUsdQuUbderPzZtTA4t6R1jacYJWQr
loss_cover_script 9mRXU9gpWY3B13AyuCCtNjHnKt1pUFBQ6vJDLTwgakhm
bordrless_router 7M5GTuzhByzBbrJURzLtbBrFjcsC8aHu816qWTXAYD85
IDS
  # hook_tester (test-only, never on mainnet) is built from bordrless-programs at the pinned rev.
fi
exit "$fail"
