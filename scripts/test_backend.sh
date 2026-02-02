#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
PROJECT_ID="${PROJECT_ID:-sample-project}"
SOURCE_TYPE="${SOURCE_TYPE:-github}"
SOURCE_REF="${SOURCE_REF:-https://github.com/zpqrtbnk/test-repo}"
DB_NAME="${DB_NAME:-docs_lm}"

echo "Using BASE_URL=${BASE_URL}"
echo "Creating project ${PROJECT_ID}"

create_response=$(curl -sS -X POST "${BASE_URL}/api/projects" \
  -H "content-type: application/json" \
  -d "{\"project_id\":\"${PROJECT_ID}\",\"source_type\":\"${SOURCE_TYPE}\",\"source_ref\":\"${SOURCE_REF}\"}" \
  -w "\n%{http_code}")

create_body=$(printf "%s" "${create_response}" | head -n 1)
create_status=$(printf "%s" "${create_response}" | tail -n 1)

printf "%s\n" "${create_body}" | tee /tmp/docs_lm_project_create.json

if [ "${create_status}" = "409" ]; then
  echo "Project exists; deleting ${PROJECT_ID} and retrying"
  npx wrangler d1 execute "${DB_NAME}" --remote --command "DELETE FROM chat_logs WHERE project_id = '${PROJECT_ID}'; DELETE FROM chunks WHERE project_id = '${PROJECT_ID}'; DELETE FROM documents WHERE project_id = '${PROJECT_ID}'; DELETE FROM projects WHERE project_id = '${PROJECT_ID}';"

  echo "Creating project ${PROJECT_ID}"
  curl -sS -X POST "${BASE_URL}/api/projects" \
    -H "content-type: application/json" \
    -d "{\"project_id\":\"${PROJECT_ID}\",\"source_type\":\"${SOURCE_TYPE}\",\"source_ref\":\"${SOURCE_REF}\"}" \
    | tee /tmp/docs_lm_project_create.json
fi

echo "Checking indexing status"

status=""
attempts=0
max_attempts=30

while [ "${attempts}" -lt "${max_attempts}" ]; do
  status_response=$(curl -sS "${BASE_URL}/api/index/status?project_id=${PROJECT_ID}")
  printf "%s\n" "${status_response}" | tee /tmp/docs_lm_index_status.json

  status=$(printf "%s" "${status_response}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "${status}" = "ready" ]; then
    break
  fi

  attempts=$((attempts + 1))
  echo "Index status: ${status:-unknown}. Waiting... (${attempts}/${max_attempts})"
  sleep 2
done

if [ "${status}" != "ready" ]; then
  echo "Index not ready after waiting. Proceeding with chat may fail."
fi

echo "Sending chat query"

curl -sS -X POST "${BASE_URL}/api/chat" \
  -H "content-type: application/json" \
  -d "{\"project_id\":\"${PROJECT_ID}\",\"message\":\"How do I get started?\"}" \
  | tee /tmp/docs_lm_chat.json

echo "Done"
