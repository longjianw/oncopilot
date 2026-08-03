#!/bin/zsh
set -euo pipefail

read -rs "ark_secret_key?请粘贴已轮换的火山方舟 API Key（输入不会显示）："
echo
if [[ -z "$ark_secret_key" ]]; then
  echo "未输入密钥，已取消。"
  exit 1
fi

ARK_CODING_API_KEY="$ark_secret_key" npm run benchmark:ark
unset ark_secret_key
