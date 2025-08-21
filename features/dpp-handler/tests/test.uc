// Mini test runner for ucode.
//
// (NB there is a test runner in the ucode repo, but it's designed more for
// self-contained language tests than persistent scaffolding/mocks)
//
// Run tests with a locally compiled copy of ucode (no need for other libs) via:
//   ucode test.uc
"use strict";
import { lsdir, chdir, dirname } from "fs";

chdir(dirname(ARGV[0]));
push(REQUIRE_SEARCH_PATH, "./tests/*.uc");

let success = 0, fail = 0;
for (let testfile in lsdir("tests")) {
	if (index(testfile, "test_") !== 0) {
		continue;
	}
	const tests = require(`${substr(testfile, 0, -3)}`);
	for (let name, testfn in tests) {
		print(`${testfile}:${name}... `);
		try {
			testfn();
			print("OK\n");
			success += 1;
		} catch (e) {
			print("FAIL -- ", e.message, "\n");
			print(e.stacktrace[0].context, "\n");
			fail += 1;
		}
	}
}

print(`\n${success} / ${success + fail} tests passed\n`);
if (fail) {
	print("THERE ARE TEST FAILURES!!!\n");
}

return 1;
