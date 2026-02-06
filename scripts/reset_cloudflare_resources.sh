#!/usr/bin/env bash

set -euo pipefail

D1_NAME="${D1_NAME:-docs_lm}"
R2_BUCKET="${R2_BUCKET:-docs-lm}"
VECTORIZE_INDEX="${VECTORIZE_INDEX:-docs_chunks}"
VECTORIZE_DIMENSIONS="${VECTORIZE_DIMENSIONS:-1024}"
VECTORIZE_METRIC="${VECTORIZE_METRIC:-cosine}"

echo "Resetting Cloudflare resources"
echo "D1: ${D1_NAME}"
echo "R2: ${R2_BUCKET}"
echo "Vectorize: ${VECTORIZE_INDEX}"

echo "Deleting Vectorize index"
npx wrangler vectorize delete "${VECTORIZE_INDEX}"

echo "Creating Vectorize index"
npx wrangler vectorize create "${VECTORIZE_INDEX}" --dimensions "${VECTORIZE_DIMENSIONS}" --metric "${VECTORIZE_METRIC}"
npx wrangler vectorize create-metadata-index "${VECTORIZE_INDEX}" --property-name project_id --type string

echo "Deleting R2 bucket"
npx wrangler r2 bucket delete "${R2_BUCKET}"

echo "Creating R2 bucket"
npx wrangler r2 bucket create "${R2_BUCKET}"

echo "Deleting D1 database"
npx wrangler d1 delete "${D1_NAME}"

echo "Creating D1 database"
npx wrangler d1 create "${D1_NAME}"

echo "Applying D1 migrations"
npx wrangler d1 execute "${D1_NAME}" --file migrations/0001_init.sql --remote

echo "Done"
