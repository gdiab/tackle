# Decisions

Dated, ID'd, with rejected alternatives. Survives session resets. (The spec's own `decisions.md` mechanism, applied to building the harness itself.)

## D-001 · 2026-07-02 · Tackle is a TypeScript CLI

Files on disk for state (`.tackle/` in the target repo), per-phase invocation, no daemon. **Rejected:** Python CLI (weaker fit with the TS-native prior art and pty tooling); daemon (earns nothing while attended-first).

## D-002 · 2026-07-02 · Sandcastle: borrow the shape, don't build on it

Spike: [docs/spikes/2026-07-02-sandcastle.md](docs/spikes/2026-07-02-sandcastle.md). Adopt its provider decomposition (command builder + line parser + session storage + usage parser), CLI recipes, session semantics, and usage normalization. **Rejected:** building on it — billing-type assertion contradicts its wontfixed auth model, `noSandbox()` bypasses its env allowlist exactly where Tackle v1 lives, and its throw/signal result shape maps lossily onto the closed `status` enum. **Rejected:** ignoring it — it's the best prior art and stays the reference to diff against for CLI flag drift.

## D-003 · 2026-07-02 · Issue tracking in beads (`bd`), not markdown todo files

Dependency-aware, `bd ready` surfaces unblocked work, prefix `tackle-`. **Rejected:** `tasks/todo.md` (no dependency model, no agent-claimable queue).
