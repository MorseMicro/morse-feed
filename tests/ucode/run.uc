// Runs test_*.uc in a tests directory; each returns an object of zero-arg test
// functions. A test PASSES if it returns, FAILS if it throws. Exits non-zero on
// any failure. Invoked by run-tests.sh, which wires the -L search paths:
//     ucode [-L <abs stub glob>] -L "<tests-dir>/*.uc" run.uc <tests-dir>
"use strict";
import { lsdir } from "fs";

const testsdir = ARGV[0];
if (!testsdir) {
	warn("usage: ucode ... run.uc <tests-dir>\n");
	exit(2);
}

let pass = 0, fail = 0;
for (let f in lsdir(testsdir)) {
	if (index(f, "test_") !== 0 || !match(f, /\.uc$/)) {
		continue;
	}
	const tests = require(substr(f, 0, -3));  // strip ".uc"; test files end in `return {..}` -> require
	for (let name, testfn in tests) {
		print(`${f}:${name} ... `);
		try {
			testfn();
			print("OK\n");
			pass += 1;
		} catch (e) {
			print("FAIL -- ", e.message, "\n");
			if (e.stacktrace && e.stacktrace[0])
				print("    ", e.stacktrace[0].context, "\n");
			fail += 1;
		}
	}
}

print(`\n${pass} / ${pass + fail} tests passed\n`);
if (fail)
	print("THERE ARE TEST FAILURES!!!\n");

exit(fail ? 1 : 0);
