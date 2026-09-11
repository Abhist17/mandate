#!/usr/bin/env bash
#
# Put your deployer private key into .env without it ever appearing on screen, in shell
# history, or in a chat window.
#
#   ./scripts/set-key.sh
#
# It prompts with hidden input, validates the key, shows you the ADDRESS it corresponds to
# (so you can confirm it is the wallet you meant), and writes it to .env. .env is gitignored.
#
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

command -v cast >/dev/null || { echo "foundry not installed — run: curl -L https://foundry.paradigm.xyz | bash && foundryup"; exit 1; }
[ -f .env ] || cp .env.example .env

printf '\nPaste your private key (input is hidden), then press Enter:\n> '
read -rs KEY
echo

KEY=${KEY#0x}
if ! [[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "That is not a private key (expected 64 hex characters). Nothing was changed."
  exit 1
fi
KEY="0x$KEY"

ADDR=$(cast wallet address --private-key "$KEY")
BAL=$(cast balance "$ADDR" --rpc-url https://testnet-rpc.monad.xyz --ether 2>/dev/null || echo "?")

printf '\nThis key controls:  %s\n' "$ADDR"
printf 'Monad testnet MON:  %s\n\n' "$BAL"
printf 'Write it to .env as the deployer and keeper? [y/N] '
read -r OK
[[ "$OK" =~ ^[yY]$ ]] || { echo "Nothing was changed."; exit 0; }

python3 - "$KEY" "$ADDR" <<'PY'
import sys, re
key, addr = sys.argv[1], sys.argv[2]
s = open('.env').read()
def setk(s, k, v):
    if re.search(rf'^{k}=', s, re.M):
        return re.sub(rf'^{k}=.*$', f'{k}={v}', s, flags=re.M)
    return s.rstrip('\n') + f'\n{k}={v}\n'
s = setk(s, 'PRIVATE_KEY', key)
s = setk(s, 'KEEPER_PRIVATE_KEY', key)
s = setk(s, 'KEEPER_ADDRESS', addr)
open('.env', 'w').write(s)
PY

# Belt and braces: the key must never end up in git.
grep -qx '.env' .gitignore || echo '.env' >> .gitignore
git check-ignore -q .env && echo ".env is gitignored — the key will not reach GitHub."

printf '\nDone. Next:  make deploy-live\n\n'
