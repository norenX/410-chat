#!/usr/bin/env bash
set -euo pipefail

service_name="${DBIP_COMPOSE_SERVICE:-chat}"
restart_after_install="${DBIP_RESTART:-true}"
release_month="${DBIP_MONTH:-$(date -u +%Y-%m)}"
download_url="${DBIP_DOWNLOAD_URL:-https://download.db-ip.com/free/dbip-country-lite-${release_month}.mmdb.gz}"
project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/410-dbip.XXXXXX")"
archive_file="${temporary_directory}/dbip-country-lite.mmdb.gz"
database_file="${temporary_directory}/dbip-country-lite.mmdb"

cleanup() {
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT

if [[ "${restart_after_install}" != "true" && "${restart_after_install}" != "false" ]]; then
  printf 'DBIP_RESTART must be true or false\n' >&2
  exit 2
fi

cd "${project_directory}"

curl --fail --silent --show-error --location --retry 3 \
  --output "${archive_file}" "${download_url}"
gzip --test "${archive_file}"
gzip --decompress --stdout "${archive_file}" > "${database_file}"
test -s "${database_file}"

docker compose run --rm --no-deps -T \
  --volume "${database_file}:/tmp/dbip-country-lite.mmdb:ro" \
  --entrypoint node "${service_name}" -e '
    const { open } = require("maxmind");
    open("/tmp/dbip-country-lite.mmdb")
      .then((reader) => {
        const databaseType = String(reader.metadata.databaseType || "");
        if (!databaseType.toLowerCase().includes("country")) {
          throw new Error("unexpected MMDB database type");
        }
      })
      .catch(() => {
        console.error("DB-IP MMDB validation failed");
        process.exit(1);
      });
  '

docker compose run --rm --no-deps -T \
  --volume "${database_file}:/tmp/dbip-country-lite.mmdb:ro" \
  --entrypoint sh "${service_name}" -c '
    set -eu
    active=/data/dbip-country-lite.mmdb
    previous=/data/dbip-country-lite.mmdb.previous
    staged=/data/.dbip-country-lite.mmdb.new
    previous_staged=/data/.dbip-country-lite.mmdb.previous.new
    rm -f "${staged}" "${previous_staged}"
    cp /tmp/dbip-country-lite.mmdb "${staged}"
    chmod 0644 "${staged}"
    if [ -f "${active}" ]; then
      cp "${active}" "${previous_staged}"
      chmod 0644 "${previous_staged}"
      mv -f "${previous_staged}" "${previous}"
    fi
    mv -f "${staged}" "${active}"
    test -r "${active}"
  '

if [[ "${restart_after_install}" == "true" ]]; then
  docker compose restart "${service_name}"
  printf 'Installed DB-IP Lite Country %s and restarted %s\n' "${release_month}" "${service_name}"
else
  printf 'Installed DB-IP Lite Country %s; restart skipped\n' "${release_month}"
fi
