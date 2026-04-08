/**
 * Unit tests for workspaceToLean.
 *
 * The serialized Blockly state shape is the same one Blockly produces
 * via `blockly.serialization.workspaces.save`. We construct minimal
 * inputs by hand here to keep tests focused on the translator logic.
 */
import { workspaceToLean } from './workspaceToLean';
import type { BlocklyState } from './Blockly';

// ── Tiny builders for serialized Blockly state ──────────────────────

type Block = {
  type: string;
  id?: string;
  fields?: Record<string, string>;
  inputs?: Record<string, { block?: Block }>;
  next?: { block?: Block };
};

function workspace(...topBlocks: Block[]): BlocklyState {
  return { blocks: { languageVersion: 0, blocks: topBlocks } } as BlocklyState;
}

function lemma(name: string, declaration: string, proofBlock?: Block): Block {
  return {
    type: 'lemma',
    id: `lemma-${name}`,
    fields: { THEOREM_NAME: name, THEOREM_DECLARATION: declaration },
    ...(proofBlock ? { inputs: { LEMMA_PROOF: { block: proofBlock } } } : {}),
  };
}

function tactic(type: string, fields: Record<string, string> = {}): Block {
  return { type, id: `${type}-1`, fields };
}

function have(name: string, type: string, proofBlock?: Block): Block {
  return {
    type: 'tactic_have',
    id: `have-${name}`,
    fields: { NAME: name, TYPE: type },
    ...(proofBlock ? { inputs: { PROOF: { block: proofBlock } } } : {}),
  };
}

function constructor(body1?: Block, body2?: Block): Block {
  const inputs: Record<string, { block?: Block }> = {};
  if (body1) inputs.BODY1 = { block: body1 };
  if (body2) inputs.BODY2 = { block: body2 };
  return {
    type: 'tactic_constructor',
    id: 'constructor-1',
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('workspaceToLean', () => {
  describe('empty proof bodies emit `skip`', () => {
    test('lemma with no proof body emits `skip`', () => {
      const ws = workspace(lemma('the_problem', '(x : ℝ) (h : x = 5) : x = 5'));
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem the_problem (x : ℝ) (h : x = 5) : x = 5 := by\n' +
        '  skip\n'
      );
    });

    test('have with no proof body emits `skip`', () => {
      const ws = workspace(
        lemma('foo', '(x : ℝ) : x = x', have('h', 'x = x')),
      );
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem foo (x : ℝ) : x = x := by\n' +
        '  have h : x = x := by\n' +
        '    skip\n'
      );
    });

    test('constructor with both branches empty emits two `· skip`s', () => {
      const ws = workspace(
        lemma('split', '(p q : Prop) (hp : p) (hq : q) : p ∧ q', constructor()),
      );
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem split (p q : Prop) (hp : p) (hq : q) : p ∧ q := by\n' +
        '  constructor\n' +
        '  · skip\n' +
        '  · skip\n'
      );
    });

    test('constructor with only first branch filled emits `· skip` for the second', () => {
      const ws = workspace(
        lemma(
          'split2',
          '(p q : Prop) (hp : p) (hq : q) : p ∧ q',
          constructor(tactic('tactic_refl')),
        ),
      );
      const { leanCode } = workspaceToLean(ws);
      // First branch uses the bulletized refl; second branch is the empty fallback.
      expect(leanCode).toContain('· rfl\n');
      expect(leanCode).toContain('· skip\n');
    });
  });

  describe('non-empty bodies are unaffected (sanity)', () => {
    test('lemma with a single rfl tactic', () => {
      const ws = workspace(
        lemma('refl_example', '(x : ℝ) : x = x', tactic('tactic_refl')),
      );
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem refl_example (x : ℝ) : x = x := by\n' +
        '  rfl\n'
      );
    });

    test('source info is produced for the lemma block', () => {
      const ws = workspace(lemma('the_problem', '(x : ℝ) (h : x = 5) : x = 5'));
      const { sourceInfo } = workspaceToLean(ws);
      const lemmaInfo = sourceInfo.find(si => si.id === 'lemma-the_problem');
      expect(lemmaInfo).toBeDefined();
      expect(lemmaInfo!.startLineCol).toEqual([0, 0]);
    });
  });
});
