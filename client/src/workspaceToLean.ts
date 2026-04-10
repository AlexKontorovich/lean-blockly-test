/**
 * Convert a serialized Blockly workspace to Lean code.
 */

import type { BlocklyState } from './Blockly';

// Type definitions for the serialized block structure
interface SerializedBlock {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  fields?: Record<string, string>;
  inputs?: Record<string, { block?: SerializedBlock }>;
  next?: { block?: SerializedBlock };
  data?: string;
}

interface SerializedWorkspace {
  blocks?: {
    languageVersion?: number;
    blocks?: SerializedBlock[];
  };
}

// Intermediate representation: chunks of code with optional block ownership
type CodeChunk = {
  text: string;
  blockId?: string;
};

// Output types
export type SourceInfo = {
  id: string;
  startLineCol: [number, number];
  endLineCol: [number, number];
};

export type WorkspaceToLeanResult = {
  leanCode: string;
  sourceInfo: SourceInfo[];
};

// Helper to create a chunk with block ID
function chunk(text: string, blockId?: string): CodeChunk {
  return { text, blockId };
}

// Helper to create chunks without block ID (plain text)
function text(t: string): CodeChunk {
  return { text: t };
}

/**
 * If a tactic-body slot is empty, fill it with `skip` so the resulting
 * Lean still parses and elaborates as a real proof attempt with an
 * "unsolved goals" diagnostic. The diagnostic carries the goal state at
 * that hole, which is exactly what we want to display to the player.
 *
 * `skip` is preferred over `sorry` because it doesn't make the
 * declaration "succeed" with a warning — the proof legitimately fails
 * with unsolved goals, and `LevelEvaluator` reports the level as
 * incomplete (`complete: false`).
 */
function bodyOrSkip(bodyChunks: CodeChunk[], indent: string): CodeChunk[] {
  if (bodyChunks.length === 0) {
    return [text(`${indent}skip\n`)];
  }
  return bodyChunks;
}

/**
 * Generate code chunks from a single block and its children.
 */
function blockToChunks(
  block: SerializedBlock | undefined,
  indent: string = '',
  noFirstIndent: boolean = false
): CodeChunk[] {
  if (!block) return [];

  const tp = block.type;
  const fields = block.fields ?? {};
  const inputs = block.inputs ?? {};
  const blockId = block.id;

  let chunks: CodeChunk[] = [];

  // Add indent unless noFirstIndent is set
  const indentChunk = noFirstIndent ? [] : [text(indent)];

  switch (tp) {
    case 'lemma': {
      const name = fields['THEOREM_NAME'] ?? 'unnamed';
      const declaration = fields['THEOREM_DECLARATION'] ?? '';
      const proofChunks = blockToChunks(inputs['LEMMA_PROOF']?.block, indent + '  ');
      // THEOREM_DECLARATION should contain the full signature, e.g. "(a b : ℕ) : a + b = b + a"
      chunks = [
        chunk(`theorem ${name} ${declaration} := by\n`, blockId),
        ...bodyOrSkip(proofChunks, indent + '  '),
      ];
      break;
    }

    case 'prop':
    case 'prop_dynamic': {
      const value = block.data ?? fields['PROP_NAME'] ?? '';
      chunks = [chunk(value, blockId)];
      break;
    }

    case 'prop_declaration': {
      const decl = fields['VARIABLE_DECL'] ?? '';
      const def = fields['VARIABLE_DEF'] ?? '';
      chunks = [chunk(`(${decl} : ${def})`, blockId)];
      // Chain to next variable declaration
      if (block.next?.block) {
        chunks.push(...blockToChunks(block.next.block, ''));
      }
      return chunks; // Early return - no indent prefix for prop_declaration
    }

    case 'tactic_sorry': {
      chunks = [...indentChunk, chunk(`sorry\n`, blockId)];
      break;
    }

    case 'tactic_refl': {
      chunks = [...indentChunk, chunk(`rfl\n`, blockId)];
      break;
    }

    case 'tactic_ring_nf': {
      chunks = [...indentChunk, chunk(`ring_nf\n`, blockId)];
      break;
    }

    case 'tactic_other': {
      const name = fields['PROP_NAME'] ?? '';
      chunks = [...indentChunk, chunk(`${name}\n`, blockId)];
      break;
    }

    case 'tactic_intro':
    case 'tactic_exact':
    case 'tactic_apply':
    case 'tactic_use':
    case 'tactic_unfold':
    case 'tactic_specialize':
    case 'tactic_choose':
    case 'tactic_cases':
    case 'tactic_induction':
    case 'tactic_obtain': {
      const tacticName = tp.replace('tactic_', '');
      const argChunks = blockToChunks(inputs['ARG']?.block, '');
      chunks = [
        ...indentChunk,
        chunk(`${tacticName} `, blockId),
        ...argChunks,
        chunk(`\n`, blockId),
      ];
      break;
    }

    case 'tactic_have': {
      const name = fields['NAME'] ?? 'h';
      const type = fields['TYPE'] ?? 'True';
      const proofChunks = blockToChunks(inputs['PROOF']?.block, indent + '  ');
      chunks = [
        ...indentChunk,
        chunk(`have ${name} : ${type} := by\n`, blockId),
        ...bodyOrSkip(proofChunks, indent + '  '),
      ];
      break;
    }

    case 'tactic_rw': {
      const direction = fields['DIRECTION_TYPE'];
      const sourceChunks = blockToChunks(inputs['REWRITE_SOURCE']?.block, indent + '  ', true);
      const arrow = direction === 'LEFT' ? '← ' : '';
      chunks = [
        ...indentChunk,
        chunk(`rewrite [${arrow}`, blockId),
        ...sourceChunks,
        chunk(`]\n`, blockId),
      ];
      break;
    }

    case 'tactic_rw_at': {
      const sourceChunks = blockToChunks(inputs['REWRITE_SOURCE']?.block, indent + '  ', true);
      const targetChunks = blockToChunks(inputs['REWRITE_TARGET']?.block, indent + '  ', true);
      chunks = [
        ...indentChunk,
        chunk(`rewrite [`, blockId),
        ...sourceChunks,
        chunk(`] at `, blockId),
        ...targetChunks,
        chunk(`\n`, blockId),
      ];
      break;
    }

    case 'tactic_constructor': {
      const body1Chunks = blockToChunks(inputs['BODY1']?.block, indent + '  ');
      const body2Chunks = blockToChunks(inputs['BODY2']?.block, indent + '  ');

      // Replace first indent with bullet for each body. If a branch is
      // entirely empty, emit `· skip` so it parses and produces an
      // unsolved-goals diagnostic at that branch.
      const bulletize = (bodyChunks: CodeChunk[]): CodeChunk[] => {
        if (bodyChunks.length === 0) {
          return [text(`${indent}· skip\n`)];
        }
        if (bodyChunks.length > 0 && bodyChunks[0].text === indent + '  ') {
          return [text(`${indent}· `), ...bodyChunks.slice(1)];
        }
        return bodyChunks;
      };

      chunks = [
        ...indentChunk,
        chunk(`constructor\n`, blockId),
        ...bulletize(body1Chunks),
        ...bulletize(body2Chunks),
      ];
      break;
    }

    case 'tactic_show': {
      const goalChunks = blockToChunks(inputs['GOAL']?.block, '');
      const proofChunks = blockToChunks(inputs['PROOF']?.block, indent + '  ');

      // Remove trailing newline from proof
      const trimmedProofChunks = trimTrailingNewline(
        bodyOrSkip(proofChunks, indent + '  '),
      );

      chunks = [
        chunk(`show `, blockId),
        ...goalChunks,
        chunk(` by\n`, blockId),
        ...trimmedProofChunks,
      ];
      break;
    }

    default:
      console.warn(`[workspaceToLean] Unknown block type: ${tp}`);
      return [];
  }

  // Handle chained blocks (next connection) for tactics
  // Note: prop_declaration returns early with its own next handling
  if (block.next?.block) {
    chunks.push(...blockToChunks(block.next.block, indent));
  }

  return chunks;
}

/**
 * Remove trailing newline from the last chunk if present.
 */
function trimTrailingNewline(chunks: CodeChunk[]): CodeChunk[] {
  if (chunks.length === 0) return chunks;
  const last = chunks[chunks.length - 1];
  if (last.text.endsWith('\n')) {
    return [
      ...chunks.slice(0, -1),
      { ...last, text: last.text.slice(0, -1) },
    ];
  }
  return chunks;
}

/**
 * Flatten chunks into a string and compute source info.
 */
function flattenChunks(chunks: CodeChunk[]): WorkspaceToLeanResult {
  let leanCode = '';
  let line = 0;
  let col = 0;

  // Track block ranges: blockId -> { start, end }
  const blockRanges = new Map<string, { start: [number, number]; end: [number, number] }>();

  for (const chunk of chunks) {
    const startLine = line;
    const startCol = col;

    // Update position as we add text
    // Use index-based loop to count UTF-16 code units (LSP convention)
    // rather than Unicode codepoints (which for...of would give)
    for (let i = 0; i < chunk.text.length; i++) {
      if (chunk.text[i] === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
    }

    leanCode += chunk.text;

    // Track block range
    if (chunk.blockId) {
      const existing = blockRanges.get(chunk.blockId);
      if (existing) {
        // Extend the range
        existing.end = [line, col];
      } else {
        // New range
        blockRanges.set(chunk.blockId, {
          start: [startLine, startCol],
          end: [line, col],
        });
      }
    }
  }

  // Convert to SourceInfo array
  const sourceInfo: SourceInfo[] = [];
  for (const [id, range] of blockRanges) {
    sourceInfo.push({
      id,
      startLineCol: range.start,
      endLineCol: range.end,
    });
  }

  return { leanCode, sourceInfo };
}

/**
 * Convert a serialized Blockly workspace to Lean code with source mapping.
 *
 * @param workspace - The serialized workspace state (from blockly.serialization.workspaces.save)
 * @returns The generated Lean code and source info mapping block IDs to positions
 */
export function workspaceToLean(workspace: BlocklyState): WorkspaceToLeanResult {
  const ws = workspace as SerializedWorkspace;
  const allTopBlocks = ws.blocks?.blocks ?? [];

  // Only process lemma blocks (main theorems), ignore loose tactics or other blocks
  const lemmaBlocks = allTopBlocks.filter(block => block.type === 'lemma');

  const allChunks: CodeChunk[] = [];

  for (let i = 0; i < lemmaBlocks.length; i++) {
    const chunks = blockToChunks(lemmaBlocks[i], '');
    allChunks.push(...chunks);

    // Add blank line between top-level blocks
    if (i < lemmaBlocks.length - 1) {
      allChunks.push(text('\n'));
    }
  }

  return flattenChunks(allChunks);
}
