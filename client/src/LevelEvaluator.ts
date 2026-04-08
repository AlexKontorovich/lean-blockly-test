/**
 * LevelEvaluator — domain layer on top of LeanSessionManager.
 *
 * Owns the Lean preamble, assembles the full source from a "player
 * contribution", and translates LSP positions back to contribution
 * coordinates so callers never see preamble line numbers.
 *
 * Single entry point: `evaluate(contribution)` does the full round trip
 * and returns `{ diagnostics, leafGoals, hypKindMap, complete }`. The
 * trip itself is just two RPC calls — `updateFile` followed by
 * `Lean.Widget.getInteractiveDiagnostics`. There is no manual waiting
 * for processing or diagnostics, no version tracking, no race
 * management: the widget RPC call is request/response and the server
 * holds the response until elaboration is ready, so a single await
 * gives us the full state.
 *
 * `leafGoals` is shaped as a list of (position, goal) pairs. With
 * today's input — `workspaceToLean` emits `skip` for empty bodies —
 * each unsolved leaf in the proof tree produces its own diagnostic and
 * its own LeafGoal entry, automatically.
 */
import type {
  InteractiveGoal,
  InteractiveDiagnostic,
  TaggedText,
  MsgEmbed,
} from '@leanprover/infoview-api';
import {
  LeanSessionManager,
  type Position,
  type Range,
} from './LeanSessionManager';
import { log, logError } from './log';

const TAG = 'LevelEvaluator';
const DEFAULT_URI = 'file:///blockly/Blockly.lean';

// In-memory prelude prepended to the player's contribution. The truly
// stable bits — `import Mathlib` and the `getHypKinds` machinery —
// live in the on-disk `MathlibDemo.Preamble` module so they compile
// once into a `.olean` and never re-elaborate. Only level-specific
// definitions live here.
const DEFAULT_PRELUDE = `import MathlibDemo.Preamble

def FunLimAt (f : ℝ → ℝ) (L : ℝ) (c : ℝ) : Prop :=
  ∀ ε > 0, ∃ δ > 0, ∀ x ≠ c, |x - c| < δ → |f x - L| < ε

`;

// ── Public types ─────────────────────────────────────────────────────

export type HypKindMap = Map<string, boolean>;

export interface ContributionDiagnostic {
  range: Range; // contribution-relative
  severity?: number;
  message: string;
}

export interface LeafGoal {
  /** Position in the contribution where this goal applies. */
  position: Position;
  /** The interactive goal payload. */
  goal: InteractiveGoal;
}

export interface EvaluationResult {
  diagnostics: ContributionDiagnostic[];
  leafGoals: LeafGoal[];
  /** Per-fvarId classification: true = assumption (Prop), false = object (Type). */
  hypKindMap: HypKindMap;
  /** True iff there are no error diagnostics and no leaf goals. */
  complete: boolean;
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Flatten an InteractiveDiagnostic message TaggedText to a plain string,
 * for use as the diagnostic's display text. Embedded `goal` payloads
 * are omitted (they are surfaced separately via `leafGoals` and rendered
 * by the goal panel); embedded `expr` content is recursed into and
 * its text content concatenated.
 */
function flattenInteractiveMessage(tt: TaggedText<MsgEmbed>): string {
  if ('text' in tt) return tt.text;
  if ('append' in tt) return tt.append.map(flattenInteractiveMessage).join('');
  if ('tag' in tt) {
    const [, content] = tt.tag;
    return flattenInteractiveMessage(content);
  }
  return '';
}

/**
 * Walk an InteractiveDiagnostic message tree and pull out every embedded
 * InteractiveGoal. Returns goals in document order.
 */
function extractGoalsFromTaggedText(tt: TaggedText<MsgEmbed>): InteractiveGoal[] {
  const goals: InteractiveGoal[] = [];
  function traverse(node: TaggedText<MsgEmbed>) {
    if ('text' in node) return;
    if ('append' in node) {
      node.append.forEach(traverse);
      return;
    }
    if ('tag' in node) {
      const [embed, content] = node.tag;
      if ('goal' in embed) goals.push(embed.goal);
      traverse(content);
    }
  }
  traverse(tt);
  return goals;
}

// ── LevelEvaluator ──────────────────────────────────────────────────

export interface LevelEvaluatorOptions {
  uri?: string;
  prelude?: string;
}

export class LevelEvaluator {
  private session: LeanSessionManager;
  private uri: string;
  private prelude: string;
  private preludeLineCount: number;

  constructor(session: LeanSessionManager, opts: LevelEvaluatorOptions = {}) {
    this.session = session;
    this.uri = opts.uri ?? DEFAULT_URI;
    this.prelude = opts.prelude ?? DEFAULT_PRELUDE;
    // The prelude ends in `\n`, so split('\n').length - 1 is the number
    // of lines it occupies and also the 0-indexed line where the
    // contribution starts.
    this.preludeLineCount = this.prelude.split('\n').length - 1;
  }

  /**
   * Run the player's contribution through Lean and return diagnostics +
   * leaf goals in contribution-relative coordinates. A single round
   * trip: updateFile (sends didChange), then getInteractiveDiagnostics
   * via widget RPC (which the server holds until elaboration is ready).
   */
  async evaluate(contribution: string): Promise<EvaluationResult | null> {
    const fullSource = this.prelude + contribution;

    let interactiveDiagnostics: InteractiveDiagnostic[];
    try {
      await this.session.updateFile(this.uri, fullSource);
      // Lean's widget RPCs return data for the most recently elaborated
      // snapshot, NOT for the latest didChange — so we must wait for
      // processing to catch up before asking for diagnostics, or we'd
      // get stale results from the previous edit.
      await this.session.waitForProcessing(this.uri);
      log(TAG, 'Calling getInteractiveDiagnostics...');
      interactiveDiagnostics = await this.session.widgetRpcCall<InteractiveDiagnostic[]>(
        this.uri,
        'Lean.Widget.getInteractiveDiagnostics',
        { textDocument: { uri: this.uri } },
      );
    } catch (err) {
      logError(TAG, 'evaluate failed:', err);
      return null;
    }

    // Derive both plain diagnostics and leaf goals from the same single
    // server response — they are two views of the same data.
    const diagnostics: ContributionDiagnostic[] = [];
    const leafGoals: LeafGoal[] = [];
    for (const diag of interactiveDiagnostics) {
      // Skip anything entirely inside the preamble.
      if (diag.range.end.line < this.preludeLineCount) continue;

      diagnostics.push({
        range: this.translateRangeToContribution(diag.range),
        severity: diag.severity,
        message: flattenInteractiveMessage(diag.message),
      });

      const goals = extractGoalsFromTaggedText(diag.message);
      const position = this.translatePositionToContribution(diag.range.start);
      for (const goal of goals) {
        leafGoals.push({ position, goal });
      }
    }
    log(TAG, `Got ${diagnostics.length} diagnostic(s), ${leafGoals.length} leaf goal(s)`);

    // Classify hypotheses (Prop vs. Type) for each leaf goal via our
    // custom getHypKinds RPC. Position must be after the preamble where
    // the method is registered.
    const hypKindMap: HypKindMap = new Map();
    const callPos: Position = { line: this.preludeLineCount, character: 0 };
    for (const { goal } of leafGoals) {
      if (!goal.ctx || !goal.mvarId) continue;
      try {
        const result = await this.session.widgetRpcCall<HypKindResult>(
          this.uri,
          'getHypKinds',
          { ctx: goal.ctx, mvarId: goal.mvarId },
          callPos,
        );
        for (const g of result.goals) {
          for (const h of g.hyps) {
            hypKindMap.set(h.fvarId, h.isAssumption);
          }
        }
      } catch (err) {
        logError(TAG, 'getHypKinds failed:', err);
      }
    }

    const hasErrors = diagnostics.some((d) => d.severity === 1);
    const complete = !hasErrors && leafGoals.length === 0;

    return { diagnostics, leafGoals, hypKindMap, complete };
  }

  // ── Coordinate translation ──────────────────────────────────────

  private translatePositionToContribution(p: Position): Position {
    return {
      line: Math.max(0, p.line - this.preludeLineCount),
      character: p.character,
    };
  }

  private translateRangeToContribution(r: Range): Range {
    return {
      start: this.translatePositionToContribution(r.start),
      end: this.translatePositionToContribution(r.end),
    };
  }
}

// ── HypKinds RPC payload type (internal to this module) ────────────

interface HypKindResult {
  goals: Array<{
    mvarId: string;
    hyps: Array<{ fvarId: string; isAssumption: boolean }>;
  }>;
}
