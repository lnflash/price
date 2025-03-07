#!/bin/bash

set -eu

export digest=$(cat ./edge-image/digest)
export history_digest=$(cat ./history-edge-image/digest)
export history_migrate_digest=$(cat ./history-migrate-edge-image/digest)

pushd charts-repo

ref=$(yq e '.image.git_ref' charts/price/values.yaml)
git checkout ${BRANCH}
old_ref=$(yq e '.image.git_ref' charts/price/values.yaml)

cat <<EOF >> ../body.md
# Bump flash price images

The flash price image will be bumped to digest:
\`\`\`
${digest}
\`\`\`

The flash price-history image will be bumped to digest:
\`\`\`
${history_digest}
\`\`\`

The flash price-history-migrate image will be bumped to digest:
\`\`\`
${history_migrate_digest}
\`\`\`

Code diff contained in this image:

https://github.com/lnflash/price/compare/${old_ref}...${ref}
EOF

# export GH_TOKEN="$(ghtoken generate -b "${GH_APP_PRIVATE_KEY}" -i "${GH_APP_ID}" | jq -r '.token')"
export GH_TOKEN=${AUTH_TOKEN}
gh auth setup-git

gh repo set-default ${GH_ORG}/charts
git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"

export ref=$(cat ./repo/.git/short_ref)
git checkout ${ref}

gh pr close ${BOT_BRANCH} || true
gh pr create \
  --title "chore(deps): bump-price-image-${ref}" \
  --body-file ../body.md \
  --base ${BRANCH} \
  --head ${BOT_BRANCH} \
  --label flashbot \
  --label price
