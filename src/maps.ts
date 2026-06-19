import { Wall } from './types';

export const MAP_WIDTH = 900;
export const MAP_HEIGHT = 600;
export const PLAYER_RADIUS = 16;
export const POWERUP_RADIUS = 14;
export const PORTAL_RADIUS = 22;

export interface Portal {
  x: number;
  y: number;
}

export const MAP_PORTALS: Record<'arena' | 'maze' | 'open' | 'blocks', Portal[]> = {
  open: [
    { x: 120, y: 300 },
    { x: 780, y: 300 }
  ],
  arena: [
    { x: 80, y: 300 },
    { x: 820, y: 300 }
  ],
  maze: [
    { x: 80, y: 300 },
    { x: 820, y: 300 }
  ],
  blocks: [
    { x: 80, y: 80 },
    { x: 820, y: 520 }
  ]
};

export const MAP_WALLS: Record<'arena' | 'maze' | 'open' | 'blocks', Wall[]> = {
  open: [
    // Center pillar
    { id: 'open_center', x: MAP_WIDTH / 2 - 40, y: MAP_HEIGHT / 2 - 40, w: 80, h: 80 },
    // Outer tactical bumpers
    { id: 'open_lt', x: 220, y: 150, w: 80, h: 40 },
    { id: 'open_rt', x: MAP_WIDTH - 300, y: 150, w: 80, h: 40 },
    { id: 'open_lb', x: 220, y: MAP_HEIGHT - 190, w: 80, h: 40 },
    { id: 'open_rb', x: MAP_WIDTH - 300, y: MAP_HEIGHT - 190, w: 80, h: 40 },
    // Upper and lower barriers
    { id: 'open_top', x: MAP_WIDTH / 2 - 120, y: 70, w: 240, h: 30 },
    { id: 'open_bottom', x: MAP_WIDTH / 2 - 120, y: MAP_HEIGHT - 100, w: 240, h: 30 }
  ],
  arena: [
    // Central split barriers
    { id: 'arena_mid_top', x: MAP_WIDTH / 2 - 15, y: 80, w: 30, h: 140 },
    { id: 'arena_mid_bottom', x: MAP_WIDTH / 2 - 15, y: MAP_HEIGHT - 220, w: 30, h: 140 },
    // Side bumpers
    { id: 'arena_left_mid', x: 150, y: MAP_HEIGHT / 2 - 60, w: 100, h: 30 },
    { id: 'arena_right_mid', x: MAP_WIDTH - 250, y: MAP_HEIGHT / 2 - 60, w: 100, h: 30 },
    // Outer corners
    { id: 'arena_corner_tl', x: 120, y: 100, w: 30, h: 100 },
    { id: 'arena_corner_tr', x: MAP_WIDTH - 150, y: 100, w: 30, h: 100 },
    { id: 'arena_corner_bl', x: 120, y: MAP_HEIGHT - 200, w: 30, h: 100 },
    { id: 'arena_corner_br', x: MAP_WIDTH - 150, y: MAP_HEIGHT - 200, w: 30, h: 100 },
    // Additional reef blocks for more high-intensity tactical spots
    { id: 'arena_reefs_tl', x: 280, y: 130, w: 40, h: 120 },
    { id: 'arena_reefs_tr', x: MAP_WIDTH - 320, y: 130, w: 40, h: 120 },
    { id: 'arena_reefs_bl', x: 280, y: 350, w: 40, h: 120 },
    { id: 'arena_reefs_br', x: MAP_WIDTH - 320, y: 350, w: 40, h: 120 }
  ],
  maze: [
    // Outer border blocks and symmetric walls
    { id: 'maze_c1', x: 120, y: 80, w: 120, h: 30 },
    { id: 'maze_c2', x: 120, y: 80, w: 30, h: 120 },
    
    { id: 'maze_c3', x: MAP_WIDTH - 240, y: 80, w: 120, h: 30 },
    { id: 'maze_c4', x: MAP_WIDTH - 150, y: 80, w: 30, h: 120 },
    
    { id: 'maze_c5', x: 120, y: MAP_HEIGHT - 110, w: 120, h: 30 },
    { id: 'maze_c6', x: 120, y: MAP_HEIGHT - 200, w: 30, h: 120 },
    
    { id: 'maze_c7', x: MAP_WIDTH - 240, y: MAP_HEIGHT - 110, w: 120, h: 30 },
    { id: 'maze_c8', x: MAP_WIDTH - 150, y: MAP_HEIGHT - 200, w: 30, h: 120 },
    
    // Middle vertical lines
    { id: 'maze_mv1', x: 300, y: 180, w: 35, h: 240 },
    { id: 'maze_mv2', x: MAP_WIDTH - 335, y: 180, w: 35, h: 240 },
    
    // Middle horizontal splitter
    { id: 'maze_mh1', x: MAP_WIDTH / 2 - 120, y: MAP_HEIGHT / 2 - 15, w: 240, h: 30 },
    { id: 'maze_mh2', x: MAP_WIDTH / 2 - 15, y: 100, w: 30, h: 80 },
    { id: 'maze_mh3', x: MAP_WIDTH / 2 - 15, y: MAP_HEIGHT - 180, w: 30, h: 80 },

    // Additional Egyptian ruins blocks to make it a deep labyrinth
    { id: 'maze_extra_l1', x: 200, y: 180, w: 100, h: 30 },
    { id: 'maze_extra_r1', x: MAP_WIDTH - 300, y: 180, w: 100, h: 30 },
    { id: 'maze_extra_l2', x: 200, y: MAP_HEIGHT - 210, w: 100, h: 30 },
    { id: 'maze_extra_r2', x: MAP_WIDTH - 300, y: MAP_HEIGHT - 210, w: 100, h: 30 },
    { id: 'maze_extra_mid_l', x: MAP_WIDTH / 2 - 120, y: 140, w: 80, h: 30 },
    { id: 'maze_extra_mid_r', x: MAP_WIDTH / 2 + 40, y: 140, w: 80, h: 30 },
    { id: 'maze_extra_mid_bl', x: MAP_WIDTH / 2 - 120, y: MAP_HEIGHT - 170, w: 80, h: 30 },
    { id: 'maze_extra_mid_br', x: MAP_WIDTH / 2 + 40, y: MAP_HEIGHT - 170, w: 80, h: 30 }
  ],
  blocks: [
    // Columns and rows grid layout
    { id: 'b_1', x: 150, y: 120, w: 80, h: 80 },
    { id: 'b_2', x: 410, y: 120, w: 80, h: 80 },
    { id: 'b_3', x: 670, y: 120, w: 80, h: 80 },
    
    { id: 'b_4', x: 150, y: 400, w: 80, h: 80 },
    { id: 'b_5', x: 410, y: 400, w: 80, h: 80 },
    { id: 'b_6', x: 670, y: 400, w: 80, h: 80 },
    
    // Small side tabs
    { id: 'b_l', x: 40, y: MAP_HEIGHT / 2 - 40, w: 80, h: 30 },
    { id: 'b_r', x: MAP_WIDTH - 120, y: MAP_HEIGHT / 2 - 40, w: 80, h: 30 },

    // Middle core pillars in horizontal gaps
    { id: 'b_mid_c', x: 410, y: 260, w: 80, h: 80 },
    { id: 'b_mid_l', x: 150, y: 260, w: 80, h: 80 },
    { id: 'b_mid_r', x: 670, y: 260, w: 80, h: 80 },

    // Dynamic tiny connector stones
    { id: 'b_cl_1', x: 285, y: 190, w: 40, h: 40 },
    { id: 'b_cl_2', x: 285, y: 370, w: 40, h: 40 },
    { id: 'b_cr_1', x: 575, y: 190, w: 40, h: 40 },
    { id: 'b_cr_2', x: 575, y: 370, w: 40, h: 40 },

    // Secondary diagonal corner pillars (avoiding top-left and bottom-right portals!)
    { id: 'b_c_tr', x: MAP_WIDTH - 80, y: 40, w: 40, h: 40 },
    { id: 'b_c_bl', x: 40, y: MAP_HEIGHT - 80, w: 40, h: 40 }
  ]
};

// Check point/radius wall collision helper
export function checkWallCollision(
  x: number,
  y: number,
  radius: number,
  walls: Wall[]
): { collided: boolean; x: number; y: number; normalX: number; normalY: number } | null {
  // Check outer borders
  if (x - radius < 0) {
    return { collided: true, x: radius, y, normalX: 1, normalY: 0 };
  }
  if (x + radius > MAP_WIDTH) {
    return { collided: true, x: MAP_WIDTH - radius, y, normalX: -1, normalY: 0 };
  }
  if (y - radius < 0) {
    return { collided: true, x, y: radius, normalX: 0, normalY: 1 };
  }
  if (y + radius > MAP_HEIGHT) {
    return { collided: true, x, y: MAP_HEIGHT - radius, normalX: 0, normalY: -1 };
  }

  // Check walls
  for (const wall of walls) {
    // Find closest point on the rectangle to the circle's center
    const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.w));
    const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.h));

    // Calculate distance between circle's center and this closest point
    const distanceX = x - closestX;
    const distanceY = y - closestY;
    const distanceSquared = distanceX * distanceX + distanceY * distanceY;

    if (distanceSquared < radius * radius) {
      const distance = Math.sqrt(distanceSquared) || 0.001;
      const overlap = radius - distance;

      // Calculate collision normal (pointing from wall to circle)
      let normX = distanceX / distance;
      let normY = distanceY / distance;

      // If circle is inside, push it out
      if (distanceX === 0 && distanceY === 0) {
        // Resolve edge case
        normX = 1;
        normY = 0;
      }

      return {
        collided: true,
        x: x + normX * overlap,
        y: y + normY * overlap,
        normalX: normX,
        normalY: normY
      };
    }
  }

  return null;
}
