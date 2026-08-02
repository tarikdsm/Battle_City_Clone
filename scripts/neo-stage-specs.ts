// scripts/neo-stage-specs.ts — what the twelve Neo stages ARE, as editor ops.
//
// Read this as a transcript of twelve authoring sessions: every entry is a
// press-drag-release of one of the editor's tools, with the mirror mode the
// session was in. `scripts/author-neo-stages.ts` replays them through
// `createEditor()` and writes the JSON.
//
// Content §3 gives each stage its motif and wave flavour; §4 gives the
// difficulty curve. What is here on top of that is the *idea* — the one thing a
// player should be able to name after one run. It ships in each file's `notes`
// and is repeated in the contact sheet, because a stage whose idea cannot be
// stated in a line is filler.
import type {
  Brush,
  MirrorMode,
  PaintMode,
  ShapeTool,
  Subcell,
} from '../src/editor/tools';
import type { EnemyType } from '../src/core/types';

/** A point, at tile resolution unless a subcell (0=TL 1=TR 2=BL 3=BR) is named. */
export type At = [tx: number, ty: number, sub?: Subcell];

export interface Op {
  tool: ShapeTool;
  brush: Brush;
  from: At;
  to: At;
  mode: PaintMode;
  /** `undefined` inherits the stage's mirror mode. */
  mirror?: MirrorMode;
}

/** A wave block, the way the ROM's own tables are shaped. */
export type WaveSegment = [type: EnemyType, count: number];

export interface StageSpec {
  id: string;
  name: string;
  /** The stage's one idea, in one line. Ships as the file's `notes`. */
  note: string;
  /** Content §4: neo-01 ≈ stage 20 pressure … neo-12 = 35. */
  effectiveStage: number;
  mirror: MirrorMode;
  ops: Op[];
  wave: WaveSegment[];
}

// --- the toolbar, as functions ---------------------------------------------

const at =
  (tool: ShapeTool, mode: PaintMode) =>
  (brush: Brush, from: At, to: At, mirror?: MirrorMode): Op => ({
    tool,
    brush,
    from,
    to,
    mode,
    mirror,
  });

/** Filled rectangle — the workhorse. */
const box = at('rectFill', 'tile');
/** Rectangle outline — rooms, forts, pockets. */
const room = at('rect', 'tile');
const line = at('line', 'tile');
const fillFrom = at('fill', 'tile');
/** The same three at half-tile resolution. */
const halfBox = at('rectFill', 'subcell');
const halfLine = at('line', 'subcell');

const dot = (brush: Brush, p: At, mirror?: MirrorMode): Op =>
  box(brush, p, p, mirror);
const flood = (brush: Brush, p: At, mirror?: MirrorMode): Op =>
  fillFrom(brush, p, p, mirror);

const H: MirrorMode = 'horizontal';
const OFF: MirrorMode = 'off';

// ---------------------------------------------------------------------------

export const NEO_SPECS: StageSpec[] = [
  // -------------------------------------------------------------------------
  {
    id: 'neo-01',
    name: 'First Frost',
    note:
      'Three ice avenues run spawn to base; the brick islands are the only ' +
      'brakes, so every duel on this stage is fought sliding.',
    effectiveStage: 20,
    mirror: H,
    ops: [
      // The avenues. The centre one runs all the way onto the base's doorstep.
      box('I', [0, 3], [1, 9]),
      box('I', [5, 1], [7, 10]),
      // The brakes: brick islands you can stop against, placed where a slide
      // out of an avenue would otherwise carry you into open ground.
      box('B', [3, 4], [4, 5]),
      box('B', [2, 8], [3, 8]),
      box('B', [0, 1], [1, 1]),
      dot('B', [2, 6]),
      // The base's shoulders — the centre avenue is left open on purpose.
      box('B', [3, 10], [4, 11]),
      // Half-tiles narrowing the centre avenue's mouth: the fast tanks arrive
      // through a gap barely wider than they are.
      halfLine('B', [4, 1, 1], [4, 1, 3]),
    ],
    wave: [
      ['basic', 2],
      ['fast', 6],
      ['power', 2],
      ['fast', 6],
      ['armor', 2],
      ['fast', 2],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-02',
    name: 'Twin Rivers',
    note:
      'Two rivers cut three lanes; only three bridges cross them, two behind ' +
      'brick doors, and the lane you leave unwatched is the lane they take.',
    effectiveStage: 21,
    mirror: H,
    ops: [
      // The rivers, in four runs each, leaving rows 3, 7 and 10 dry.
      box('W', [2, 1], [3, 2]),
      box('W', [2, 4], [3, 6]),
      box('W', [2, 8], [3, 9]),
      box('W', [2, 11], [3, 12]),
      // Bridges 1 and 3 are brick doors — crossing costs a shot and announces
      // itself. Bridge 2 (row 7) is open, and is therefore the contested one.
      box('B', [2, 3], [3, 3]),
      box('B', [2, 10], [3, 10]),
      // Embankments, so the lanes read as lanes rather than as one field.
      box('B', [4, 1], [4, 2]),
      box('B', [1, 8], [1, 9]),
      box('B', [4, 5], [4, 6]),
      // Two steel pilings in the centre lane: the middle spawn has the only
      // uncrossed run at the base, and this is what breaks its straight line.
      dot('S', [6, 4]),
      dot('S', [6, 8]),
      dot('B', [5, 10]),
      box('B', [5, 5], [5, 6]),
    ],
    wave: [
      ['basic', 2],
      ['power', 6],
      ['fast', 4],
      ['power', 4],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-03',
    name: 'The Orchard',
    note:
      'A canopy hides everyone from everyone; the two ploughed rows are the ' +
      'only clean sightlines on the stage, and both of them face the base.',
    effectiveStage: 23,
    mirror: H,
    ops: [
      box('T', [0, 1], [12, 3]),
      // Row 4 is ploughed — left bare.
      box('T', [0, 5], [12, 7]),
      // Row 8 is ploughed.
      box('T', [0, 9], [4, 11]),
      box('T', [5, 9], [7, 9]),
      // Brick hidden inside the trees: cover you cannot see until you are on
      // it, which is the whole point of an orchard.
      box('B', [2, 2], [3, 2]),
      box('B', [5, 6], [7, 6]),
      box('B', [4, 10], [4, 11]),
      box('B', [5, 10], [7, 10]),
      // A steel trunk in each ploughed row, so the sightlines are not free.
      dot('S', [3, 4]),
      dot('S', [2, 8]),
      // A pond and two clearings inside the canopy. The pond is the only
      // landmark in here — trees hide tanks, not terrain, so it is the one
      // place on the stage you can say where you are.
      box('W', [5, 2], [7, 2]),
      box('.', [1, 6], [2, 6]),
    ],
    wave: [
      ['basic', 8],
      ['armor', 2],
      ['basic', 4],
      ['fast', 2],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-04',
    name: 'Foundry',
    note:
      'A steel maze whose only doors are brick: until somebody reaches tier ' +
      'three the doors are the stage, and after that the maze stops being one.',
    effectiveStage: 24,
    mirror: H,
    ops: [
      // Two steel floors across the field…
      line('S', [0, 3], [12, 3]),
      line('S', [0, 8], [12, 8]),
      // …with brick doors punched through them, offset so no run is straight.
      dot('B', [2, 3]),
      dot('B', [6, 3]),
      dot('B', [4, 8]),
      // The bays between them. The centre spine starts one row below the top
      // door on purpose: a spine that met it would seal the bays off entirely,
      // which is exactly what the completability gate caught on the first run.
      line('S', [3, 4], [3, 7]),
      line('S', [6, 5], [6, 6]),
      box('B', [1, 5], [2, 6]),
      box('B', [4, 5], [5, 7]),
      box('B', [0, 1], [1, 2]),
      box('B', [4, 1], [5, 1]),
      // The pour floor: brick shoulders and a steel lintel over the base.
      box('B', [0, 10], [2, 10]),
      box('B', [4, 10], [4, 11]),
      dot('S', [6, 10]),
      halfBox('B', [5, 9, 2], [7, 9, 3]),
    ],
    wave: [
      ['power', 8],
      ['fast', 4],
      ['power', 4],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-05',
    name: 'Shatterfront',
    note:
      'Solid brick with one crossroads cut through it: every route you want ' +
      'you have to shoot, and by the last tank the labyrinth is a field.',
    effectiveStage: 25,
    mirror: H,
    ops: [
      // The block.
      box('B', [0, 1], [12, 11]),
      // The crossroads, cut out with the eraser.
      box('.', [6, 1], [6, 11]),
      box('.', [0, 6], [12, 6]),
      // Four narrow chambers, so the front has somewhere to open into.
      box('.', [2, 2], [2, 3]),
      box('.', [2, 9], [2, 10]),
      // …and two lumps left standing in the crossroads, so neither arm of it
      // is a free straight line from a spawn to the base.
      dot('B', [6, 3]),
      dot('B', [6, 9]),
      // Steel corner posts: the parts that never erode, and therefore the
      // shape the stage still has when the brick is gone.
      dot('S', [4, 4]),
      dot('S', [4, 8]),
      dot('S', [1, 6], OFF),
      dot('S', [11, 6], OFF),
      // Pre-eroded edges along the crossroads — half-tiles, as the originals
      // do it, so the cut reads as damage rather than as a corridor.
      halfLine('.', [5, 2, 1], [5, 5, 3]),
      halfLine('.', [7, 7, 0], [7, 10, 2]),
      halfBox('.', [2, 5, 2], [4, 5, 3]),
      // The base's own pocket, cut clear.
      box('.', [5, 10], [7, 10]),
      box('.', [4, 11], [4, 11]),
    ],
    wave: [
      ['basic', 5],
      ['fast', 5],
      ['power', 5],
      ['armor', 5],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-06',
    name: 'Frozen Harbor',
    note:
      'One sheet of ice with water on three sides: a turn taken too fast ' +
      'ends against the quay wall, in front of whoever was waiting there.',
    effectiveStage: 27,
    mirror: H,
    ops: [
      box('I', [4, 3], [8, 8]),
      // The slips. Bullets cross water, tanks do not — so these are firing
      // lanes into the sheet from outside it.
      box('W', [0, 4], [1, 7]),
      box('W', [0, 11], [1, 11]),
      // The quay: what a slide stops against.
      line('B', [3, 2], [9, 2]),
      box('B', [2, 10], [4, 10]),
      dot('S', [3, 3]),
      dot('S', [3, 8]),
      // Two moorings out on the sheet, so the middle is not featureless.
      dot('B', [5, 5]),
      box('B', [0, 9], [0, 10]),
      halfBox('B', [4, 4, 0], [4, 4, 2]),
    ],
    wave: [
      ['fast', 6],
      ['power', 4],
      ['fast', 4],
      ['power', 3],
      ['armor', 3],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-07',
    name: 'Greenwall',
    note:
      'A tree curtain you can shoot through but not see through, two tiles ' +
      'in front of a brick fort: they are inside it before you know they came.',
    effectiveStage: 28,
    mirror: H,
    ops: [
      box('T', [0, 1], [12, 2]),
      // The curtain. Three rows deep: two is a hedge you can see past at an
      // angle, three is a wall you have to walk into.
      box('T', [0, 4], [12, 6]),
      // The fort behind it, with one gate per side.
      room('B', [2, 8], [10, 11]),
      dot('.', [4, 8]),
      dot('.', [6, 8]),
      // Steel corner posts — the fort loses its walls but never its corners.
      dot('S', [2, 8]),
      dot('S', [2, 11]),
      box('T', [3, 9], [4, 10]),
      box('B', [0, 8], [1, 9]),
      box('B', [5, 3], [7, 3]),
      halfBox('B', [5, 9, 0], [7, 9, 1]),
    ],
    wave: [
      ['armor', 4],
      ['power', 4],
      ['basic', 2],
      ['power', 4],
      ['fast', 2],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-08',
    name: 'The Vault',
    note:
      'The eagle sits in a steel pocket with one brick throat: hold the ' +
      'throat and nothing gets in, leave it and everything does.',
    effectiveStage: 30,
    mirror: H,
    ops: [
      // The pocket. Steel on three sides, and the players spawn inside it.
      line('S', [3, 9], [9, 9]),
      line('S', [3, 10], [3, 12]),
      // The throat.
      dot('B', [6, 9]),
      // Trees in front of it: you cannot count what is queueing out there.
      box('T', [4, 7], [8, 8]),
      // The field above — open, because everything that matters is the door.
      box('W', [0, 5], [2, 6]),
      box('B', [4, 3], [8, 4]),
      box('B', [0, 1], [1, 2]),
      box('B', [1, 8], [2, 9]),
      dot('S', [6, 2]),
      halfBox('B', [3, 3, 0], [3, 3, 2]),
    ],
    wave: [
      ['basic', 4],
      ['fast', 4],
      ['power', 4],
      ['armor', 4],
      ['fast', 2],
      ['armor', 2],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-09',
    name: 'Mirrorworks',
    note:
      'Two identical halves with a steel spine between them: each player owns ' +
      'a side, and the side that is left alone is the side the base falls on.',
    effectiveStage: 31,
    mirror: H,
    ops: [
      // The spine. Nothing crosses below row 7, so the halves are separate
      // stages until somebody dies.
      line('S', [6, 7], [6, 10]),
      // One half, drawn once. The mirror draws the other, exactly — which is
      // the only reason this stage is worth the eleven strokes it takes.
      box('B', [1, 2], [4, 4]),
      dot('.', [2, 3]),
      dot('.', [2, 4]),
      box('T', [0, 4], [1, 5]),
      box('W', [1, 6], [2, 7]),
      box('B', [3, 7], [4, 7]),
      box('B', [2, 8], [3, 8]),
      box('T', [3, 9], [4, 10]),
      box('B', [4, 6], [5, 6]),
      box('B', [0, 9], [1, 10]),
      box('T', [2, 11], [3, 11]),
      dot('S', [4, 8]),
      box('B', [5, 1], [5, 5]),
      halfBox('B', [4, 11, 0], [4, 11, 1]),
    ],
    wave: [
      // A palindrome: the twentieth tank is the first one again. With 20
      // slots that forces every count even, which is what makes the two
      // halves of the wave mirror the two halves of the stage.
      ['armor', 4],
      ['power', 2],
      ['fast', 2],
      ['basic', 1],
      ['fast', 2],
      ['basic', 1],
      ['fast', 2],
      ['power', 2],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-10',
    name: 'Sandglass',
    note:
      'An hourglass with a one-tile waist of steel: the brick around it can ' +
      'be widened, the waist cannot, and everything has to come through.',
    effectiveStage: 32,
    mirror: H,
    ops: [
      // The two cones, drawn as diagonals and then flood-filled — the fill
      // stops dead on the diagonals, which is what makes this two drags
      // instead of eleven rectangles.
      line('B', [0, 1], [5, 6]),
      line('B', [0, 11], [5, 6]),
      flood('B', [0, 6]),
      // The waist itself: steel, so no amount of shooting widens it.
      dot('S', [5, 6]),
      dot('S', [4, 5]),
      dot('S', [4, 7]),
      // The upper chamber's pond — a long sightline for the power tanks the
      // brief hands this stage, and one they can shoot across and you cannot.
      box('W', [5, 2], [7, 3]),
      // The chambers. Cover, but never a wall across them: the whole stage is
      // the argument that you have to come through the waist eventually.
      box('B', [5, 4], [7, 4]),
      box('B', [5, 9], [7, 9]),
      box('B', [3, 10], [4, 10]),
      box('B', [2, 11], [3, 11]),
      dot('S', [6, 8]),
      halfBox('B', [5, 10, 0], [7, 10, 1]),
    ],
    wave: [
      ['power', 6],
      ['fast', 4],
      ['power', 4],
      ['armor', 6],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-11',
    name: 'Blackout',
    note:
      'Almost nothing to hide behind: four steel pillars, and every one is a ' +
      'corner two fast tanks can pin you into.',
    effectiveStage: 34,
    mirror: H,
    ops: [
      box('S', [3, 3], [4, 4]),
      box('S', [3, 8], [4, 9]),
      // The only brick on the field, and it is all around the base.
      box('B', [5, 10], [7, 10]),
      box('B', [4, 11], [4, 11]),
      // A thin rail at mid-field: the one piece of cover between the pillars,
      // and the only thing that stops a spawn-to-base straight line.
      halfBox('B', [5, 6, 0], [7, 6, 1]),
      halfBox('B', [0, 6, 0], [1, 6, 1]),
      dot('W', [6, 2]),
    ],
    wave: [
      ['fast', 8],
      ['basic', 2],
      ['fast', 6],
      ['armor', 4],
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'neo-12',
    name: 'Last Stand',
    note:
      'Three shells around the eagle — trees and water, then brick, then ice ' +
      '— and the armor wave eats them in that order while you slide.',
    effectiveStage: 35,
    mirror: H,
    ops: [
      // Shell one: soft. Trees you can shoot through, water you cannot cross,
      // one brick keystone. Three rows deep, with two gaps to walk in by.
      box('T', [0, 2], [3, 4]),
      box('W', [4, 2], [5, 4]),
      box('B', [6, 2], [6, 4]),
      dot('.', [1, 3]),
      dot('.', [6, 3]),
      // The wooded ground between shells one and two: cover for them, not for
      // you, because they are the ones arriving.
      box('T', [0, 5], [3, 6]),
      dot('T', [6, 6]),
      // Shell two: brick, two rows, with steel buttresses that outlive it and
      // two staggered gates so the way through is never the way you came.
      box('B', [1, 7], [11, 8]),
      dot('.', [3, 7]),
      dot('.', [6, 8]),
      dot('S', [1, 7]),
      dot('S', [5, 8]),
      // Shell three: the last brick, standing on ice — the final defence is
      // fought sliding, which is what makes it the last stand and not a wall.
      box('B', [2, 10], [10, 10]),
      dot('.', [5, 10]),
      box('B', [2, 9], [2, 9]),
      box('I', [2, 11], [4, 12]),
      halfBox('B', [1, 10, 0], [1, 10, 1]),
    ],
    wave: [
      ['fast', 4],
      ['power', 4],
      ['armor', 12],
    ],
  },
];
