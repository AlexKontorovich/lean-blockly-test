# Architecture

## Overview

This project is a blockly-based "lean game" interface that lets users construct
tactic proofs by dragging and dropping blocks. It communicates with a Lean
language server to check proofs and display goal states.

```
Browser (React + Blockly)
  ↕ WebSocket (JSON-RPC)
Node.js relay (server/index.mjs)
  ↕ stdin/stdout (JSON-RPC)
Lean server (lake serve)
```

## Startup Sequence

### 1. Process startup

`npm run start` launches two processes via `concurrently`:

- **server** (`server/index.mjs`): Express + WebSocket server on port 8080.
  In dev mode, runs under `nodemon` for auto-restart.
- **client** (`vite`): Dev server on port 3000. Proxies `/websocket/*` requests
  to port 8080 (configured in `vite.config.ts`).

At this point the Lean server is **not** running. It only starts when a browser
connects.

### 2. Browser connects

When the React app loads:

1. `App.tsx` mounts and its `useEffect` calls `lspConnect(wsUrl)` from
   `LeanLspClient.ts`.
2. This opens a WebSocket to `/websocket/MathlibDemo` (proxied via Vite to
   port 8080).
3. `server/index.mjs` handles the connection event and **spawns `lake serve --`**
   in `Projects/MathlibDemo/`. This is a child process with JSON-RPC on
   stdin/stdout.
4. The server sets up bidirectional message forwarding between the WebSocket
   and the Lean process, with URI rewriting (client uses virtual URIs like
   `file:///blockly/Blockly.lean`, server translates to real filesystem paths).

### 3. LSP handshake

`LeanLspClient.ts` sends the standard LSP `initialize` request, waits for the
response, then sends `initialized`. After this the connection is live and ready
for document operations.

### 4. Document processing (the big wait)

When blockly blocks change (or on first load):

1. `App.tsx` calls `workspaceToLean()` to convert blocks to Lean tactic code.
2. It prepends the **preamble** (see below) and sends the full code via
   `LeanRpcSession.getGoals(fullCode)`.
3. `LeanRpcSession` sends `textDocument/didOpen` (first time) or
   `textDocument/didChange` (subsequent) to the Lean server.
4. The Lean server begins elaborating. This includes importing Mathlib —
   the dominant cost on first load.
5. `$/lean/fileProgress` notifications arrive periodically. When
   `processing: []` arrives, elaboration is complete.

### 5. RPC session and goal extraction

Once processing is complete:

1. `$/lean/rpc/connect` — establishes an RPC session (returns a session ID).
   A keepalive must be sent every 10 seconds.
2. `Lean.Widget.getInteractiveDiagnostics` — fetches diagnostics with embedded
   interactive goal data. Goals from `sorry` or unsolved tactic states appear
   as embedded `InteractiveGoal` objects inside the diagnostic message tree.
3. `getHypKinds` (custom, see below) — classifies each hypothesis as
   "object" or "assumption".

## The Preamble

The preamble is a block of Lean code prepended to the user's proof before
sending to the server. It lives in the `prelude` string in `App.tsx`. It
contains:

- `import Mathlib` — makes all of Mathlib available.
- Domain-specific definitions (e.g. `FunLimAt`).
- Custom RPC infrastructure for hypothesis classification (see next section).

Because the preamble is part of the document, it gets re-elaborated on every
`didChange`. The line count of the preamble is tracked so that diagnostic
line numbers can be mapped back to blockly block positions.

**Future improvement:** Use `textDocument/didOpen` to create a second virtual
file containing the preamble, and `import` it from the main file. This would
avoid re-elaborating the preamble on every edit. Requires investigation into
whether Lean's LSP resolves imports from virtual documents.

## Hypothesis Classification (isAssumption)

### The problem

Lean's standard `InteractiveHypothesisBundle` includes `isType` and `isInstance`
fields but no `isAssumption` / `isProp` field. We want to visually separate:

- **Objects**: term variables like `x : Nat`, `f : R -> R` (type is a Type/Sort)
- **Assumptions**: propositional hypotheses like `h : x > 0` (type is a Prop)

### The approach

We define a `@[server_rpc_method]` directly in the preamble. Because Lean's
`@[server_rpc_method]` attribute registers an RPC method at elaboration time,
it becomes callable at any position after it has been elaborated. No server-side
package or server code changes are needed.

The method (`getHypKinds`) takes:

- `ctx : WithRpcRef ContextInfo` — an opaque reference to the elaboration
  context, obtained from the `ctx` field of an `InteractiveGoal` returned by
  the standard `getInteractiveDiagnostics`.
- `mvarId : String` — the metavariable ID of the goal, also from the standard
  `InteractiveGoal`.

It dereferences `ctx` to re-enter `MetaM`, looks up the goal's local context,
and checks `(← inferType decl.type).isProp` for each hypothesis.

### Data flow

```
1. Client calls Lean.Widget.getInteractiveDiagnostics (builtin)
   → extracts InteractiveGoal with { ctx, mvarId, hyps (with fvarIds) }

2. Client calls getHypKinds (custom, defined in preamble)
   → passes ctx (opaque ref) + mvarId (string)
   → server dereferences ctx, enters MetaM, checks isProp
   → returns { fvarId → isAssumption } mapping

3. Client joins the mapping with the standard hyps by fvarId
   → renders "Objects" and "Assumptions" sections in the goal panel
```

### Why this works

The key insight is that `WithRpcRef ContextInfo` is an opaque server-side
reference. The standard `getInteractiveDiagnostics` creates these references
when encoding goal data. Our custom RPC method receives the same reference
back and can dereference it to access the original `ContextInfo`, which
contains the `MetavarContext` needed to inspect the goal's local context.

This avoids needing access to server internals like `readDoc` or
`withWaitFindSnap`, which are part of the `lake serve` binary and not
importable from user code.

### Reference: how lean4game does it

lean4game takes a different approach: it builds a custom Lean server package
(`GameServer/`) with extended data structures and a custom `goalToInteractive`
that adds `isAssumption?` directly to the hypothesis bundle. The critical
line is:

```lean
isAssumption? := if (← inferType type).isProp then true else none
```

This is served through a custom `Game.getProofState` RPC method. Because
lean4game controls the server code, it can access `readDoc`, `withWaitFindSnap`,
and other server internals.

Our approach achieves the same result without modifying the server, by
piggybacking on the opaque context references that the standard API already
provides.

## Key Files

| File | Role |
|------|------|
| `server/index.mjs` | Node.js relay: spawns `lake serve`, forwards JSON-RPC with URI rewriting |
| `client/src/LeanLspClient.ts` | WebSocket → LSP connection, `initialize`/`initialized` handshake |
| `client/src/LeanRpcSession.ts` | Document lifecycle, RPC session, goal extraction, `getHypKinds` calls |
| `client/src/App.tsx` | Top-level React component, preamble definition, coordinates Blockly ↔ Lean |
| `client/src/workspaceToLean.ts` | Converts Blockly workspace to Lean tactic code with source mapping |
| `client/src/Blockly.tsx` | Blockly workspace component, drag-and-drop hypothesis integration |
| `client/src/infoview/Goal.tsx` | Renders a single goal, splits hyps into Objects/Assumptions |
| `client/src/infoview/Goals.tsx` | Goal tab container |
| `client/src/infoview/Hyp.tsx` | Renders a single hypothesis row |
| `client/src/log.ts` | Shared timestamped logging (`log(category, message)`) |
| `Projects/MathlibDemo/` | The Lean project used by the server (`lakefile.toml`, Mathlib dependency) |
| `Projects/MathlibDemo/TestHypKinds.lean` | Local test for the preamble Lean code (`lake env lean TestHypKinds.lean`) |

## Message flow in dev mode

In dev mode (`NODE_ENV=development`), `server/index.mjs` logs every JSON-RPC
message in both directions:

- `CLIENT: {...}` — browser → Lean server
- `SERVER: {...}` — Lean server → browser

The client-side `log.ts` module adds elapsed-time timestamps to all log
messages in the browser console:

```
[LSP +0.1s] Sending initialize...
[LeanRpc +0.3s] didOpen (v1, 1542 chars)
[LeanRpc +45.2s] fileProgress: processing complete
[LeanRpc +45.3s] Calling getInteractiveDiagnostics...
[LeanRpc +45.5s] Calling getHypKinds for mvarId=_uniq.5128...
```
