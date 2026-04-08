/**
 * LevelEvaluator — domain layer on top of LeanSessionManager.
 *
 * Owns the Lean preamble (the imports + custom RPC method definitions
 * that every level needs), assembles the full source from a "player
 * contribution", and translates LSP positions back to contribution
 * coordinates so callers never see preamble line numbers.
 *
 * Single entry point: `evaluate(contribution)` does the full round
 * trip and returns { diagnostics, leafGoals, complete }.
 *
 * The `leafGoals` field is shaped as a list of (position, goal) pairs
 * even though the first cut produces only the top-level goals returned
 * by `getInteractiveDiagnostics`. This leaves room for the planned
 * follow-up where the workspace-to-Lean translator emits `sorry` at
 * every empty Blockly hole and we render one goal per leaf in the
 * proof tree. See plans/REFACTOR.md.
 */
import type {
  InteractiveGoal,
  InteractiveDiagnostic,
  TaggedText,
  MsgEmbed,
} from '@leanprover/infoview-api';
import {
  LeanSessionManager,
  type LspDiagnostic,
  type Position,
  type Range,
} from './LeanSessionManager';
import { log, logError } from './log';

const TAG = 'LevelEvaluator';
const DEFAULT_URI = 'file:///blockly/Blockly.lean';

// In-memory prelude prepended to the player's contribution.
//
// The truly stable bits — `import Mathlib` and the `getHypKinds`
// machinery — live in the on-disk `MathlibDemo.Preamble` module so
// that they are compiled once into a `.olean` and never re-elaborated
// on every keystroke. Only the level-specific definitions live here.
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
   * Run the player's contribution through Lean and return diagnostics
   * + leaf goals in contribution-relative coordinates.
   */
  async evaluate(contribution: string): Promise<EvaluationResult | null> {
    const fullSource = this.prelude + contribution;

    try {
      await this.session.updateFile(this.uri, fullSource);
      // Wait for both the server to finish elaborating AND for the
      // cached diagnostics to be at least as fresh as the version we
      // sent. Both waits are version-based on the URI's latestSentVersion
      // captured at call time, so concurrent evaluate() calls all wait
      // for the same target. waitForDiagnostics has an internal timeout
      // fallback for the "Lean skipped publishDiagnostics because the
      // new batch matches the previous one" case.
      await Promise.all([
        this.session.waitForProcessing(this.uri),
        this.session.waitForDiagnostics(this.uri),
      ]);
    } catch (err) {
      logError(TAG, 'updateFile/waitForProcessing failed:', err);
      return null;
    }

    const diagnostics = this.collectDiagnostics();

    let leafGoals: LeafGoal[] = [];
    let hypKindMap: HypKindMap = new Map();
    try {
      const result = await this.collectLeafGoals();
      leafGoals = result.leafGoals;
      hypKindMap = result.hypKindMap;
    } catch (err) {
      logError(TAG, 'collectLeafGoals failed:', err);
    }

    const hasErrors = diagnostics.some((d) => d.severity === 1);
    const complete = !hasErrors && leafGoals.length === 0;

    return { diagnostics, leafGoals, hypKindMap, complete };
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  /**
   * Pull current diagnostics from the session, drop any that lie inside
   * the preamble, and translate the remainder to contribution-relative
   * coordinates.
   */
  private collectDiagnostics(): ContributionDiagnostic[] {
    const raw = this.session.getDiagnostics(this.uri);
    const out: ContributionDiagnostic[] = [];
    for (const d of raw) {
      if (d.range.end.line < this.preludeLineCount) continue; // entirely in preamble
      out.push({
        range: this.translateRangeToContribution(d.range),
        severity: d.severity,
        message: d.message,
      });
    }
    return out;
  }

  // ── Leaf goals ──────────────────────────────────────────────────

  private async collectLeafGoals(): Promise<{ leafGoals: LeafGoal[]; hypKindMap: HypKindMap }> {
    log(TAG, 'Calling getInteractiveDiagnostics...');
    const diagnostics = await this.session.widgetRpcCall<InteractiveDiagnostic[]>(
      this.uri,
      'Lean.Widget.getInteractiveDiagnostics',
      { textDocument: { uri: this.uri } },
    );

    const leafGoals: LeafGoal[] = [];
    for (const diag of diagnostics) {
      const goals = extractGoalsFromTaggedText(diag.message);
      if (goals.length === 0) continue;
      // The diagnostic's range is in full-source coordinates; the goal
      // applies at that position. Translate to contribution coords.
      const position = this.translatePositionToContribution(diag.range.start);
      for (const goal of goals) {
        leafGoals.push({ position, goal });
      }
    }
    log(TAG, `Extracted ${leafGoals.length} leaf goal(s)`);

    // Call our custom RPC method to classify hypotheses as Prop vs. Type.
    // Position must be after the preamble (where @[server_rpc_method] is defined).
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

    return { leafGoals, hypKindMap };
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
