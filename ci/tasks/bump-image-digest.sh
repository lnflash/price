#!/bin/bash

set -eu

export digest=$(cat ./edge-image/digest)
export history_digest=$(cat ./history-edge-image/digest)
export history_migrate_digest=$(cat ./history-migrate-edge-image/digest)
export ref=$(cat ./repo/.git/short_ref)

pushd charts-repo

yq -i e '.realtime.image.digest = strenv(digest)' ./charts/price/values.yaml
yq -i e '.realtime.image.git_ref = strenv(ref)' ./charts/price/values.yaml
yq -i e '.history.image.digest = strenv(history_digest)' ./charts/price/values.yaml
yq -i e '.history.migrateImage.digest = strenv(history_migrate_digest)' ./charts/price/values.yaml

if [[ -z $(git config --global user.email) ]]; then
  git config --global user.email "bot@flash.io"
fi
if [[ -z $(git config --global user.name) ]]; then
  git config --global user.name "CI Bot"
fi

(
  cd $(git rev-parse --show-toplevel)
  git merge --no-edit ${BRANCH}
  git add -A
  git status
  git commit -m "chore(deps): bump flash price image to '${digest}'"
)
