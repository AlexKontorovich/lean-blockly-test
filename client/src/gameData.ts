import type { BlocklyState } from './Blockly.tsx';

// ── Public types ────────────────────────────────────────────────────

export type LevelDefinition = {
  name: string;
  initial: BlocklyState;
  allowedBlocks?: string[];
  introduction?: string;
  conclusion?: string;
};

export type World = {
  id: string;
  name: string;
  description?: string;
  levels: LevelDefinition[];
  dependsOn: string[];
};

export type GameData = {
  worlds: World[];
};

export type NavigationState =
  | { kind: 'worldOverview' }
  | { kind: 'playing'; worldId: string; levelIndex: number };

/**
 * Per-level data shape used by the auto-generated files under
 * `client/src/levels/<World>/<basename>.ts`. Each such file does
 * `export default <LevelSource>;` and is discovered at build time
 * by Vite's `import.meta.glob`. The conversion to `LevelDefinition`
 * happens in this file.
 */
export type LevelSource = {
  world: string;
  level: number;
  name: string;
  theoremName: string;
  statement: string;
  introduction?: string;
  conclusion?: string;
  allowedBlocks?: string[];
};

// ── Blockly state helper ────────────────────────────────────────────

function makeLevelState(theoremName: string, declaration: string): BlocklyState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{
        type: 'lemma',
        id: `lemma-${theoremName}`,
        x: 61, y: 61,
        fields: {
          THEOREM_NAME: theoremName,
          THEOREM_DECLARATION: declaration,
        },
      }],
    },
  };
}

function levelSourceToDefinition(src: LevelSource): LevelDefinition {
  return {
    name: src.name,
    initial: makeLevelState(src.theoremName, src.statement),
    allowedBlocks: src.allowedBlocks,
    introduction: src.introduction,
    conclusion: src.conclusion,
  };
}

// ── Load all generated level files ──────────────────────────────────
//
// Vite's `import.meta.glob` with `eager: true` resolves at build time
// into a synchronous map of path → module. We group by world (parsed
// from the path) and sort by the `level` field within each world.

const levelModules = import.meta.glob<{ default: LevelSource }>(
  './levels/*/*.ts',
  { eager: true },
);

const levelsByWorld: Record<string, LevelDefinition[]> = {};
for (const [path, mod] of Object.entries(levelModules)) {
  const src = mod.default;
  if (!src) continue;
  if (!levelsByWorld[src.world]) levelsByWorld[src.world] = [];
  // We push first and sort once below.
  (levelsByWorld[src.world] as unknown as { src: LevelSource; def: LevelDefinition }[])
    .push({ src, def: levelSourceToDefinition(src) } as never);
  void path; // path is informational
}
// Sort each world's levels by their `level` number, then unwrap to
// LevelDefinition[]. The cast above lets us carry both shapes through
// the temporary array without polluting the public type.
for (const world of Object.keys(levelsByWorld)) {
  const tagged = levelsByWorld[world] as unknown as { src: LevelSource; def: LevelDefinition }[];
  tagged.sort((a, b) => a.src.level - b.src.level);
  levelsByWorld[world] = tagged.map((t) => t.def);
}

function levelsFor(worldId: string): LevelDefinition[] {
  return levelsByWorld[worldId] ?? [];
}

// ── Hand-coded world list ───────────────────────────────────────────
//
// The set of worlds, their display names, and dependency edges are
// authored here. The actual level content for each world is loaded
// from `client/src/levels/<worldId>/` via the glob above.

export const gameData: GameData = {
  worlds: [
    { id: 'RealAnalysisStory', name: 'The Story of Real Analysis', levels: levelsFor('RealAnalysisStory'), dependsOn: [] },
    { id: 'L1Pset', name: 'Pset 1', levels: levelsFor('L1Pset'), dependsOn: ['RealAnalysisStory'] },
    { id: 'NewtonsCalculationOfPi', name: "Newton's Computation of π", levels: levelsFor('NewtonsCalculationOfPi'), dependsOn: ['RealAnalysisStory'] },
    { id: 'L2Pset', name: 'Pset 2', levels: levelsFor('L2Pset'), dependsOn: ['NewtonsCalculationOfPi', 'L1Pset'] },
    { id: 'Lecture3', name: 'More fun with Sequences', levels: levelsFor('Lecture3'), dependsOn: ['NewtonsCalculationOfPi'] },
    { id: 'L3Pset', name: 'Pset 3', levels: levelsFor('L3Pset'), dependsOn: ['L2Pset'] },
    { id: 'Lecture4', name: 'Even more fun with Sequences', levels: levelsFor('Lecture4'), dependsOn: ['L2Pset', 'Lecture3'] },
    { id: 'L4Pset', name: 'Pset 4', levels: levelsFor('L4Pset'), dependsOn: ['L3Pset'] },
    { id: 'Lecture5', name: 'Algebraic Limit Theorem, Part I', levels: levelsFor('Lecture5'), dependsOn: ['Lecture4', 'L4Pset'] },
    { id: 'Lecture6', name: 'Algebraic Limit Theorem, Part II', levels: levelsFor('Lecture6'), dependsOn: ['Lecture5', 'L4Pset'] },
    { id: 'L6Pset', name: 'Pset 6', levels: levelsFor('L6Pset'), dependsOn: ['L4Pset'] },
    { id: 'Lecture7', name: 'Algebraic Limit Theorem, Part III', levels: levelsFor('Lecture7'), dependsOn: ['Lecture6'] },
    { id: 'L7Pset', name: 'Pset 7', levels: levelsFor('L7Pset'), dependsOn: ['L6Pset'] },
    { id: 'Lecture8', name: 'Induction', levels: levelsFor('Lecture8'), dependsOn: ['L6Pset', 'L7Pset'] },
    { id: 'L8Pset', name: 'Pset 8', levels: levelsFor('L8Pset'), dependsOn: ['L7Pset'] },
    { id: 'Lecture9', name: 'Algebraic Limit Theorem, Part IV', levels: levelsFor('Lecture9'), dependsOn: ['L8Pset'] },
    { id: 'L9Pset', name: 'Pset 9', levels: levelsFor('L9Pset'), dependsOn: ['L8Pset'] },
    { id: 'Lecture10', name: 'Algebraic Limit Theorem, Part V', levels: levelsFor('Lecture10'), dependsOn: ['L9Pset'] },
    { id: 'L10Pset', name: 'Pset 10', levels: levelsFor('L10Pset'), dependsOn: ['L9Pset'] },
    { id: 'Lecture11', name: 'The Real Numbers I', levels: levelsFor('Lecture11'), dependsOn: ['L9Pset', 'Lecture10', 'L10Pset'] },
    { id: 'L11Pset', name: 'Pset 11', levels: levelsFor('L11Pset'), dependsOn: ['Lecture11', 'L10Pset'] },
    { id: 'Lecture12', name: 'Cauchy Sequences II', levels: levelsFor('Lecture12'), dependsOn: ['Lecture11', 'L10Pset'] },
    { id: 'L12Pset', name: 'Pset 12', levels: levelsFor('L12Pset'), dependsOn: ['Lecture12', 'L11Pset'] },
    { id: 'Lecture13', name: 'Monotone Subsequence', levels: levelsFor('Lecture13'), dependsOn: ['L11Pset', 'Lecture12'] },
    { id: 'L13Pset', name: 'Pset 13', levels: levelsFor('L13Pset'), dependsOn: ['Lecture13', 'L12Pset'] },
    { id: 'Lecture14', name: 'Bolzano-Weierstrass', levels: levelsFor('Lecture14'), dependsOn: ['L12Pset', 'Lecture13'] },
    { id: 'Lecture15', name: 'The Real Numbers', levels: levelsFor('Lecture15'), dependsOn: ['Lecture14', 'L13Pset'] },
    { id: 'L15Pset', name: 'Pset 15', levels: levelsFor('L15Pset'), dependsOn: ['Lecture15', 'L13Pset'] },
    { id: 'Lecture16', name: 'Series', levels: levelsFor('Lecture16'), dependsOn: ['Lecture15'] },
    { id: 'L16Pset', name: 'Pset 16', levels: levelsFor('L16Pset'), dependsOn: ['Lecture16', 'L15Pset'] },
    { id: 'Lecture17', name: 'Series II', levels: levelsFor('Lecture17'), dependsOn: ['Lecture16', 'L15Pset', 'L16Pset'] },
    { id: 'L17Pset', name: 'Pset 17', levels: levelsFor('L17Pset'), dependsOn: ['Lecture17', 'L16Pset'] },
    { id: 'Lecture18', name: 'Infinite Addition', levels: levelsFor('Lecture18'), dependsOn: ['Lecture17', 'L16Pset'] },
    { id: 'L18Pset', name: 'Pset 18', levels: levelsFor('L18Pset'), dependsOn: ['Lecture18', 'L17Pset', 'L13Pset'] },
    { id: 'Lecture19', name: 'Rearrangements', levels: levelsFor('Lecture19'), dependsOn: ['L17Pset', 'L18Pset'] },
    { id: 'Lecture20', name: 'Function Limits', levels: levelsFor('Lecture20'), dependsOn: ['L18Pset', 'Lecture19'] },
    { id: 'L20Pset', name: 'Pset 20', levels: levelsFor('L20Pset'), dependsOn: ['Lecture20', 'L18Pset'] },
    { id: 'Lecture21', name: 'Function Limits II', levels: levelsFor('Lecture21'), dependsOn: ['Lecture20'] },
    { id: 'Lecture22', name: 'Uniformity', levels: levelsFor('Lecture22'), dependsOn: ['Lecture21', 'L20Pset'] },
    { id: 'L22Pset', name: 'Pset 22', levels: levelsFor('L22Pset'), dependsOn: ['Lecture22', 'L20Pset'] },
    { id: 'Lecture23', name: 'Uniformity II: Continuity', levels: levelsFor('Lecture23'), dependsOn: ['Lecture22'] },
    { id: 'Lecture24', name: 'Topology', levels: levelsFor('Lecture24'), dependsOn: ['Lecture23', 'L22Pset'] },
    { id: 'L24Pset', name: 'Pset 24', levels: levelsFor('L24Pset'), dependsOn: ['Lecture24'] },
    { id: 'Lecture25', name: 'Swapping Limits and Integrals', levels: levelsFor('Lecture25'), dependsOn: ['L24Pset', 'Lecture24'] },
  ],
};

// ── Navigation helpers (unchanged) ──────────────────────────────────

export function parseHash(hash: string): NavigationState {
  const match = hash.match(/^#([^/]+)\/(\d+)$/);
  if (match) {
    const worldId = match[1];
    const levelIndex = parseInt(match[2], 10);
    const world = gameData.worlds.find(w => w.id === worldId);
    if (world && levelIndex >= 0 && levelIndex < world.levels.length) {
      return { kind: 'playing', worldId, levelIndex };
    }
  }
  return { kind: 'worldOverview' };
}

export function navToHash(nav: NavigationState): string {
  if (nav.kind === 'playing') return `#${nav.worldId}/${nav.levelIndex}`;
  return '#';
}

/** Topological sort of worlds into rows for DAG layout. */
export function getWorldRows(worlds: World[]): World[][] {
  const worldMap = new Map(worlds.map(w => [w.id, w]));
  const depths = new Map<string, number>();

  function getDepth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    const world = worldMap.get(id);
    if (!world || world.dependsOn.length === 0) {
      depths.set(id, 0);
      return 0;
    }
    const maxParent = Math.max(...world.dependsOn.map(getDepth));
    const depth = maxParent + 1;
    depths.set(id, depth);
    return depth;
  }

  worlds.forEach(w => getDepth(w.id));

  const maxDepth = Math.max(...Array.from(depths.values()), 0);
  const rows: World[][] = Array.from({ length: maxDepth + 1 }, () => []);
  worlds.forEach(w => rows[depths.get(w.id)!].push(w));
  return rows;
}
