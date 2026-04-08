# Refactor: LeanSessionManager + LevelEvaluator

## Motivation

The current code has unclear modularity boundaries that make it janky and
hard to debug. Two specific pain points:

1. **Lean session management** is mixed with domain orchestration.
   `LeanRpcSession.getGoals` is a transport-layer class but takes a
   `preludeLineCount` argument and knows how to call the custom `getHypKinds`
   method that is defined in a preamble it doesn't own.

2. **Level evaluation** is smeared across `App.tsx`. `proofComplete` is set
   in three different places (`sendInitialCode`, `onBlocklyChange`,
   `onDiagnosticsUpdate`) which can race and demote a successful state.
   Per-block status computation, line-mapping arithmetic, and the win
   condition all live as ad-hoc code in the React component.

## Target architecture

Two layers, with strict responsibilities:

### LeanSessionManager (transport)

Replaces `LeanRpcSession` + `LeanSession`. Knows nothing about preambles,
levels, line counts, or specific Lean RPC methods.

```ts
class LeanSessionManager {
  // Resolves once the LSP handshake is done and the session is usable.
  whenReady(): Promise<void>

  // Update a virtual file in the LSP workspace. Sends didOpen the first
  // time we see a URI, didChange thereafter. Accepts arbitrary URIs so
  // callers can split content across multiple files.
  updateFile(uri: string, content: string): Promise<void>

  // Wait until Lean has finished elaborating the most recent edit
  // (i.e. fileProgress reports `processing: []`).
  waitForProcessing(uri: string): Promise<void>

  // Subscribe to raw per-range fileProgress updates for a URI. Each
  // entry describes a line range still being elaborated, with an
  // optional `kind` (1 = Processing, 2 = FatalError). Not used by the
  // first cut of LevelEvaluator, but exposed so future work can do
  // incremental UI updates and exploit multi-file splits where the
  // preamble lives in a separately-imported file and only the
  // contribution's ranges need to clear.
  onProgress(
    uri: string,
    cb: (processing: Array<{ range: Range; kind?: number }>) => void,
  ): Disposable

  // Pull current LSP diagnostics for a URI.
  getDiagnostics(uri: string): LspDiagnostic[]

  // Generic Lean widget RPC. Caller supplies the method name and params;
  // session connect/keepalive is handled internally.
  widgetRpcCall<T>(
    uri: string,
    method: string,
    params: unknown,
    position?: { line: number; character: number },
  ): Promise<T>
}
```

Notes:
- No `setDiagnosticsCallback`. Diagnostics are pulled, not pushed.
- `widgetRpcCall` takes care of `$/lean/rpc/connect`, keepalive, and
  retry on `Outdated RPC session` internally.
- The single-file simplification of the current code is generalized to
  per-URI state (document version, open status, last content). Even
  though `LevelEvaluator` will only use one URI at first, the API
  permits multiple.

### LevelEvaluator (domain)

New module. Owns the preamble (currently inlined in `App.tsx`), knows
about contribution-vs-full-source coordinate translation, and is the
single source of truth for "what is the state of the player's proof."

```ts
// A position in the player's contribution (not in the full Lean source).
interface ContributionPosition { line: number; character: number }
interface ContributionRange   { start: ContributionPosition; end: ContributionPosition }

interface LeafGoal {
  position: ContributionPosition  // location of the hole/leaf
  goal: InteractiveGoal           // with hypKindMap merged in
}

interface EvaluationResult {
  diagnostics: Array<{
    range: ContributionRange
    severity: number
    message: string
  }>
  // One entry per unfinished leaf in the proof tree (one per `sorry` or
  // unsolved tactic state). May be empty if the proof is complete.
  leafGoals: LeafGoal[]
  // Convenience: true iff there are no error diagnostics and no leafGoals.
  complete: boolean
}

class LevelEvaluator {
  constructor(session: LeanSessionManager /*, future: per-level config */)

  // Atomic round trip: take the player's contribution text, return
  // diagnostics + leaf goals in contribution-relative coordinates.
  evaluate(contribution: string): Promise<EvaluationResult>
}
```

Responsibilities of `evaluate()`:

1. Construct the full Lean source: `prelude + contribution` (concatenation
   for now; the multi-file capability of `LeanSessionManager` is left for
   a future improvement).
2. `session.updateFile(uri, fullSource)` and `session.waitForProcessing()`.
3. Pull `session.getDiagnostics(uri)`, filter to severity-error, and
   translate ranges from full-source coordinates to contribution
   coordinates by subtracting `preludeLineCount`. Drop any diagnostic
   that lies inside the preamble.
4. Call `Lean.Widget.getInteractiveDiagnostics` via
   `session.widgetRpcCall` to extract `InteractiveGoal`s. For each goal
   that has a `ctx` and `mvarId`, call `getHypKinds` (also via
   `widgetRpcCall`, at the position just past the preamble) and merge
   `isAssumption` into the hypotheses.
5. Translate each goal's source position back to a contribution position
   to produce a `LeafGoal`. (At this stage of the refactor, "leaf goals"
   are simply the goals returned by `getInteractiveDiagnostics` — one
   list, no per-leaf injection yet. The data shape is already correct
   for the future "sorry-per-hole" enhancement.)

## Wiring App.tsx

After the refactor, `App.tsx` should:

- Hold `nav`, `levelStates`, and a single `evaluation: EvaluationResult | null`
  state (replacing `goals`, `hypKindMap`, `proofComplete`, `diagnostics`).
- On Blockly change: convert the workspace to Lean source, then call
  `levelEvaluator.evaluate(contribution)`. Use a cancel-in-flight
  pattern (see below) so only the latest result reaches `setState`.
- Render directly from `evaluation`: the proof status banner, the goal
  panel, and the per-block statuses are all derived from the single
  result. The win-condition check (`evaluation.complete`) lives nowhere
  else.

### Cancel-in-flight semantics

Every `evaluate()` call gets an associated sequence number. App.tsx
keeps a `latestSeqRef`. When a Blockly change kicks off a new
evaluation, the sequence number is incremented; when the promise
resolves, the result is dropped if its sequence number is no longer
current.

The first cut does not actually cancel the in-flight LSP work — Lean
will keep elaborating the older edit. But because each `updateFile`
supersedes the previous version and `waitForProcessing` only resolves
on the *latest* edit, the obsolete promise will simply resolve to the
new state, and the sequence guard prevents stale `setState`. A future
improvement could add real abort propagation.

## What gets dropped

- `LeanRpcSession.setDiagnosticsCallback` and the push-based diagnostics
  flow. Diagnostics flow only through `evaluate()`.
- `LeanRpcSession.getGoals` (its work is now split between
  `LeanSessionManager.widgetRpcCall` and `LevelEvaluator.evaluate`).
- The `prelude` constant in `App.tsx` (moves into `LevelEvaluator`).
- Manual `preludeLineCount` recomputation at every call site.
- The `latestGoalsRef`, `latestSourceInfoRef`, and `onDiagnosticsUpdate`
  machinery in `App.tsx`. (Per-block status mapping moves to the
  evaluator, which has the line offset and source info readily
  available — though sourceInfo is currently produced by
  `workspaceToLean` and consumed only by the per-block status code.
  See open question below.)

## Out of scope for this refactor

- **Sorry-per-hole leaf goals.** The `EvaluationResult` shape supports
  multiple leaf goals, but actually injecting `sorry` at every empty
  Blockly slot requires changes to `workspaceToLean` and is a follow-up.
- **Multi-file virtual filesystem use.** `LeanSessionManager` exposes
  per-URI APIs, but `LevelEvaluator` will keep concatenating
  `prelude + contribution` into one file for now. Splitting them into
  `Preamble.lean` + `Blockly.lean` is a future improvement that would
  also fix the "preamble re-elaborated on every edit" cost noted in
  Architecture.md.
- **Per-level win conditions.** The current hardcoded condition
  ("no error diagnostics and no remaining goals") is centralized but
  not generalized. Per-level declarative win conditions are a follow-up
  if the beta customer needs them.
- **Real abort propagation** for in-flight evaluations.
- **Multi-file split + per-range progress consumption.** The natural
  next refactor: put the preamble in `Preamble.lean`, have
  `Blockly.lean` `import Preamble`, and have `LevelEvaluator` consume
  the per-range `onProgress` stream so it can wait specifically for
  the contribution file's ranges to clear (and eventually surface
  per-block "checked" status as ranges drop out). Requires verifying
  that Lean's LSP resolves imports across virtual documents — see
  the same note in `doc/Architecture.md`. The `LeanSessionManager`
  API exposed by this refactor is shaped to make that follow-up a
  drop-in.

## Open questions to resolve during implementation

1. **Where does `sourceInfo` (block ↔ line/col map) live?** It is
   produced by `workspaceToLean` in App.tsx and currently consumed by
   `onDiagnosticsUpdate` to highlight individual blocks. Two options:
   (a) `App.tsx` keeps producing `sourceInfo` and passes it to
   `evaluate(contribution, sourceInfo)`, which adds a per-block
   `statuses` field to `EvaluationResult`; or (b) per-block statuses
   are computed in App.tsx after `evaluate()` returns, by mapping
   `evaluation.diagnostics` against `sourceInfo`. Option (b) keeps
   `LevelEvaluator` ignorant of Blockly. Probably go with (b).

2. **In-place rewrite vs. new files.** Lean toward in-place: rename
   `LeanRpcSession.ts` → `LeanSessionManager.ts` and rewrite its
   contents; create a new `LevelEvaluator.ts`; delete `LeanSession.ts`
   (its singleton role can move into a small init in `main.tsx` or be
   absorbed into `LeanSessionManager`).

## Order of work

1. Build `LeanSessionManager` (rewrite of `LeanRpcSession`). Verify by
   wiring it through the existing `App.tsx` temporarily — the old
   high-level `getGoals` logic moves into a small adapter so the app
   keeps working before `LevelEvaluator` exists.
2. Build `LevelEvaluator` on top of `LeanSessionManager`. Unit-test it
   manually by exercising it from a scratch script if practical;
   otherwise verify via the app in step 3.
3. Rewrite `App.tsx` to consume `LevelEvaluator` directly. Delete the
   adapter from step 1.
4. Update `doc/Architecture.md` to describe the new boundary.
