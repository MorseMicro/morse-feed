# morselinkeval analytics cross-check

Verifies that the **prediction algorithm** stays identical between the two
implementations of it:

- **Python (source of truth):** `halow_link_quality_metric/common/analytics.py`
- **ucode port (this package):** `files/usr/share/ucode/morselinkeval/analytics.uc`

The Python tool gets features/fixes first; this package is updated to match. This
test is what catches drift between the two when either changes.

## What it does

Feeds the **same** fixture samples to both analytics layers and compares their
JSON output field-by-field:

```
data/fixtures.json ──same samples──> Python  PeerAnalytics/PlannerAnalytics ─┐
                    └───────────────> ucode   PeerAnalytics/PlannerAnalytics ─┴─> deep compare → PASS/FAIL
```

Both sides call only the public analytics entry points (`summary()` +
`peer_result()` / `planning_result()`) — collection, ubus, SSH and display are
all bypassed, so a mismatch is a real divergence in the prediction math, not the
plumbing.

## Requirements

Everything runs **natively on a laptop** — no device, no OpenWrt image, no cross
compile. You need two things on `PATH`:

| Tool | Why | Version tested |
|------|-----|----------------|
| `python3` | driver (`run_tests.py`) + Python source of truth. **Standard library only** — no `pip install`, no venv. | 3.8+ |
| `ucode` + native `fs` and `math` modules | runs the ucode port (`run_uc.uc` imports `fs`; `analytics.uc` imports `math` for FSPL). | 0.0.20250529 |

Plus the **Python source of truth** repo (`halow_link_quality_metric`) reachable
via the `src/pysrc` symlink or `HALOW_PY_SRC` (see [Design notes](#design-notes)).

The `log` native module is **not** required — `run_tests.py` points ucode at
`src/stubs/log.uc`, which shadows it (the on-device `log` is ubox `ulog`, absent
on a laptop). `math`/`fs` still resolve to the real native modules, so the
propagation math is exact.

### Installing ucode

**Debian / Ubuntu / WSL (apt)** — the simplest path; `ucode-modules` is what
ships the `fs.so` and `math.so` the test needs, so install **both** packages:

```bash
sudo apt update
sudo apt install ucode ucode-modules
```

> On Ubuntu, `ucode` lives in the *universe* component — enable it first with
> `sudo add-apt-repository universe` if the package isn't found.

**Verify** the interpreter and the two required modules are wired up:

```bash
command -v ucode                                   # -> /usr/bin/ucode
ucode -R -p 'import { log } from "math"; print("math ok\n")'
ucode -R -p 'import { readfile } from "fs"; print("fs ok\n")'
```

**Build from source** (other distros, or to match a specific device version) —
ucode is a small CMake project. Build the interpreter *with* the `fs` and `math`
modules enabled:

```bash
git clone https://github.com/jow-/ucode.git
cd ucode
cmake -B build -DFS_SUPPORT=ON -DMATH_SUPPORT=ON \
      -DULOOP_SUPPORT=OFF -DUBUS_SUPPORT=OFF -DUCI_SUPPORT=OFF \
      -DRTNL_SUPPORT=OFF -DNL80211_SUPPORT=OFF
cmake --build build
sudo cmake --install build      # or run ./build/ucode straight from the tree
```

The device-only modules (`ubus`, `uloop`, `uci`, `nl80211`, `rtnl`, `log`) are
turned **off** on purpose — this test never touches them.

## Run

```bash
cd test/src
python3 run_tests.py
```

- Runs natively on a laptop; **skips cleanly (exit 0) if `ucode` is not installed.**
- Exit codes: `0` all matched (or skipped), `1` a mismatch, `2` setup error.
- Point at a Python source tree that isn't beside this repo:
  ```bash
  HALOW_PY_SRC=/path/to/halow_link_quality_metric python3 run_tests.py
  ```

Expected output (one line per scenario in `data/fixtures.json`):

```
Analytics cross-check:  Python (source of truth)  vs  ucode port
  ...
PASS  quality_excellent_mm8108  (typical MCS9 Excellent; stable)
PASS  stability_impacted_mm8108  (typical MCS3 Moderate; impacted)
...
15/15 scenarios matched  — Python and ucode analytics agree.
```

A `FAIL` line lists the exact field path and both values (`py=… uc=…`), so a
divergence points straight at the drifting field.

## Layout

```
test/
├── data/fixtures.json   scenarios (Link Quality / Stability / Planner, MM8108 & MM6108), 5 samples each
└── src/
    ├── run_tests.py      driver: runs both sides, compares, prints PASS/FAIL   ← entry point
    ├── run_uc.uc         ucode runner: fixtures → analytics.uc → JSON
    ├── stubs/log.uc      stub for the native `log` (ubox ulog) module, absent on a laptop
    └── pysrc -> ../../../../../../multiverse/halow_link_quality_metric   (Python source of truth)
```

## Design notes

- **Python reference path.** Defaults to the `src/pysrc` symlink. Override with
  `HALOW_PY_SRC=/path/to/halow_link_quality_metric python3 run_tests.py`
  (e.g. in CI, or if the repos aren't checked out side by side).
- **`log` stub, not `math`.** `analytics.uc` imports `log` (ubox `ulog`, absent
  in a native x86 ucode) and `math` (real `log()` for FSPL). The stub shadows
  only `log`; `math` resolves to the real native module so the propagation math
  is exact. `run_tests.py` passes `-L src/stubs -L <pkg ucode root>` to ucode.
- **Comparison policy.** Exact for ints/strings/bools; small epsilon for floats
  (absorbs harmless last-digit differences between Python floats and ucode
  doubles). See `FLOAT_ABS_TOL` / `FLOAT_REL_TOL`.
- **`current` is excluded** (`IGNORE_KEYS`). The peer wire body's `current`
  block is the last-seen rx/tx bitrate — a raw nl80211 passthrough that the
  ucode side echoes and the Python analytics doesn't surface. It isn't a
  prediction, so it's out of scope here. Everything else in the wire body
  (`rssi`, `noise`, `mcs_quality`, `link_stability`, planner `estimate`) is
  compared in full.
- **Window size.** Each runner uses `window = len(samples)` so the whole fixture
  is the analysis window (the on-device default is 40); 5 samples per scenario is
  plenty to make the two implementations agree or disagree.

## Adding a scenario

Add an object to `scenarios` in `data/fixtures.json`:

```jsonc
{
  "name": "my_case",
  "description": "what it exercises",
  "kind": "peer",              // or "planner"
  "chip": "MM8108",            // or "MM6108"
  "bw_mhz": 8,                 // planner: forced bandwidth; peer: informational
  "planner": {                 // planner only
    "tx_power_dbm": 20, "freq_mhz": 915, "distance_m": 100, "fade_margin_db": 10
  },
  "samples": [ { "rssi": -55, "max_noise": -95, "current_bw_mhz": 8, ... } ]  // 5 samples
}
```

Sample fields are the `collect.uc` `Sample` schema (rssi, rx_power, max_noise,
current_bw_mhz, detected_bw_hz, agc_false_trigger[_gc], agc_intrf_detected,
corr2s_energy, nb_intrf_detected, rx_ndp_not_for_us, stf_pd_fired, ltf_pd_fired,
…). Omitted fields read as null on both sides.
