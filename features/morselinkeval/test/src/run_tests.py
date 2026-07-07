#!/usr/bin/env python3
"""Analytics cross-check: Python source of truth  vs  the ucode port.

Feeds the SAME fixtures (test/data/fixtures.json) to both analytics layers and
compares their JSON wire bodies field-by-field. The prediction algorithm is what
must stay identical between halow_link_quality's common/analytics.py and the
package's analytics.uc; this test is what catches drift when either is updated.

Both sides call only the public analytics entry points (PeerAnalytics /
PlannerAnalytics) — no collection, no ubus, no display — so a diff here is a real
divergence in the prediction math, not in the plumbing.

Comparison policy: exact for ints / strings / bools; epsilon-tolerant for floats
(absorbs harmless last-digit differences between Python floats and ucode doubles).

Exit codes: 0 = all scenarios matched (or ucode not installed -> skipped),
            1 = at least one mismatch, 2 = setup/run error.

Usage:  python3 run_tests.py
Env:    HALOW_PY_SRC  override path to the halow_link_quality_metric repo
                      (defaults to the src/pysrc symlink; if that is missing the
                      repo is cloned automatically — see PY_REPO_* below).
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))                 # test/src
TEST = os.path.dirname(HERE)                                      # test/
FIXTURES = os.path.join(TEST, "data", "fixtures.json")
STUBS = os.path.join(HERE, "stubs")
RUN_UC = os.path.join(HERE, "run_uc.uc")
# Package ucode root (contains morselinkeval/): test/../files/usr/share/ucode
PKG_UCODE_ROOT = os.path.normpath(os.path.join(TEST, "..", "files", "usr", "share", "ucode"))
# Python source of truth: env override, else the src/pysrc symlink.
PY_SRC = os.environ.get("HALOW_PY_SRC") or os.path.join(HERE, "pysrc")

# When PY_SRC is missing (the src/pysrc symlink is not checked out), clone the
# halow_link_quality_metric repo automatically at this exact ref. Bump PY_REPO_REF
# when the port is realigned to a newer source-of-truth revision.
PY_REPO_URL = "git@bitbucket.org:morsemicro/halow_link_quality_metric.git"
PY_REPO_REF = "APP-7122"
# Local checkout location used only when PY_SRC is unavailable (kept out of the
# tree next to run_tests.py so repeated runs reuse it).
PY_SRC_CLONE = os.path.join(HERE, ".pysrc-clone")

FLOAT_ABS_TOL = 1e-6
FLOAT_REL_TOL = 1e-6

# Top-level wire-body keys that are NOT part of the prediction algorithm and are
# therefore excluded from the comparison. `current` is the peer's last-seen rx/tx
# bitrate — a raw passthrough of nl80211 counters that the ucode peer_result()
# echoes and the Python analytics does not surface; it is not a computed
# prediction, so a structural difference there is out of scope for this test.
IGNORE_KEYS = {"current"}


def strip_non_prediction(body):
    """Drop non-prediction top-level keys so the diff focuses on the algorithm."""
    if isinstance(body, dict):
        return {k: v for k, v in body.items() if k not in IGNORE_KEYS}
    return body


def die(msg, code=2):
    print(msg)
    sys.exit(code)


# --- Python side ------------------------------------------------------------

def _looks_like_py_src(path):
    """A usable source-of-truth checkout has the common/ analytics package."""
    return os.path.isdir(os.path.join(path, "common"))


def ensure_py_src():
    """Return a path to a usable halow_link_quality_metric checkout.

    Prefers PY_SRC (env override or the src/pysrc symlink). If that is missing —
    e.g. the symlink target isn't checked out on this machine — clone the repo at
    PY_REPO_REF into PY_SRC_CLONE and use that. A stale/incomplete clone is
    refreshed (fetch + checkout) rather than re-cloned.
    """
    if _looks_like_py_src(PY_SRC):
        return PY_SRC

    if shutil.which("git") is None:
        die(f"[ERROR] Python source not found at {PY_SRC} and 'git' is not "
            f"available to clone {PY_REPO_URL}.\n"
            f"        Set HALOW_PY_SRC or fix the src/pysrc symlink.")

    if _looks_like_py_src(PY_SRC_CLONE):
        print(f"Reusing cached clone at {PY_SRC_CLONE} (ref {PY_REPO_REF}).")
        _git(["fetch", "--depth", "1", "origin", PY_REPO_REF], cwd=PY_SRC_CLONE)
        _git(["checkout", "FETCH_HEAD"], cwd=PY_SRC_CLONE)
    else:
        print(f"Python source not found at {PY_SRC}; cloning "
              f"{PY_REPO_URL} @ {PY_REPO_REF} -> {PY_SRC_CLONE}")
        if os.path.exists(PY_SRC_CLONE):
            shutil.rmtree(PY_SRC_CLONE)
        _git(["clone", "--depth", "1", "--branch", PY_REPO_REF,
              PY_REPO_URL, PY_SRC_CLONE])

    if not _looks_like_py_src(PY_SRC_CLONE):
        die(f"[ERROR] clone at {PY_SRC_CLONE} is missing the common/ package "
            f"(ref {PY_REPO_REF}).")
    return PY_SRC_CLONE


def _git(argv, cwd=None):
    """Run a git command, dying with its stderr on failure."""
    r = subprocess.run(["git"] + argv, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"[ERROR] git {' '.join(argv)} failed (exit {r.returncode})\n"
            f"--- stderr ---\n{r.stderr}")


def run_python_side(scenarios, py_src):
    """Run every scenario through the Python analytics and return
    {name: wire_body}. Imports only common.analytics (thanks to summary())."""
    sys.path.insert(0, py_src)
    from common import analytics

    out = {}
    for sc in scenarios:
        samples = sc["samples"]
        if sc["kind"] == "peer":
            pa = analytics.PeerAnalytics(sc["chip"])
            out[sc["name"]] = pa.peer_result(pa.summary(samples))
        elif sc["kind"] == "planner":
            pa = analytics.PlannerAnalytics(sc["chip"])
            p = sc["planner"]
            estimate = pa.planning_estimate({
                "tx_power_dbm":   p["tx_power_dbm"],
                "freq_mhz":       p["freq_mhz"],
                "bw_mhz":         sc["bw_mhz"],
                "distance_m":     p.get("distance_m"),
                "attenuation_db": p.get("attenuation_db"),
                "fade_margin_db": p.get("fade_margin_db"),
            })
            out[sc["name"]] = pa.planning_result(estimate, sc["bw_mhz"], pa.summary(samples))
        else:
            die(f"[ERROR] unknown scenario kind '{sc['kind']}' in '{sc['name']}'")
    return out


# --- ucode side -------------------------------------------------------------

def run_ucode_side():
    """Invoke run_uc.uc under native ucode and return the parsed {name: body}."""
    cmd = ["ucode", "-R", "-L", STUBS, "-L", PKG_UCODE_ROOT, RUN_UC, FIXTURES]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"[ERROR] ucode runner failed (exit {r.returncode})\n"
            f"        cmd: {' '.join(cmd)}\n--- stderr ---\n{r.stderr}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError as e:
        die(f"[ERROR] ucode output was not valid JSON: {e}\n"
            f"--- stdout ---\n{r.stdout}\n--- stderr ---\n{r.stderr}")


# --- Comparison -------------------------------------------------------------

def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def diff(py, uc, path):
    """Field-by-field diff -> list of human-readable difference strings (empty
    list means equal). Numbers compare with tolerance; everything else exact."""
    if _is_num(py) and _is_num(uc):
        if abs(py - uc) > FLOAT_ABS_TOL + FLOAT_REL_TOL * max(abs(py), abs(uc)):
            return [f"{path}: py={py} uc={uc}"]
        return []
    if isinstance(py, bool) or isinstance(uc, bool):
        return [] if py is uc else [f"{path}: py={py!r} uc={uc!r}"]
    if isinstance(py, dict) and isinstance(uc, dict):
        out = []
        for k in sorted(set(py) | set(uc)):
            if k not in py:
                out.append(f"{path}.{k}: missing on Python (uc={uc[k]!r})")
            elif k not in uc:
                out.append(f"{path}.{k}: missing on ucode (py={py[k]!r})")
            else:
                out += diff(py[k], uc[k], f"{path}.{k}")
        return out
    if isinstance(py, list) and isinstance(uc, list):
        if len(py) != len(uc):
            return [f"{path}: list length py={len(py)} uc={len(uc)}"]
        out = []
        for i, (a, b) in enumerate(zip(py, uc)):
            out += diff(a, b, f"{path}[{i}]")
        return out
    if py != uc:
        return [f"{path}: py={py!r} uc={uc!r}"]
    return []


def _verdict(body):
    """One-line human summary of a wire body, for the PASS/FAIL log."""
    if not body:
        return ""
    mq = body.get("mcs_quality") or {}
    typ = mq.get("typical") or {}
    ls = body.get("link_stability") or {}
    flags = [k.replace("_detected", "").replace("_suspected", "")
             for k in ("cellular_suspected", "in_channel_detected", "close_channel_detected",
                       "same_channel_detected", "adjacent_channel_detected")
             if ls.get(k)]
    bits = []
    if typ:
        bits.append(f"typical MCS{typ.get('max_mcs')} {typ.get('quality')}")
    if ls:
        bits.append("impacted" if ls.get("impacted") else "stable")
    if flags:
        bits.append("intf:" + ",".join(flags))
    return "  (" + "; ".join(bits) + ")" if bits else ""


def main():
    if shutil.which("ucode") is None:
        print("ucode not installed on this machine — skipping analytics cross-check.")
        sys.exit(0)
    if not os.path.isfile(FIXTURES):
        die(f"[ERROR] fixtures not found: {FIXTURES}")

    scenarios = json.load(open(FIXTURES))["scenarios"]
    py_src = ensure_py_src()
    py = run_python_side(scenarios, py_src)
    uc = run_ucode_side()

    print("Analytics cross-check:  Python (source of truth)  vs  ucode port")
    print(f"  fixtures : {os.path.relpath(FIXTURES)}")
    print(f"  py source: {py_src}")
    print(f"  ucode    : -L {os.path.relpath(STUBS)} -L {os.path.relpath(PKG_UCODE_ROOT)}")
    print(f"  compared : prediction wire body (excluding {sorted(IGNORE_KEYS)} — raw passthrough, not prediction)")
    print("-" * 78)

    n_fail = 0
    for sc in scenarios:
        name = sc["name"]
        d = diff(strip_non_prediction(py.get(name)), strip_non_prediction(uc.get(name)), name)
        if d:
            n_fail += 1
            print(f"FAIL  {name}")
            for line in d:
                print(f"        {line}")
        else:
            print(f"PASS  {name}{_verdict(py.get(name))}")
    print("-" * 78)
    total = len(scenarios)
    print(f"{total - n_fail}/{total} scenarios matched"
          + ("" if n_fail else "  — Python and ucode analytics agree."))
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
