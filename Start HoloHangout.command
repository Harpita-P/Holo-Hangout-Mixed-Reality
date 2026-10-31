#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  nvm use --silent >/dev/null
fi
npm run start:holohangout
status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo "HoloHangout stopped with an error. Run 'npm run check' for details."
  echo "Press any key to close this window."
  read -k 1
fi
exit $status
