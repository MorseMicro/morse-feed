#!/usr/bin/env sh
#
# Runs morse-feed ucode unit tests via run.uc, one ucode process per package.
# Exit 0 = all passed. Native-module stubs (if any) are passed as ABSOLUTE -L
# globs, because relative -L patterns are re-based per compiled file.
#
#     run-tests.sh                 # run the registered packages
#     run-tests.sh <dir> [<dir>..] # run given dirs (relative to feed root, or absolute)
set -eu

FEED="$(cd "$(dirname "$0")/../.." && pwd)"   # morse-feed root (absolute)
RUNNER="$FEED/tests/ucode/run.uc"

rc=0

run_pkg() {
	tests="$1"; shift
	L=""
	for g in "$@"; do L="$L -L $g"; done
	echo "== ${tests#"$FEED"/} =="
	# shellcheck disable=SC2086
	if ucode $L -L "$tests/*.uc" "$RUNNER" "$tests"; then
		:
	else
		rc=1
	fi
	echo
}

# Registered packages (neither needs native-module stubs).
run_default_pkgs() {
	run_pkg "$FEED/features/dpp-handler/tests"
	run_pkg "$FEED/luci/luci-app-morseupgrade/tests"
}

if [ "$#" -gt 0 ]; then
	for arg in "$@"; do
		case "$arg" in
			/*) dir="$arg" ;;
			*)  dir="$FEED/$arg" ;;
		esac
		if [ ! -d "$dir" ]; then
			echo "run-tests.sh: no such tests dir: $arg" >&2
			rc=1
			continue
		fi
		run_pkg "$dir"
	done
else
	run_default_pkgs
fi

exit $rc
