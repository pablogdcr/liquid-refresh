import { Dimensions } from 'react-native';

// Single source of truth for the plumbing system. The RN mosaic tiles and
// the GPU capsule geometry (pipes, tank, reservoir) are computed from the
// same point values, so they stay pixel-aligned.

const win = Dimensions.get('window');
export const SCREEN_W = win.width;
export const SCREEN_H = win.height;

export const MARGIN = 24;
export const PIPE_R = 8;
export const EDGE_PIPE_X = 12; // pipe centerline hugging the screen edges

// Top tank (a horizontal capsule the pumped water collects in).
export const TANK_CY = 124;
export const TANK_R = 60;

// Mosaic: 2 columns x 3 rows of glass tiles.
export const MOSAIC_TOP = 214;
export const TILE_H = 104;
export const ROW_GUTTER = 26;
export const CENTER_GUTTER = 36;
export const TILE_W = (SCREEN_W - 2 * MARGIN - CENTER_GUTTER) / 2;
export const ROW_YS = [
  MOSAIC_TOP,
  MOSAIC_TOP + TILE_H + ROW_GUTTER,
  MOSAIC_TOP + 2 * (TILE_H + ROW_GUTTER),
] as const;
// Pipe centerlines run through the middle of the row gutters / center gutter.
const GUTTER1_Y = ROW_YS[1] - ROW_GUTTER / 2;
const GUTTER2_Y = ROW_YS[2] - ROW_GUTTER / 2;
const CENTER_X = SCREEN_W / 2;

// Bottom reservoir (where the water lives at rest).
export const RESERVOIR_CY = 738;
export const RESERVOIR_R = 44;

export interface CapsulePt {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  /** 1 = pipe segment, pumped along a->b. 0 = passive container. */
  flow: number;
}

// The serpentine: reservoir -> right edge up -> across -> left edge up ->
// across -> center gutter up -> into the tank. Overlapping capsules form
// the continuous channel (tank/pipe junctions need no special casing).
export const CAPSULES_PT: CapsulePt[] = [
  // containers
  {
    ax: MARGIN + TANK_R, ay: TANK_CY,
    bx: SCREEN_W - MARGIN - TANK_R, by: TANK_CY,
    r: TANK_R, flow: 0,
  },
  {
    ax: MARGIN + RESERVOIR_R, ay: RESERVOIR_CY,
    bx: SCREEN_W - MARGIN - RESERVOIR_R, by: RESERVOIR_CY,
    r: RESERVOIR_R, flow: 0,
  },
  // pump line: starts inside the reservoir so it suctions water out
  { ax: CENTER_X, ay: RESERVOIR_CY + 8, bx: SCREEN_W - EDGE_PIPE_X, by: RESERVOIR_CY + 8, r: PIPE_R, flow: 1 },
  { ax: SCREEN_W - EDGE_PIPE_X, ay: RESERVOIR_CY + 8, bx: SCREEN_W - EDGE_PIPE_X, by: GUTTER2_Y, r: PIPE_R, flow: 1 },
  { ax: SCREEN_W - EDGE_PIPE_X, ay: GUTTER2_Y, bx: EDGE_PIPE_X, by: GUTTER2_Y, r: PIPE_R, flow: 1 },
  { ax: EDGE_PIPE_X, ay: GUTTER2_Y, bx: EDGE_PIPE_X, by: GUTTER1_Y, r: PIPE_R, flow: 1 },
  { ax: EDGE_PIPE_X, ay: GUTTER1_Y, bx: CENTER_X, by: GUTTER1_Y, r: PIPE_R, flow: 1 },
  { ax: CENTER_X, ay: GUTTER1_Y, bx: CENTER_X, by: TANK_CY + 16, r: PIPE_R, flow: 1 },
];

export const MAX_SHAPES = CAPSULES_PT.length; // 8

// World space: y in [0, 1] over the full screen height, x in [0, aspect].
export const WORLD_ASPECT = SCREEN_W / SCREEN_H;
export const toWorld = (pt: number) => pt / SCREEN_H;
