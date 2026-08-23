#!/bin/sh
set -eu

curl -fsS http://127.0.0.1:8080/__stats | python3 -m json.tool
