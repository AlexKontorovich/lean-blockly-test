/**
 * Unit tests for workspaceToLean.
 *
 * The serialized Blockly state shape is the same one Blockly produces
 * via `blockly.serialization.workspaces.save`. We construct minimal
 * inputs by hand here to keep tests focused on the translator logic.
 */
import { workspaceToLean } from '../src/workspaceToLean';
import type { BlocklyState } from '../src/Blockly';

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

    test('rewrite tactic emits rewrite instead of rw', () => {
      const ws = workspace(
        lemma(
          'rewrite_example',
          '(x : ℝ) (h : x = 5) : x = 5',
          {
            type: 'tactic_rw',
            id: 'rewrite-1',
            fields: { DIRECTION_TYPE: 'RIGHT' },
            inputs: {
              REWRITE_SOURCE: {
                block: {
                  type: 'prop',
                  id: 'prop-h',
                  fields: { PROP_NAME: 'h' },
                },
              },
            },
          },
        ),
      );
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem rewrite_example (x : ℝ) (h : x = 5) : x = 5 := by\n' +
        '  rewrite [h]\n'
      );
      expect(leanCode).not.toContain('rw [h]');
    });

    test('rewrite at tactic emits bracketed rewrite syntax', () => {
      const ws = workspace(
        lemma(
          'rewrite_at_example',
          '(x y : ℝ) (h : x = y) (h2 : x = x) : x = x',
          {
            type: 'tactic_rw_at',
            id: 'rewrite-at-1',
            inputs: {
              REWRITE_SOURCE: {
                block: {
                  type: 'prop',
                  id: 'prop-h',
                  fields: { PROP_NAME: 'h' },
                },
              },
              REWRITE_TARGET: {
                block: {
                  type: 'prop',
                  id: 'prop-h2',
                  fields: { PROP_NAME: 'h2' },
                },
              },
            },
          },
        ),
      );
      const { leanCode } = workspaceToLean(ws);
      expect(leanCode).toBe(
        'theorem rewrite_at_example (x y : ℝ) (h : x = y) (h2 : x = x) : x = x := by\n' +
        '  rewrite [h] at h2\n'
      );
    });
  });

  // ── Ported from the previous client/test/test-workspaceToLean.ts ────
  // The fixture below was originally written when lemma variables lived
  // in a separate `VARIABLES` input populated with `prop_declaration`
  // blocks. The data model has since been refactored: the full signature
  // (variables + goal) now lives directly in THEOREM_DECLARATION, and
  // workspaceToLean no longer reads a VARIABLES input on lemmas.

  describe('full example workspace', () => {
    const example1Data = { "blocks": { "languageVersion": 0, "blocks": [{ "type": "lemma", "id": "3yAUmdNL2=WYh]Gxi)]X", "x": 13, "y": 22, "fields": { "THEOREM_NAME": "away", "THEOREM_DECLARATION": "(y : ℝ) (hy : y ≠ 1) : (y^2 - 1) / (y - 1) = y + 1" }, "inputs": { "LEMMA_PROOF": { "block": { "type": "tactic_other", "id": "k}|H70s[,ot=/1U@K_,;", "fields": { "PROP_NAME": "grind" } } } } }, { "type": "lemma", "id": "DemnP%+kbpZdIIe~0(3W", "x": 308, "y": 35, "fields": { "THEOREM_NAME": "fun_limit_fact", "THEOREM_DECLARATION": "FunLimAt (fun x => (x^2 - 1) / (x - 1)) 2 1" }, "inputs": { "LEMMA_PROOF": { "block": { "type": "tactic_unfold", "id": "4jk;hHJ|_aSp.)2PU`Gc", "inputs": { "ARG": { "block": { "type": "prop", "id": "Mojm{fSn$rJvFC81z{h(", "fields": { "PROP_NAME": "FunLimAt" } } } }, "next": { "block": { "type": "tactic_intro", "id": "^=/m!cJjN6xgQ.RpEN]y", "inputs": { "ARG": { "block": { "type": "prop", "id": "Y(gRn,NBi~2+wLabs!@A", "fields": { "PROP_NAME": "ε" } } } }, "next": { "block": { "type": "tactic_intro", "id": "MK{[.T(RH!$~`CKvXmL1", "inputs": { "ARG": { "block": { "type": "prop", "id": "mgxS^6SsXB-}9:6^cQ?!", "fields": { "PROP_NAME": "hε" } } } }, "next": { "block": { "type": "tactic_use", "id": "QPSB(Ek%b~pXS8}W4?4/", "inputs": { "ARG": { "block": { "type": "prop", "id": "^XKO;%FbY-Cl)sU%fNl;", "fields": { "PROP_NAME": "ε" } } } }, "next": { "block": { "type": "tactic_constructor", "id": "C=S-)mM.)`C``sWq!YlT", "inputs": { "BODY1": { "block": { "type": "tactic_other", "id": "m.6n,uHODs!Ns?ycFg`M", "fields": { "PROP_NAME": "linarith" } } }, "BODY2": { "block": { "type": "tactic_intro", "id": "4Nh1ti#nH_#d-A3V$e|_", "inputs": { "ARG": { "block": { "type": "prop", "id": ":un028QY,n#E7%_%,]4[", "fields": { "PROP_NAME": "y" } } } }, "next": { "block": { "type": "tactic_intro", "id": "fxEi-:)M^j3ee76?Z9l+", "inputs": { "ARG": { "block": { "type": "prop", "id": "U:5}c2^h7F]d8+hh(q}8", "fields": { "PROP_NAME": "hy" } } } }, "next": { "block": { "type": "tactic_intro", "id": "]@#*lMzE^dbkiR]{PhGo", "inputs": { "ARG": { "block": { "type": "prop", "id": "*ww_S)5(YZG^Uc84eUlv", "fields": { "PROP_NAME": "hy2" } } } }, "next": { "block": { "type": "tactic_other", "id": "3#gT|oNu-}[}3uB_a.2U", "fields": { "PROP_NAME": "simp" }, "next": { "block": { "type": "tactic_rw", "id": "f5piLnWwQvlx,Ki5WTp4", "fields": { "DIRECTION_TYPE": "RIGHT" }, "inputs": { "REWRITE_SOURCE": { "block": { "type": "prop", "id": "G.]vQSXK]?]G9T#)g+sJ", "fields": { "PROP_NAME": "away y hy" } } } }, "next": { "block": { "type": "tactic_rw", "id": "W|.ZlRq5@bi.2CML=mPB", "fields": { "DIRECTION_TYPE": "RIGHT" }, "inputs": { "REWRITE_SOURCE": { "block": { "type": "tactic_show", "id": "3{s96}qox|({ahT!Azz)", "inputs": { "GOAL": { "block": { "type": "prop", "id": "!bFf)T7:^+.{UW4*Cf*}", "fields": { "PROP_NAME": "y + 1 - 2 = y - 1" } } }, "PROOF": { "block": { "type": "tactic_other", "id": "fqI`{J4OU;d~Kx3hWy%e", "fields": { "PROP_NAME": "grind" } } } } } } }, "next": { "block": { "type": "tactic_exact", "id": "HSp12q.iHmw-1[hrEQB@", "inputs": { "ARG": { "block": { "type": "prop", "id": ",)45@UUo`{kGa5cYgWS8", "fields": { "PROP_NAME": "hy2" } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } }] } } as BlocklyState;

    const expectedOutput = `theorem away (y : ℝ) (hy : y ≠ 1) : (y^2 - 1) / (y - 1) = y + 1 := by
  grind

theorem fun_limit_fact FunLimAt (fun x => (x^2 - 1) / (x - 1)) 2 1 := by
  unfold FunLimAt
  intro ε
  intro hε
  use ε
  constructor
  · linarith
  · intro y
    intro hy
    intro hy2
    simp
    rewrite [away y hy]
    rewrite [show y + 1 - 2 = y - 1 by
        grind]
    exact hy2
`;

    test('converts the example workspace to expected Lean code', () => {
      const result = workspaceToLean(example1Data);
      expect(result.leanCode).toBe(expectedOutput);
    });

    test('produces sourceInfo for blocks in the example', () => {
      const result = workspaceToLean(example1Data);
      expect(result.sourceInfo.length).toBeGreaterThan(0);
      // The "away" lemma block is tracked.
      const awayLemma = result.sourceInfo.find(s => s.id === '3yAUmdNL2=WYh]Gxi)]X');
      expect(awayLemma).toBeDefined();
      expect(awayLemma!.startLineCol[0]).toBe(0);
    });
  });

  describe('UTF-16 column counting', () => {
    test('characters outside BMP count as 2 UTF-16 code units', () => {
      // 𝕜 (U+1D55C, blackboard-bold k) is outside BMP and takes 2 UTF-16
      // code units. LSP uses UTF-16 columns, so the translator must
      // count them that way.
      const ws = {
        blocks: {
          languageVersion: 0,
          blocks: [{
            type: 'lemma',
            id: 'test-lemma',
            fields: {
              THEOREM_NAME: 'test',
              THEOREM_DECLARATION: ': 𝕜 = 𝕜',
            },
            inputs: {
              LEMMA_PROOF: {
                block: {
                  type: 'tactic_other',
                  id: 'test-tactic',
                  fields: { PROP_NAME: 'rfl' },
                },
              },
            },
          }],
        },
      } as BlocklyState;

      const result = workspaceToLean(ws);

      // The tactic starts on line 1, col 2 (after the "  " indent).
      const tacticInfo = result.sourceInfo.find(s => s.id === 'test-tactic');
      expect(tacticInfo).toBeDefined();
      expect(tacticInfo!.startLineCol).toEqual([1, 2]);
      expect(tacticInfo!.endLineCol).toEqual([2, 0]); // ends after newline
    });
  });
});
