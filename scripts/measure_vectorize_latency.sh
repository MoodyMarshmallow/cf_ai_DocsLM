#!/usr/bin/env bash

set -euo pipefail

INDEX_NAME="${INDEX_NAME:-docs_chunks}"
VECTOR_ID="${VECTOR_ID:-test-vector-$(date +%s)}"
PROJECT_ID="${PROJECT_ID:-latency-test}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"

echo "Measuring Vectorize upsert latency"
echo "Index: ${INDEX_NAME}"
echo "Vector ID: ${VECTOR_ID}"

payload_file=$(mktemp)
node -e '
  const fs = require("fs");
  const vectorId = process.argv[1];
  const projectId = process.argv[2];
  const values = Array.from({ length: 1024 }, (_, i) => (i % 10) / 10);
  const payload = {
    id: vectorId,
    values,
    metadata: {
      project_id: projectId,
      url: "https://example.com/vectorize-latency",
    },
  };
  fs.writeFileSync(process.argv[3], JSON.stringify(payload) + "\n");
' "${VECTOR_ID}" "${PROJECT_ID}" "${payload_file}"

start_ms=$(date +%s%3N)
echo "Upsert called for vector ID: ${VECTOR_ID}"
npx wrangler vectorize upsert "${INDEX_NAME}" --file "${payload_file}"

attempt=0
while [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; do
  result=$(npx wrangler vectorize query "${INDEX_NAME}" --vector-id "${VECTOR_ID}")
  found=$(printf "%s" "${result}" | node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    const start = input.indexOf("{");
    if (start === -1) {
      process.stdout.write("0");
    } else {
      const jsonText = input.slice(start);
      try {
        const data = JSON.parse(jsonText);
        const matches = Array.isArray(data.matches) ? data.matches : [];
        const id = process.argv[1];
        const hit = matches.some((m) => m && m.id === id);
        process.stdout.write(hit ? "1" : "0");
      } catch (err) {
        process.stdout.write("0");
      }
    }
  ' "${VECTOR_ID}")
  echo "${result}"

  if [ "${found}" -eq 1 ]; then
    end_ms=$(date +%s%3N)
    elapsed=$((end_ms - start_ms))
    echo "Vector appeared after ${elapsed}ms"
    rm -f "${payload_file}"
    exit 0
  fi

  attempt=$((attempt + 1))
  echo "Not found yet. Attempt ${attempt}/${MAX_ATTEMPTS}. Waiting..."
  sleep "${POLL_INTERVAL_SECONDS}"
done

rm -f "${payload_file}"
echo "Timed out waiting for vector to appear"
exit 1
