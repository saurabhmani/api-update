# Backtest Worker CI reliability report

Status: **blocked / not executed**.

The Linux GitHub Actions job is defined and remains non-blocking. This checkout has a public GitHub remote, but no GitHub CLI or authenticated Actions control, and the milestone changes are uncommitted. Repeated authoritative workflow runs therefore could not be dispatched from this environment.

No flake rate, duration variance, or cross-run artifact consistency is claimed. The machine-readable report is `artifacts/backtest-ci-reliability-report.json`.

Required evidence before staging approval:

1. Run the unchanged `backtest-worker-integration` job at least three consecutive times on the same reviewed commit.
2. Record job and phase durations.
3. Hash parity, rollback, two-process, preflight, authorization, and fixture artifacts.
4. Classify every failure as product, infrastructure, or flaky-test failure.
5. Calculate `flake rate = flaky failed runs / total runs`.
6. Obtain team approval before making the job blocking.

