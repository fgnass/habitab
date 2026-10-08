#!/bin/bash
# Runs unit checks and the integration tests against a separate Habitab
# instance (own HABITAB_HOME and socket). Real client configurations are
# only read; the installer test works on sandbox copies.
set -euo pipefail
cd "$(dirname "$0")"
swift build --product habitab
swift run habitab-selftest
export HABITAB_BIN="$PWD/.build/debug/habitab"
export TEST_TMP="${TEST_TMP:-$(mktemp -d)}"
# AF_UNIX paths are limited to 104 bytes; keep the test socket short.
export HABITAB_SOCKET="${HABITAB_SOCKET:-/tmp/hb-test-$$.sock}"
export HABITAB_SOCKET_TEST="${HABITAB_SOCKET_TEST:-/tmp/hb-proto-$$.sock}"
node Tests/integration/lifecycle.mjs
node Tests/integration/protocol.mjs
node Tests/integration/install.mjs
