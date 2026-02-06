#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
PROJECT_ID="${PROJECT_ID:-}"
PROJECT_NAME="${PROJECT_NAME:-Sample Project}"
SOURCE_REF="${SOURCE_REF:-https://github.com/zpqrtbnk/test-repo}"
DB_NAME="${DB_NAME:-docs_lm}"
CHAT_ONLY=false
INDEX_ONLY=false

get_project_id_by_name() {
  node -e '
    const fs = require("fs");
    const name = process.argv[1];
    const input = fs.readFileSync(0, "utf8");
    try {
      const data = JSON.parse(input);
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const match = projects.find((p) => p.name === name);
      process.stdout.write(match ? String(match.project_id) : "");
    } catch (err) {
      process.stdout.write("");
    }
  ' "${PROJECT_NAME}"
}

for arg in "$@"; do
  if [ "${arg}" = "--chat-only" ]; then
    CHAT_ONLY=true
  fi
  if [ "${arg}" = "--index-only" ]; then
    INDEX_ONLY=true
  fi
done

if [ "${CHAT_ONLY}" = "true" ] && [ "${INDEX_ONLY}" = "true" ]; then
  echo "Cannot use --chat-only and --index-only together"
  exit 1
fi

echo "Using BASE_URL=${BASE_URL}"
if [ "${CHAT_ONLY}" = "false" ]; then
  echo "Creating project ${PROJECT_NAME}"

  create_response=$(curl -sS -X POST "${BASE_URL}/api/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"${PROJECT_NAME}\",\"source_ref\":\"${SOURCE_REF}\"}" \
    -w "\n%{http_code}")

  create_body=$(printf "%s" "${create_response}" | head -n 1)
  create_status=$(printf "%s" "${create_response}" | tail -n 1)

  printf "%s\n" "${create_body}" | tee /tmp/docs_lm_project_create.json

  if [ "${create_status}" = "409" ]; then
    existing_id=$(curl -sS "${BASE_URL}/api/projects" | get_project_id_by_name)
    echo "Project exists; deleting ${PROJECT_NAME} ID: ${existing_id} and retrying"
    if [ -n "${existing_id}" ]; then
      curl -sS -X DELETE "${BASE_URL}/api/projects/${existing_id}" | tee /tmp/docs_lm_project_delete.json
    fi

    echo "Creating project ${PROJECT_NAME}"
    retry_response=$(curl -sS -X POST "${BASE_URL}/api/projects" \
      -H "content-type: application/json" \
      -d "{\"name\":\"${PROJECT_NAME}\",\"source_ref\":\"${SOURCE_REF}\"}" \
      -w "\n%{http_code}")

    create_body=$(printf "%s" "${retry_response}" | head -n 1)
    printf "%s\n" "${create_body}" | tee /tmp/docs_lm_project_create.json
  fi

  PROJECT_ID=$(printf "%s" "${create_body}" | sed -n 's/.*"project_id":"\([^"]*\)".*/\1/p')
  if [ -z "${PROJECT_ID}" ]; then
    PROJECT_ID=$(curl -sS "${BASE_URL}/api/projects" | get_project_id_by_name)
  fi
fi

if [ "${CHAT_ONLY}" = "false" ]; then
  if [ -z "${PROJECT_ID}" ]; then
    PROJECT_ID=$(curl -sS "${BASE_URL}/api/projects" | get_project_id_by_name)
  fi
  if [ -z "${PROJECT_ID}" ]; then
    echo "Project id not found for ${PROJECT_NAME}"
    exit 1
  fi

  echo "Checking indexing status"

status=""
attempts=0
max_attempts=60

while [ "${attempts}" -lt "${max_attempts}" ]; do
  status_response=$(curl -sS "${BASE_URL}/api/index/status?project_id=${PROJECT_ID}")
  printf "%s\n" "${status_response}" | tee /tmp/docs_lm_index_status.json

  status=$(printf "%s" "${status_response}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "${status}" = "ready" ]; then
    break
  fi

  attempts=$((attempts + 1))
  echo "Index status: ${status:-unknown}. Waiting... (${attempts}/${max_attempts})"
  sleep 5
done

  if [ "${status}" != "ready" ]; then
    echo "Index not ready after waiting. Proceeding with chat may fail."
  else
    echo "Index ready."
  fi
fi

if [ "${INDEX_ONLY}" = "false" ]; then
  echo "Sending chat query"

  if [ -z "${PROJECT_ID}" ]; then
    PROJECT_ID=$(curl -sS "${BASE_URL}/api/projects" | sed -n "s/.*\"name\":\"${PROJECT_NAME}\".*\"project_id\":\"\([^\"]*\)\".*/\1/p")
  fi

  if [ -z "${PROJECT_ID}" ]; then
    echo "Project id not found for ${PROJECT_NAME}"
    exit 1
  fi

  echo "curl -sS -X POST \"${BASE_URL}/api/chat\" -H \"content-type: application/json\" -d '{\"project_id\":\"${PROJECT_ID}\",\"message\":\"Please could you tell me what this repo is about?\"}'"
  curl -sS -X POST "${BASE_URL}/api/chat" \
    -H "content-type: application/json" \
    -d "{\"project_id\":\"${PROJECT_ID}\",\"message\":\"Please could you tell me what this repo is about?\"}" \
    | tee /tmp/docs_lm_chat.json
fi

echo "Done"
