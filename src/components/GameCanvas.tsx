import { useEffect, useRef, useState } from 'react';
import { Room, Player } from '../types';
import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, POWERUP_RADIUS, MAP_WALLS, checkWallCollision, MAP_PORTALS, PORTAL_RADIUS } from '../maps';

// Utility helper to safely darken/lighten color hex hashes for 3D depth-shading
function shadeColor(color: string, percent: number): string {
  if (!color || !color.startsWith('#')) return color;
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  const rClamped = Math.max(0, Math.min(255, R));
  const gClamped = Math.max(0, Math.min(255, G));
  const bClamped = Math.max(0, Math.min(255, B));
  return '#' + (0x1000000 + rClamped * 0x10000 + gClamped * 0x100 + bClamped).toString(16).slice(1);
}

interface GameCanvasProps {
  room: Room;
  personalId: string;
  ws: any;
}

export default function GameCanvas({ room, personalId, ws }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  
  // Game coordinates of current player to run client-side prediction
  const playerPosRef = useRef({ x: 400, y: 300 });
  const otherPlayersLerpRef = useRef<Record<string, { x: number; y: number }>>({});
  
  // Joystick / touch coordinates for mobile play
  const [isMobile, setIsMobile] = useState(false);
  const touchDirectionRef = useRef({ x: 0, y: 0 });
  const [activeTouchKeys, setActiveTouchKeys] = useState<Record<string, boolean>>({});

  // Keyboard input state
  const keysPressedRef = useRef<Record<string, boolean>>({});

  // Detect Mobile
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.matchMedia('(max-width: 768px)').matches || ('ontouchstart' in window));
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Update starting position when room begins, and snap sync during teleportation or respawns
  useEffect(() => {
    const localPlayer = room.players[personalId];
    if (localPlayer) {
      const dx = playerPosRef.current.x - localPlayer.x;
      const dy = playerPosRef.current.y - localPlayer.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Snap position if room is not playing, player is dead/respawned, or there is a major teleport (dist > 140)
      if (room.status !== 'playing' || !localPlayer.isAlive || dist > 140) {
        playerPosRef.current = { x: localPlayer.x, y: localPlayer.y };
      }
    }
  }, [
    room.status,
    personalId,
    room.players?.[personalId]?.isAlive,
    room.players?.[personalId]?.lastTeleportTime
  ]);

  // Set keyboard listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'w', 'arrowdown', 's', 'arrowleft', 'a', 'arrowright', 'd'].includes(k)) {
        keysPressedRef.current[k] = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'w', 'arrowdown', 's', 'arrowleft', 'a', 'arrowright', 'd'].includes(k)) {
        keysPressedRef.current[k] = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Game Loop for updating local player physics and rendering
  useEffect(() => {
    let animationId: number;

    const gameLoop = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animationId = requestAnimationFrame(gameLoop);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animationId = requestAnimationFrame(gameLoop);
        return;
      }

      const activeConfig = room.config;
      const localPlayer = room.players[personalId];
      const walls = MAP_WALLS[activeConfig.map] || [];

      // Only update position if player is active, alive, and game is active
      if (localPlayer && localPlayer.isAlive && room.status === 'playing') {
        const nowTs = Date.now();
        const isFrozen = nowTs < localPlayer.frozenUntil;

        if (!isFrozen) {
          // 1. DETERMINE INPUT DIRECTION
          let dx = 0;
          let dy = 0;

          // Keyboard checks
          if (keysPressedRef.current['w'] || keysPressedRef.current['arrowup']) dy -= 1;
          if (keysPressedRef.current['s'] || keysPressedRef.current['arrowdown']) dy += 1;
          if (keysPressedRef.current['a'] || keysPressedRef.current['arrowleft']) dx -= 1;
          if (keysPressedRef.current['d'] || keysPressedRef.current['arrowright']) dx += 1;

          // Touch checks (mobile buttons)
          if (touchDirectionRef.current.x !== 0 || touchDirectionRef.current.y !== 0) {
            dx = touchDirectionRef.current.x;
            dy = touchDirectionRef.current.y;
          }

          // Normalize vector to avoid faster diagonal speeds
          let normalLength = Math.sqrt(dx * dx + dy * dy);
          if (normalLength > 0) {
            dx /= normalLength;
            dy /= normalLength;
          }

          // 2. APPLY SPEEDS
          // Speed settings
          let baseSpeed = 5.0;
          if (activeConfig.speed === 'slow') baseSpeed = 3.5;
          else if (activeConfig.speed === 'fast') baseSpeed = 6.8;
          else if (activeConfig.speed === 'insane') baseSpeed = 9.0;

          // 10% movement buff if IT to help chase down
          const speedMultiplier = localPlayer.isIt ? 1.12 : 1.0;
          // 40% buff if collected speed boost
          const speedBoostMultiplier = nowTs < localPlayer.speedBoostUntil ? 1.4 : 1.0;

          const speed = baseSpeed * speedMultiplier * speedBoostMultiplier;

          // 3. APPLY AND COLLIDE
          const oldX = playerPosRef.current.x;
          const oldY = playerPosRef.current.y;

          let targetX = oldX + dx * speed;
          let targetY = oldY + dy * speed;

          // Collision check against walls
          const collisionResolution = checkWallCollision(targetX, targetY, PLAYER_RADIUS, walls);
          if (collisionResolution) {
            targetX = collisionResolution.x;
            targetY = collisionResolution.y;
          }

          // Bound within arena explicitly just in case
          targetX = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, targetX));
          targetY = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, targetY));

          // Predict and warp player coordinates instantly through portals
          const portals = MAP_PORTALS[room.config.map];
          if (portals && portals.length === 2) {
            const nowTs = Date.now();
            const lastTele = (localPlayer as any).lastTeleportTime || 0;
            if (nowTs - lastTele > 1500) {
              for (let i = 0; i < 2; i++) {
                const portal = portals[i];
                const pdx = targetX - portal.x;
                const pdy = targetY - portal.y;
                const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
                if (pdist < PLAYER_RADIUS + PORTAL_RADIUS) {
                  const otherPortal = portals[1 - i];
                  targetX = otherPortal.x;
                  targetY = otherPortal.y;
                  (localPlayer as any).lastTeleportTime = nowTs;
                  break;
                }
              }
            }
          }

          // If moved, save state and send ws message
          if (targetX !== oldX || targetY !== oldY) {
            playerPosRef.current = { x: targetX, y: targetY };
            
            if (ws && ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'move',
                  x: targetX,
                  y: targetY,
                  vx: dx,
                  vy: dy
                })
              );
            }
          }
        }
      }

      // 4. DRAW GRAPHICS FOR THE SCREEN WITH 3D PERSPECTIVE PROJECTION
      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

      // Define 3D projection mathematical system -> Optimized to a beautiful flat surface!
      // Here, the ground coordinate is mapped 1:1 to create a perfectly flat play surface.
      // We keep a gentle, gorgeous vertical elevation offset for wz (objects/players/walls height) to create pop-up visual height (classic retro feel) without tilting the ground!
      const project = (wx: number, wy: number, wz: number = 0) => {
        return { x: wx, y: wy - wz * 0.72, scale: 1.0 };
      };

      // 3D Extrusion Solid Slabs Generator for walls
      const draw3DBox = (
        bx: number,
        by: number,
        bw: number,
        bh: number,
        H: number,
        colorTop: string,
        colorSide: string
      ) => {
        const p1 = project(bx, by, 0);
        const p2 = project(bx + bw, by, 0);
        const p3 = project(bx + bw, by + bh, 0);
        const p4 = project(bx, by + bh, 0);

        const t1 = project(bx, by, H);
        const t2 = project(bx + bw, by, H);
        const t3 = project(bx + bw, by + bh, H);
        const t4 = project(bx, by + bh, H);

        // Sides: Back
        ctx.fillStyle = shadeColor('#0F172A', -15);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(t2.x, t2.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.closePath();
        ctx.fill();

        // Sides: Left
        ctx.fillStyle = shadeColor(colorSide, -30);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p4.x, p4.y);
        ctx.lineTo(t4.x, t4.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.closePath();
        ctx.fill();

        // Sides: Right
        ctx.fillStyle = shadeColor(colorSide, -18);
        ctx.beginPath();
        ctx.moveTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.lineTo(t3.x, t3.y);
        ctx.lineTo(t2.x, t2.y);
        ctx.closePath();
        ctx.fill();

        // Sides: Front (facing player, illuminated)
        ctx.fillStyle = colorSide;
        ctx.beginPath();
        ctx.moveTo(p4.x, p4.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.lineTo(t3.x, t3.y);
        ctx.lineTo(t4.x, t4.y);
        ctx.closePath();
        ctx.fill();

        // Top Cap
        ctx.fillStyle = colorTop;
        ctx.beginPath();
        ctx.moveTo(t1.x, t1.y);
        ctx.lineTo(t2.x, t2.y);
        ctx.lineTo(t3.x, t3.y);
        ctx.lineTo(t4.x, t4.y);
        ctx.closePath();
        ctx.fill();

        // Highlight stroke rim
        ctx.strokeStyle = shadeColor(colorTop, 30);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(t1.x, t1.y);
        ctx.lineTo(t2.x, t2.y);
        ctx.lineTo(t3.x, t3.y);
        ctx.lineTo(t4.x, t4.y);
        ctx.closePath();
        ctx.stroke();
      };

      // 1. Draw Environment Sky & Hills based on Active Map Layout
      const activeMap = room.config.map;

      if (activeMap === 'open') {
        // SUMMER GARDEN
        const skyGrad = ctx.createLinearGradient(0, 0, 0, MAP_HEIGHT);
        skyGrad.addColorStop(0, '#38BDF8'); // sunny sky-blue
        skyGrad.addColorStop(0.6, '#7DD3FC'); // light cyan sky
        skyGrad.addColorStop(1, '#F0FDFA'); // warm white horizon
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

        const drawHills = (color: string, offsetMultiplier: number, heightAmp: number) => {
          const timeOffset = (Date.now() / 5000) * offsetMultiplier;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(0, MAP_HEIGHT);
          for (let x = 0; x <= MAP_WIDTH; x += 30) {
            const y = MAP_HEIGHT / 2 + 50 + Math.sin(x * 0.005 + timeOffset) * heightAmp + Math.cos(x * 0.012) * 15;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(MAP_WIDTH, MAP_HEIGHT);
          ctx.closePath();
          ctx.fill();
        };
        drawHills('#15803D', 0.15, 30); // Darker grass hills
        drawHills('#22C55E', -0.22, 18); // Brighter green hills

      } else if (activeMap === 'arena') {
        // SANDY BEACH (Sunset marine look!)
        const skyGrad = ctx.createLinearGradient(0, 0, 0, MAP_HEIGHT);
        skyGrad.addColorStop(0, '#0284C7'); // tropico sky blue
        skyGrad.addColorStop(0.5, '#FDBA74'); // warm orange-peach sunset glow
        skyGrad.addColorStop(1, '#FDA4AF'); // warm coral twilight rose
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

        const drawWaves = (color: string, offsetMultiplier: number, heightAmp: number) => {
          const timeOffset = (Date.now() / 3200) * offsetMultiplier;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(0, MAP_HEIGHT);
          for (let x = 0; x <= MAP_WIDTH; x += 30) {
            const y = MAP_HEIGHT / 2 + 45 + Math.sin(x * 0.01 + timeOffset) * heightAmp + Math.cos(x * 0.02) * 8;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(MAP_WIDTH, MAP_HEIGHT);
          ctx.closePath();
          ctx.fill();
        };
        drawWaves('#0E7490', 0.25, 20); // Far deep teal wave-ridge
        drawWaves('#06B6D4', -0.32, 12); // Near sparkling light turquoise waves

      } else if (activeMap === 'maze') {
        // EGYPTIAN DESERT (Golden heat haze sand dunes under sunny amber)
        const skyGrad = ctx.createLinearGradient(0, 0, 0, MAP_HEIGHT);
        skyGrad.addColorStop(0, '#D97706'); // warm golden amber heat haze
        skyGrad.addColorStop(0.55, '#B45309'); // terracotta terracotta gradient
        skyGrad.addColorStop(1, '#78350F'); // deep ancient rust ground dust
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

        const drawDunes = (color: string, offsetMultiplier: number, heightAmp: number) => {
          const timeOffset = (Date.now() / 8200) * offsetMultiplier;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(0, MAP_HEIGHT);
          for (let x = 0; x <= MAP_WIDTH; x += 40) {
            const y = MAP_HEIGHT / 2 + 58 + Math.sin(x * 0.003 + timeOffset) * heightAmp + Math.cos(x * 0.008) * 12;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(MAP_WIDTH, MAP_HEIGHT);
          ctx.closePath();
          ctx.fill();
        };
        drawDunes('#92400E', 0.1, 40); // Far dark sand dunes
        drawDunes('#D97706', -0.15, 25); // Close golden light reflection dunes

      } else {
        // WINTER MOUNTAINS (blocks - original preset)
        const skyGrad = ctx.createLinearGradient(0, 0, 0, MAP_HEIGHT);
        skyGrad.addColorStop(0, '#93C5FD'); // light winter blue
        skyGrad.addColorStop(0.4, '#C7D2FE'); // lavender slate
        skyGrad.addColorStop(1, '#EEF2F6'); // Arctic white horizon
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

        const drawHills = (color: string, offsetMultiplier: number, heightAmp: number) => {
          const timeOffset = (Date.now() / 5000) * offsetMultiplier;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(0, MAP_HEIGHT);
          for (let x = 0; x <= MAP_WIDTH; x += 30) {
            const y = MAP_HEIGHT / 2 + 50 + Math.sin(x * 0.005 + timeOffset) * heightAmp + Math.cos(x * 0.012) * 15;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(MAP_WIDTH, MAP_HEIGHT);
          ctx.closePath();
          ctx.fill();
        };
        drawHills('#C7D2FE', 0.15, 35);
        drawHills('#E0E7FF', -0.22, 22);
      }

      // Draw drifting soft fluffy background clouds
      const cloudTime = Date.now() / 15000;
      const clouds = [
        { cx: (cloudTime * 45) % (MAP_WIDTH + 180) - 90, cy: 75, scale: 0.95 },
        { cx: (cloudTime * 25 + 450) % (MAP_WIDTH + 180) - 90, cy: 125, scale: 1.15 },
        { cx: (cloudTime * 32 + 200) % (MAP_WIDTH + 180) - 90, cy: 55, scale: 0.8 }
      ];
      ctx.fillStyle = activeMap === 'maze' 
        ? 'rgba(254, 243, 199, 0.45)' // sand golden sky haze for desert
        : (activeMap === 'arena' ? 'rgba(244, 63, 94, 0.22)' : 'rgba(255, 255, 255, 0.72)');
      clouds.forEach(cl => {
        ctx.beginPath();
        ctx.arc(cl.cx, cl.cy, 22 * cl.scale, 0, Math.PI * 2);
        ctx.arc(cl.cx + 18 * cl.scale, cl.cy - 12 * cl.scale, 28 * cl.scale, 0, Math.PI * 2);
        ctx.arc(cl.cx + 42 * cl.scale, cl.cy, 20 * cl.scale, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
      });

      // 2. Draw 3D Arena Ground Floor plate with customized colors
      const fl1 = project(0, 0, 0);
      const fl2 = project(MAP_WIDTH, 0, 0);
      const fl3 = project(MAP_WIDTH, MAP_HEIGHT, 0);
      const fl4 = project(0, MAP_HEIGHT, 0);

      if (activeMap === 'open') {
        ctx.fillStyle = '#86EFAC'; // Summer Meadow rich grassy green
      } else if (activeMap === 'arena') {
        ctx.fillStyle = '#FEF08A'; // Beach sun golden sand
      } else if (activeMap === 'maze') {
        ctx.fillStyle = '#F6E0B1'; // Desert Egyptian clay space sand
      } else {
        ctx.fillStyle = '#E2E8F0'; // Snowy white/icy platform
      }
      ctx.beginPath();
      ctx.moveTo(fl1.x, fl1.y);
      ctx.lineTo(fl2.x, fl2.y);
      ctx.lineTo(fl3.x, fl3.y);
      ctx.lineTo(fl4.x, fl4.y);
      ctx.closePath();
      ctx.fill();

      // Soft layout glowing platform boundary lines
      if (activeMap === 'open') {
        ctx.strokeStyle = 'rgba(22, 163, 74, 0.5)'; // green nature halo
      } else if (activeMap === 'arena') {
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.5)'; // golden sand halo
      } else if (activeMap === 'maze') {
        ctx.strokeStyle = 'rgba(180, 83, 9, 0.5)'; // desert sunset copper borders
      } else {
        ctx.strokeStyle = 'rgba(147, 197, 253, 0.6)'; // winter frost
      }
      ctx.lineWidth = 4;
      ctx.stroke();

      // 3. Draw Beautiful structural grids flat on platform floor
      if (activeMap === 'open') {
        ctx.strokeStyle = '#4ADE80'; // grass
      } else if (activeMap === 'arena') {
        ctx.strokeStyle = '#EAB308'; // wet golden sand
      } else if (activeMap === 'maze') {
        ctx.strokeStyle = '#D97706'; // copper sandstone lines
      } else {
        ctx.strokeStyle = '#CBD5E1'; // icy blue grey
      }
      ctx.lineWidth = 1;
      const gridSizeRef = 40;
      for (let x = 0; x <= MAP_WIDTH; x += gridSizeRef) {
        const startP = project(x, 0, 0);
        const endP = project(x, MAP_HEIGHT, 0);
        ctx.beginPath();
        ctx.moveTo(startP.x, startP.y);
        ctx.lineTo(endP.x, endP.y);
        ctx.stroke();
      }
      for (let y = 0; y <= MAP_HEIGHT; y += gridSizeRef) {
        const startP = project(0, y, 0);
        const endP = project(MAP_WIDTH, y, 0);
        ctx.beginPath();
        ctx.moveTo(startP.x, startP.y);
        ctx.lineTo(endP.x, endP.y);
        ctx.stroke();
      }

      // 4. Draw 3D Platform Rim / Outer Boundary Walls
      const borderH = 22;
      let topCol = '#FFFFFF';
      let sideCol = '#312E81';

      if (activeMap === 'open') {
        topCol = '#4D7C0F'; // moss hedge top
        sideCol = '#5C4033'; // dark bark wood logs
      } else if (activeMap === 'arena') {
        topCol = '#22D3EE'; // aquatic cyan foam
        sideCol = '#7C2D12'; // dry driftwood mahogany
      } else if (activeMap === 'maze') {
        topCol = '#FACC15'; // shimmering brass yellow
        sideCol = '#92400E'; // terracotta sandstone bricks
      } else {
        topCol = '#FFFFFF'; // frosty snowcap
        sideCol = '#312E81'; // solid indigo rock
      }
      draw3DBox(-8, -8, MAP_WIDTH + 16, 8, borderH, topCol, sideCol); // Top wall
      draw3DBox(-8, MAP_HEIGHT, MAP_WIDTH + 16, 8, borderH, topCol, sideCol); // Bottom wall
      draw3DBox(-8, 0, 8, MAP_HEIGHT, borderH, topCol, sideCol); // Left wall
      draw3DBox(MAP_WIDTH, 0, 8, MAP_HEIGHT, borderH, topCol, sideCol); // Right wall

      // 5. Draw 3D Walls for active map layout in customized styles
      walls.forEach(wall => {
        let wtCol = '#FFFFFF';
        let wsCol = '#4338CA';
        if (activeMap === 'open') {
          wtCol = '#22C55E'; // green moss shrubs
          wsCol = '#78350F'; // log brown sides
        } else if (activeMap === 'arena') {
          wtCol = '#FEF9C3'; // thatched umbrella straw cream
          wsCol = '#0284C7'; // tropical marine sea blue blocks
        } else if (activeMap === 'maze') {
          wtCol = '#FBBF24'; // polished pyramids gold tops
          wsCol = '#B45309'; // Sandstone clay hieroglyphic bricks
        } else {
          wtCol = '#FFFFFF'; // Winter snowy top
          wsCol = '#4338CA'; // Winter royal indigo blocks
        }
        draw3DBox(wall.x, wall.y, wall.w, wall.h, 36, wtCol, wsCol);
      });

      // ==========================================
      // ========= 3D ENVIRONMENT GENERATORS ======
      // ==========================================

      // WINTER generators
      const draw3DPineTree = (wx: number, wy: number) => {
        const trunkProj = project(wx, wy, 0);
        const leaf1Proj = project(wx, wy, 12);
        const leaf2Proj = project(wx, wy, 26);
        const leaf3Proj = project(wx, wy, 40);

        const sc = trunkProj.scale;

        // Draw Trunk
        ctx.fillStyle = '#78350F';
        ctx.beginPath();
        ctx.ellipse(trunkProj.x, trunkProj.y, 4 * sc, 2 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(trunkProj.x - 3 * sc, trunkProj.y - 12 * sc, 6 * sc, 12 * sc);

        // Cascade Layer 1
        ctx.fillStyle = '#065F46';
        ctx.beginPath();
        ctx.moveTo(leaf1Proj.x - 22 * sc, leaf1Proj.y);
        ctx.lineTo(leaf1Proj.x + 22 * sc, leaf1Proj.y);
        ctx.lineTo(leaf2Proj.x, leaf2Proj.y - 4 * sc);
        ctx.closePath();
        ctx.fill();

        // snow cap lid 1
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(leaf1Proj.x - 22 * sc, leaf1Proj.y);
        ctx.lineTo(leaf1Proj.x + 22 * sc, leaf1Proj.y);
        ctx.lineTo(leaf1Proj.x + 16 * sc, leaf1Proj.y - 3 * sc);
        ctx.lineTo(leaf1Proj.x - 16 * sc, leaf1Proj.y - 3 * sc);
        ctx.closePath();
        ctx.fill();

        // Cascade Layer 2
        ctx.fillStyle = '#047857';
        ctx.beginPath();
        ctx.moveTo(leaf2Proj.x - 17 * sc, leaf2Proj.y);
        ctx.lineTo(leaf2Proj.x + 17 * sc, leaf2Proj.y);
        ctx.lineTo(leaf3Proj.x, leaf3Proj.y - 3 * sc);
        ctx.closePath();
        ctx.fill();

        // snow cap lid 2
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(leaf2Proj.x - 17 * sc, leaf2Proj.y);
        ctx.lineTo(leaf2Proj.x + 17 * sc, leaf2Proj.y);
        ctx.lineTo(leaf2Proj.x + 12 * sc, leaf2Proj.y - 3 * sc);
        ctx.lineTo(leaf2Proj.x - 12 * sc, leaf2Proj.y - 3 * sc);
        ctx.closePath();
        ctx.fill();

        // Cascade Layer 3
        ctx.fillStyle = '#059669';
        ctx.beginPath();
        ctx.moveTo(leaf3Proj.x - 11 * sc, leaf3Proj.y);
        ctx.lineTo(leaf3Proj.x + 11 * sc, leaf3Proj.y);
        const topProj = project(wx, wy, 52);
        ctx.lineTo(topProj.x, topProj.y);
        ctx.closePath();
        ctx.fill();

        // top tree cap
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(leaf3Proj.x - 5 * sc, leaf3Proj.y + 2 * sc);
        ctx.lineTo(topProj.x, topProj.y);
        ctx.lineTo(leaf3Proj.x + 5 * sc, leaf3Proj.y + 2 * sc);
        ctx.closePath();
        ctx.fill();
      };

      const draw3DSnowman = (wx: number, wy: number) => {
        const bottomProj = project(wx, wy, 0);
        const bodyProj = project(wx, wy, 10);
        const headProj = project(wx, wy, 24);
        const sc = bottomProj.scale;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.2)';
        ctx.beginPath();
        ctx.ellipse(bottomProj.x, bottomProj.y, 14 * sc, 6 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#F8FAFC';
        ctx.strokeStyle = '#CBD5E1';
        ctx.lineWidth = 1 * sc;
        ctx.beginPath();
        ctx.arc(bodyProj.x, bodyProj.y, 11 * sc, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#1E293B';
        ctx.beginPath();
        ctx.arc(bodyProj.x, bodyProj.y - 1 * sc, 2 * sc, 0, Math.PI * 2);
        ctx.arc(bodyProj.x, bodyProj.y + 4 * sc, 2 * sc, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(headProj.x, headProj.y, 7.5 * sc, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#0F172A';
        ctx.beginPath();
        ctx.arc(headProj.x - 2 * sc, headProj.y - 1 * sc, 1 * sc, 0, Math.PI * 2);
        ctx.arc(headProj.x + 2 * sc, headProj.y - 1 * sc, 1 * sc, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#EA580C'; // carrot
        ctx.beginPath();
        ctx.moveTo(headProj.x, headProj.y);
        ctx.lineTo(headProj.x + 5 * sc, headProj.y + 1 * sc);
        ctx.lineTo(headProj.x, headProj.y + 2 * sc);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#EF4444'; // scarf
        ctx.beginPath();
        ctx.ellipse(headProj.x, headProj.y + 6 * sc, 7.5 * sc, 3 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(headProj.x + 3 * sc, headProj.y + 6 * sc);
        ctx.lineTo(headProj.x + 7 * sc, headProj.y + 13 * sc);
        ctx.lineTo(headProj.x + 4 * sc, headProj.y + 14 * sc);
        ctx.lineTo(headProj.x + 1 * sc, headProj.y + 7 * sc);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#1E293B'; // top hat
        ctx.fillRect(headProj.x - 7 * sc, headProj.y - 9 * sc, 14 * sc, 2.5 * sc);
        ctx.fillRect(headProj.x - 4 * sc, headProj.y - 17 * sc, 8 * sc, 8 * sc);
        ctx.fillStyle = '#EF4444';
        ctx.fillRect(headProj.x - 4 * sc, headProj.y - 11 * sc, 8 * sc, 2 * sc);
      };

      const draw3DCandyCane = (wx: number, wy: number) => {
        const baseProj = project(wx, wy, 0);
        const sc = baseProj.scale;

        ctx.lineWidth = 5 * sc;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.strokeStyle = 'rgba(15, 23, 42, 0.15)';
        ctx.beginPath();
        for (let hz = 0; hz <= 36; hz += 4) {
          let rx = wx;
          if (hz > 24) {
            const ratio = (hz - 24) / 12;
            rx += Math.sin(ratio * Math.PI) * 14;
          }
          const pt = project(rx, wy, hz);
          if (hz === 0) ctx.moveTo(pt.x + 2 * sc, pt.y + 3 * sc);
          else ctx.lineTo(pt.x + 2 * sc, pt.y + 3 * sc);
        }
        ctx.stroke();

        for (let hz = 0; hz <= 36; hz += 2) {
          let rx = wx;
          if (hz > 24) {
            const ratio = (hz - 24) / 12;
            rx += Math.sin(ratio * Math.PI) * 14;
          }
          const pt1 = project(rx, wy, hz);
          
          let rxNext = wx;
          if (hz + 2 > 24) {
            const ratio = (hz + 2 - 24) / 12;
            rxNext += Math.sin(ratio * Math.PI) * 14;
          }
          const pt2 = project(rxNext, wy, hz + 2);

          ctx.strokeStyle = (Math.floor(hz / 4) % 2 === 0) ? '#EF4444' : '#F8FAFC';
          ctx.beginPath();
          ctx.moveTo(pt1.x, pt1.y);
          ctx.lineTo(pt2.x, pt2.y);
          ctx.stroke();
        }
      };

      // SUMMER generators
      const draw3DOakTree = (wx: number, wy: number) => {
        const bottomProj = project(wx, wy, 0);
        const leafProj1 = project(wx, wy, 20);
        const leafProj2 = project(wx, wy, 36);
        const sc = bottomProj.scale;

        // Trunk
        ctx.fillStyle = '#5C4033'; // deep bark
        ctx.beginPath();
        ctx.ellipse(bottomProj.x, bottomProj.y, 6 * sc, 3 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(bottomProj.x - 4.5 * sc, bottomProj.y - 18 * sc, 9 * sc, 18 * sc);

        // Lower Foliage
        ctx.fillStyle = '#15803D'; // forest green
        ctx.beginPath();
        ctx.arc(leafProj1.x, leafProj1.y, 22 * sc, 0, Math.PI * 2);
        ctx.fill();

        // Upper Foliage
        ctx.fillStyle = '#16A34A'; // bright lime green
        ctx.beginPath();
        ctx.arc(leafProj2.x, leafProj2.y, 16 * sc, 0, Math.PI * 2);
        ctx.fill();

        // Specular apple / leaf highlight spots
        ctx.fillStyle = '#EF4444'; // little apples
        ctx.beginPath();
        ctx.arc(leafProj1.x - 7 * sc, leafProj1.y + 6 * sc, 1.8 * sc, 0, Math.PI * 2);
        ctx.arc(leafProj1.x + 9 * sc, leafProj1.y - 3 * sc, 1.8 * sc, 0, Math.PI * 2);
        ctx.arc(leafProj2.x - 2 * sc, leafProj2.y + 2 * sc, 1.8 * sc, 0, Math.PI * 2);
        ctx.fill();
      };

      const draw3DWildflowerBunch = (wx: number, wy: number, color: string) => {
        const base = project(wx, wy, 0);
        const sc = base.scale;

        ctx.fillStyle = '#16A34A'; // green leaf plate
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, 10 * sc, 4.5 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // stems
        ctx.strokeStyle = '#15803D';
        ctx.lineWidth = 1.6 * sc;
        ctx.beginPath();
        ctx.moveTo(base.x - 4 * sc, base.y);
        ctx.lineTo(base.x - 6 * sc, base.y - 12 * sc);
        ctx.moveTo(base.x + 4 * sc, base.y);
        ctx.lineTo(base.x + 6 * sc, base.y - 10 * sc);
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(base.x + 1 * sc, base.y - 15 * sc);
        ctx.stroke();

        // petals
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(base.x - 6 * sc, base.y - 12 * sc, 3.5 * sc, 0, Math.PI * 2);
        ctx.arc(base.x + 6 * sc, base.y - 10 * sc, 3 * sc, 0, Math.PI * 2);
        ctx.arc(base.x + 1 * sc, base.y - 15 * sc, 3.8 * sc, 0, Math.PI * 2);
        ctx.fill();

        // flower center cores
        ctx.fillStyle = '#FBBF24';
        ctx.beginPath();
        ctx.arc(base.x - 6 * sc, base.y - 12 * sc, 1 * sc, 0, Math.PI * 2);
        ctx.arc(base.x + 6 * sc, base.y - 10 * sc, 0.8 * sc, 0, Math.PI * 2);
        ctx.arc(base.x + 1 * sc, base.y - 15 * sc, 1.1 * sc, 0, Math.PI * 2);
        ctx.fill();
      };

      // BEACH generators
      const draw3DPalmTree = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const sc = base.scale;

        ctx.fillStyle = '#854D0E'; // brown root
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, 6.5 * sc, 3 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        const trunkNodes = [];
        for (let i = 1; i <= 6; i++) {
          const bendAmtX = wx - i * 3.8; // creates beautiful slanted visual curve
          trunkNodes.push(project(bendAmtX, wy, i * 7.5));
        }

        // Draw segmented wood trunk body
        ctx.strokeStyle = '#854D0E';
        ctx.lineWidth = 6 * sc;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        trunkNodes.forEach(tNode => ctx.lineTo(tNode.x, tNode.y));
        ctx.stroke();

        // Ring carvings
        ctx.strokeStyle = '#451A03';
        ctx.lineWidth = 1 * sc;
        trunkNodes.forEach(tNode => {
          ctx.beginPath();
          ctx.ellipse(tNode.x, tNode.y, 3.8 * sc, 1.6 * sc, 0.18, 0, Math.PI * 2);
          ctx.stroke();
        });

        // Palm fronds drooping gracefully
        const crown = trunkNodes[trunkNodes.length - 1];
        ctx.strokeStyle = '#15803D';
        ctx.lineWidth = 3.2 * sc;
        const angles = [0, 1.25, 2.5, 3.75, 5.0];
        angles.forEach(angle => {
          ctx.beginPath();
          ctx.moveTo(crown.x, crown.y);
          const cpX = crown.x + Math.cos(angle) * 16 * sc;
          const cpY = crown.y + Math.sin(angle) * 6 * sc + 5 * sc;
          const endX = crown.x + Math.cos(angle) * 26 * sc;
          const endY = crown.y + Math.sin(angle) * 10 * sc + 15 * sc;
          ctx.quadraticCurveTo(cpX, cpY, endX, endY);
          ctx.stroke();
        });
      };

      const draw3DBeachUmbrella = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const crown = project(wx, wy, 34);
        const sc = base.scale;

        // umbrella thin stick
        ctx.strokeStyle = '#E2E8F0';
        ctx.lineWidth = 2 * sc;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(crown.x, crown.y);
        ctx.stroke();

        // Conic colored cap
        const rad = 23 * sc;
        ctx.fillStyle = '#EF4444';
        ctx.beginPath();
        ctx.ellipse(crown.x, crown.y + 3 * sc, rad, rad * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();

        // White canopy striped wedges
        for (let i = 0; i < 4; i++) {
          const a1 = (i * Math.PI) / 2;
          const a2 = ((i + 0.5) * Math.PI) / 2;
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.moveTo(crown.x, crown.y);
          ctx.ellipse(crown.x, crown.y + 3 * sc, rad, rad * 0.35, 0, a1, a2);
          ctx.lineTo(crown.x, crown.y);
          ctx.closePath();
          ctx.fill();
        }

        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 1 * sc;
        ctx.beginPath();
        ctx.ellipse(crown.x, crown.y + 3 * sc, rad, rad * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
      };

      // GARDEN CUSTOM GNOME doll generator (as attached is red conical hat, fat peach nose, white beard, dark jacket)
      const draw3DGardenGnome = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const sc = base.scale;

        // Ground shadow
        ctx.fillStyle = 'rgba(15, 23, 42, 0.2)';
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, 14 * sc, 6 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // 1. Gnome body / coat in deep blue as seen in typical garden gnomes
        const bodyProj = project(wx, wy, 8);
        ctx.fillStyle = '#1D4ED8'; // Royal blue jacket
        ctx.beginPath();
        ctx.ellipse(bodyProj.x, bodyProj.y, 10 * sc, 9 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // 2. White beard covering chest
        const beardProj = project(wx, wy, 14);
        ctx.fillStyle = '#F8FAFC'; // Soft white beard
        ctx.beginPath();
        ctx.moveTo(beardProj.x - 7 * sc, beardProj.y);
        ctx.quadraticCurveTo(beardProj.x, beardProj.y + 11 * sc, beardProj.x + 7 * sc, beardProj.y);
        ctx.quadraticCurveTo(beardProj.x, beardProj.y - 1 * sc, beardProj.x - 7 * sc, beardProj.y);
        ctx.closePath();
        ctx.fill();

        // 3. Round chubby Peach Face
        const faceProj = project(wx, wy, 18);
        ctx.fillStyle = '#FED7AA'; // Peach skin
        ctx.beginPath();
        ctx.arc(faceProj.x, faceProj.y, 6.5 * sc, 0, Math.PI * 2);
        ctx.fill();

        // Chubby blush cheeks
        ctx.fillStyle = '#FCA5A5';
        ctx.beginPath();
        ctx.arc(faceProj.x - 3.5 * sc, faceProj.y + 1 * sc, 2 * sc, 0, Math.PI * 2);
        ctx.arc(faceProj.x + 3.5 * sc, faceProj.y + 1 * sc, 2 * sc, 0, Math.PI * 2);
        ctx.fill();

        // Cute button nose
        ctx.fillStyle = '#FDBA74';
        ctx.beginPath();
        ctx.arc(faceProj.x, faceProj.y, 2.2 * sc, 0, Math.PI * 2);
        ctx.fill();

        // Squinty eyes
        ctx.fillStyle = '#1E293B';
        ctx.beginPath();
        ctx.arc(faceProj.x - 2.2 * sc, faceProj.y - 1.2 * sc, 0.9 * sc, 0, Math.PI * 2);
        ctx.arc(faceProj.x + 2.2 * sc, faceProj.y - 1.2 * sc, 0.9 * sc, 0, Math.PI * 2);
        ctx.fill();

        // 4. Iconic tall pointed conical RED Gnome Hat (as attached in image)
        const hatBaseProj = project(wx, wy, 21);
        const hatTipProj = project(wx, wy, 39);
        ctx.fillStyle = '#DC2626'; // Bright Red!
        ctx.beginPath();
        ctx.moveTo(hatBaseProj.x - 7.5 * sc, hatBaseProj.y);
        ctx.quadraticCurveTo(hatBaseProj.x + 1 * sc, hatTipProj.y + 5 * sc, hatTipProj.x + 2 * sc, hatTipProj.y);
        ctx.quadraticCurveTo(hatBaseProj.x + 5 * sc, hatBaseProj.y - 2 * sc, hatBaseProj.x + 7.5 * sc, hatBaseProj.y);
        ctx.closePath();
        ctx.fill();

        // White hat brim fold
        ctx.fillStyle = '#F1F5F9';
        ctx.beginPath();
        ctx.ellipse(hatBaseProj.x, hatBaseProj.y, 8 * sc, 2 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // Tiny lute / gold accordian tool instrument as held in the photo!
        const toolProj = project(wx, wy, 7);
        ctx.fillStyle = '#F59E0B'; // Golden highlight
        ctx.fillRect(toolProj.x - 4 * sc, toolProj.y + 2 * sc, 8 * sc, 4 * sc);
        ctx.fillStyle = '#334155'; // Accordion folds
        ctx.fillRect(toolProj.x - 2 * sc, toolProj.y + 2 * sc, 1.2 * sc, 4 * sc);
        ctx.fillRect(toolProj.x + 1 * sc, toolProj.y + 2 * sc, 1.2 * sc, 4 * sc);
      };

      // DESERT MUMMY DOLL generator
      const draw3DMummyDoll = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const sc = base.scale;

        // Ground shadow
        ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, 14 * sc, 6 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // 1. Mummy cylinder body
        const midProj = project(wx, wy, 12);
        ctx.fillStyle = '#EFEAE2'; // Linen beige white
        ctx.beginPath();
        ctx.ellipse(midProj.x, midProj.y, 8.5 * sc, 12 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // Draw wrapping lines / bandages cross
        ctx.strokeStyle = '#D5C9B8';
        ctx.lineWidth = 1.3 * sc;
        const heights = [3, 7, 11, 15, 19, 23];
        heights.forEach((h, idx) => {
          const pt = project(wx, wy, h);
          ctx.beginPath();
          if (idx % 2 === 0) {
            ctx.ellipse(pt.x, pt.y, 8.5 * sc, 2.5 * sc, 0.15, 0, Math.PI * 2);
          } else {
            ctx.ellipse(pt.x, pt.y, 8.5 * sc, 2.5 * sc, -0.15, 0, Math.PI * 2);
          }
          ctx.stroke();
        });

        // 2. Eyes cutout slit
        const headProj = project(wx, wy, 20);
        ctx.fillStyle = '#272522'; // Deep shadow slit
        ctx.fillRect(headProj.x - 6 * sc, headProj.y - 1.5 * sc, 12 * sc, 3.5 * sc);

        // Glowing golden/amber eyes for mummy
        ctx.fillStyle = '#F59E0B';
        ctx.beginPath();
        ctx.arc(headProj.x - 2.5 * sc, headProj.y, 1.2 * sc, 0, Math.PI * 2);
        ctx.arc(headProj.x + 2.5 * sc, headProj.y, 1.2 * sc, 0, Math.PI * 2);
        ctx.fill();

        // 3. Hanging bandage loose wrap/ribbon swooping from the body to make it super mummified!
        ctx.strokeStyle = '#EFEAE2';
        ctx.lineWidth = 2 * sc;
        ctx.beginPath();
        const startHand = project(wx + 4, wy, 8);
        const endHand = project(wx + 13, wy + 4, 1);
        ctx.moveTo(startHand.x, startHand.y);
        ctx.quadraticCurveTo(startHand.x + 6 * sc, startHand.y + 4 * sc, endHand.x, endHand.y);
        ctx.stroke();
      };

      // BEACH SAND CASTLE generator
      const draw3DSandCastle = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const sc = base.scale;

        // Ground shadow
        ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, 22 * sc, 8 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        // 1. Central fortified base wall
        ctx.fillStyle = '#EAB308'; // Sand yellow
        ctx.strokeStyle = '#CA8A04'; // Darker sandy stroke for depth
        ctx.lineWidth = 1 * sc;

        const baseProj = project(wx, wy, 6);
        ctx.beginPath();
        ctx.ellipse(baseProj.x, baseProj.y, 14 * sc, 6 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillRect(baseProj.x - 14 * sc, baseProj.y, 28 * sc, base.y - baseProj.y);

        // Main castle gate archway
        ctx.fillStyle = '#3F2C0B'; // dark brown door
        ctx.beginPath();
        ctx.ellipse(baseProj.x, base.y, 4 * sc, 5 * sc, 0, Math.PI, 0);
        ctx.fill();

        // 2. Left tall tower and Right tall tower
        const hLeft = project(wx - 15, wy, 18);
        const hRight = project(wx + 15, wy, 18);
        const bLeft = project(wx - 15, wy, 0);
        const bRight = project(wx + 15, wy, 0);

        ctx.fillStyle = '#F59E0B'; // bright sandy color
        // Draw Left Tower Column
        ctx.fillRect(hLeft.x - 4 * sc, hLeft.y, 8 * sc, bLeft.y - hLeft.y);
        // Draw Right Tower Column
        ctx.fillRect(hRight.x - 4 * sc, hRight.y, 8 * sc, bRight.y - hRight.y);

        // Cone roofs on tower cups / summits
        const peakLeft = project(wx - 15, wy, 25);
        const peakRight = project(wx + 15, wy, 25);

        ctx.fillStyle = '#DC2626'; // Nautical red caps / flags
        // Left cone
        ctx.beginPath();
        ctx.moveTo(hLeft.x - 5.5 * sc, hLeft.y);
        ctx.lineTo(hLeft.x + 5.5 * sc, hLeft.y);
        ctx.lineTo(peakLeft.x, peakLeft.y);
        ctx.closePath();
        ctx.fill();

        // Right cone
        ctx.beginPath();
        ctx.moveTo(hRight.x - 5.5 * sc, hRight.y);
        ctx.lineTo(hRight.x + 5.5 * sc, hRight.y);
        ctx.lineTo(peakRight.x, peakRight.y);
        ctx.closePath();
        ctx.fill();

        // Sprouting Red fluttering flags on top!
        ctx.fillStyle = '#EF4444';
        ctx.beginPath();
        ctx.moveTo(peakLeft.x, peakLeft.y);
        ctx.lineTo(peakLeft.x + 7 * sc, peakLeft.y + 2 * sc);
        ctx.lineTo(peakLeft.x, peakLeft.y + 4 * sc);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(peakRight.x, peakRight.y);
        ctx.lineTo(peakRight.x + 7 * sc, peakRight.y + 2 * sc);
        ctx.lineTo(peakRight.x, peakRight.y + 4 * sc);
        ctx.closePath();
        ctx.fill();
      };

      // DESERT generators
      const draw3DDesertPyramid = (wx: number, wy: number, halfW: number, H: number) => {
        const pL = project(wx - halfW, wy + halfW, 0); // front-left
        const pMid = project(wx + halfW, wy + halfW, 0); // front-right
        const pR = project(wx + halfW, wy - halfW, 0); // back-right
        const pTop = project(wx, wy, H);
        const sc = pL.scale;

        // Shadow terracotta brown left face
        ctx.fillStyle = '#92400E';
        ctx.beginPath();
        ctx.moveTo(pL.x, pL.y);
        ctx.lineTo(pMid.x, pMid.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.closePath();
        ctx.fill();

        // Shiny brass gold right face
        ctx.fillStyle = '#FBBF24';
        ctx.beginPath();
        ctx.moveTo(pMid.x, pMid.y);
        ctx.lineTo(pR.x, pR.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.closePath();
        ctx.fill();

        // Crease line
        ctx.strokeStyle = '#78350F';
        ctx.lineWidth = 1 * sc;
        ctx.beginPath();
        ctx.moveTo(pL.x, pL.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.lineTo(pMid.x, pMid.y);
        ctx.lineTo(pR.x, pR.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.stroke();

        // Ruby capstone summit
        ctx.fillStyle = '#EF4444'; // beautiful egyptian ruby top
        ctx.beginPath();
        const capP = project(wx, wy, H - 7);
        ctx.moveTo(pTop.x, pTop.y);
        ctx.lineTo(capP.x - 2.5 * sc, capP.y + 1 * sc);
        ctx.lineTo(capP.x + 2.5 * sc, capP.y + 1 * sc);
        ctx.closePath();
        ctx.fill();
      };

      const draw3DEgyptianObelisk = (wx: number, wy: number) => {
        const base = project(wx, wy, 0);
        const colTop = project(wx, wy, 44);
        const apexTip = project(wx, wy, 53);
        const sc = base.scale;

        // Left shade face
        ctx.fillStyle = '#D97706';
        ctx.beginPath();
        ctx.moveTo(base.x - 4.5 * sc, base.y);
        ctx.lineTo(base.x, base.y + 2 * sc);
        ctx.lineTo(colTop.x, colTop.y + 2 * sc);
        ctx.lineTo(colTop.x - 3.5 * sc, colTop.y);
        ctx.closePath();
        ctx.fill();

        // Right light face
        ctx.fillStyle = '#FCD34D';
        ctx.beginPath();
        ctx.moveTo(base.x, base.y + 2 * sc);
        ctx.lineTo(base.x + 4.5 * sc, base.y);
        ctx.lineTo(colTop.x + 3.5 * sc, colTop.y);
        ctx.lineTo(colTop.x, colTop.y + 2 * sc);
        ctx.closePath();
        ctx.fill();

        // Pyramidion top
        ctx.fillStyle = '#F59E0B';
        ctx.beginPath();
        ctx.moveTo(colTop.x - 3.5 * sc, colTop.y);
        ctx.lineTo(colTop.x + 3.5 * sc, colTop.y);
        ctx.lineTo(apexTip.x, apexTip.y);
        ctx.closePath();
        ctx.fill();

        // Seam border
        ctx.strokeStyle = '#92400E';
        ctx.lineWidth = 1 * sc;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y + 2 * sc);
        ctx.lineTo(colTop.x, colTop.y + 2 * sc);
        ctx.stroke();
      };

      // Draw active environment's static framing decorative props around the corners
      if (activeMap === 'open') {
        // SUMMER GARDEN
        draw3DOakTree(42, 42);
        draw3DOakTree(MAP_WIDTH - 42, 42);
        draw3DOakTree(42, MAP_HEIGHT - 42);
        draw3DOakTree(MAP_WIDTH - 42, MAP_HEIGHT - 42);

        draw3DGardenGnome(110, 48); // Cute custom gnome as requested!
        draw3DWildflowerBunch(MAP_WIDTH - 110, 48, '#F59E0B');
        draw3DGardenGnome(MAP_WIDTH - 110, MAP_HEIGHT - 48); // Symmetrical gnome!
        draw3DWildflowerBunch(110, MAP_HEIGHT - 48, '#EF4444');
      } else if (activeMap === 'arena') {
        // BEACH SCENARIOS
        draw3DPalmTree(42, 42);
        draw3DPalmTree(MAP_WIDTH - 42, 42);
        draw3DPalmTree(42, MAP_HEIGHT - 42);
        draw3DPalmTree(MAP_WIDTH - 42, MAP_HEIGHT - 42);

        draw3DSandCastle(110, 48); // Beautiful sand castle!
        draw3DBeachUmbrella(MAP_WIDTH - 110, 48);
        draw3DSandCastle(MAP_WIDTH - 110, MAP_HEIGHT - 48); // Symmetrical sand castle!
        draw3DBeachUmbrella(110, MAP_HEIGHT - 48);
      } else if (activeMap === 'maze') {
        // DESERT
        draw3DDesertPyramid(42, 42, 18, 38);
        draw3DDesertPyramid(MAP_WIDTH - 42, 42, 18, 38);
        draw3DDesertPyramid(42, MAP_HEIGHT - 42, 18, 38);
        draw3DDesertPyramid(MAP_WIDTH - 42, MAP_HEIGHT - 42, 18, 38);

        draw3DMummyDoll(110, 48); // Cryptic cute Mummy Doll!
        draw3DEgyptianObelisk(MAP_WIDTH - 110, 48);
        draw3DMummyDoll(MAP_WIDTH - 110, MAP_HEIGHT - 48);
        draw3DEgyptianObelisk(110, MAP_HEIGHT - 48);
      } else {
        // WINTER
        draw3DPineTree(42, 42);
        draw3DPineTree(MAP_WIDTH - 42, 42);
        draw3DPineTree(42, MAP_HEIGHT - 42);
        draw3DPineTree(MAP_WIDTH - 42, MAP_HEIGHT - 42);

        draw3DSnowman(110, 48);
        draw3DCandyCane(MAP_WIDTH - 110, 48);
        draw3DSnowman(MAP_WIDTH - 110, MAP_HEIGHT - 48);
        draw3DCandyCane(110, MAP_HEIGHT - 48);
      }

      // 6. Draw 3D portals with beautiful swirling vortex animation
      const renderPortal = (pctx: CanvasRenderingContext2D, px: number, py: number, label: string) => {
        const time = Date.now() / 250;
        const pProj = project(px, py, 0);

        // Ground portal halo
        pctx.beginPath();
        pctx.ellipse(pProj.x, pProj.y, PORTAL_RADIUS * 1.5 * pProj.scale, PORTAL_RADIUS * 0.6 * pProj.scale, 0, 0, Math.PI * 2);
        pctx.fillStyle = 'rgba(168, 85, 247, 0.15)';
        pctx.fill();

        // 3D Elliptical swirling vortex rings
        pctx.lineWidth = 2.5;
        for (let r = 0; r < 3; r++) {
          const sizeMult = 0.4 + ((time + r * 0.6) % 1.5) * 0.6;
          const currentRadius = PORTAL_RADIUS * sizeMult * pProj.scale;
          const opacity = Math.max(0, 1.0 - (sizeMult - 0.4) / 1.1);
          pctx.strokeStyle = `rgba(217, 70, 239, ${opacity})`; // deep pinkish purple

          pctx.beginPath();
          pctx.ellipse(pProj.x, pProj.y, currentRadius, currentRadius * 0.42, (time + r) * 0.2, 0, Math.PI * 2);
          pctx.stroke();
        }

        // Floating glowing core orb
        const wave = Math.sin(time * 0.7) * 4;
        const orbProj = project(px, py, 14 + wave);
        pctx.beginPath();
        pctx.ellipse(orbProj.x, orbProj.y, 8 * orbProj.scale, 4 * orbProj.scale, 0, 0, Math.PI * 2);
        pctx.fillStyle = '#FFFFFF';
        pctx.shadowColor = '#D946EF';
        pctx.shadowBlur = 12;
        pctx.fill();
        pctx.shadowBlur = 0; // reset shadow state

        // Portal text floating tag
        const textProj = project(px, py, 26);
        pctx.fillStyle = '#E9D5FF';
        pctx.font = 'bold 9px monospace';
        pctx.textAlign = 'center';
        pctx.fillText(label, textProj.x, textProj.y);
      };

      const mapPortals = MAP_PORTALS[room.config.map];
      if (mapPortals && mapPortals.length === 2) {
        renderPortal(ctx, mapPortals[0].x, mapPortals[0].y, '🌀 PORTAL A');
        renderPortal(ctx, mapPortals[1].x, mapPortals[1].y, '🌀 PORTAL B');
      }

      // 7. Draw all Players as 3D Shaded Glowing Marbles
      Object.keys(room.players).forEach(pId => {
        const player = room.players[pId];
        
        if (!otherPlayersLerpRef.current[pId]) {
          otherPlayersLerpRef.current[pId] = { x: player.x, y: player.y };
        }

        const lRef = otherPlayersLerpRef.current[pId];

        if (pId === personalId) {
          lRef.x = playerPosRef.current.x;
          lRef.y = playerPosRef.current.y;
        } else {
          lRef.x += (player.x - lRef.x) * 0.25;
          lRef.y += (player.y - lRef.y) * 0.25;
        }

        if (!player.isAlive) {
          // Dead representation: 3D-angled skull tombstone
          const pDead = project(lRef.x, lRef.y, 0);
          ctx.font = '22px Inter';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('💀', pDead.x, pDead.y);
          
          ctx.fillStyle = '#94A3B8';
          ctx.font = 'bold 11px Inter';
          ctx.fillText(`${player.name} (RIP)`, pDead.x, pDead.y - 25);
          return;
        }

        const nowTs = Date.now();
        const isShielded = nowTs < player.shieldUntil;
        const isSpeedBoosted = nowTs < player.speedBoostUntil;
        const isFrozen = nowTs < player.frozenUntil;

        // Player ground project references
        const pBottom = project(lRef.x, lRef.y, 0);
        // Add dynamic sweet bobbing to make characters look alive without causing visual mismatch
        const bobOffset = Math.sin(nowTs / 130 + pBottom.x * 0.04) * 2.2;
        const pBody = {
          x: pBottom.x,
          y: pBottom.y + bobOffset,
          scale: pBottom.scale
        };

        // Glow halo flat on ground
        const baseGlowSize = player.isIt ? 22 : 12;
        const pulseRatio = Math.sin(nowTs / 120);
        const glowRadius = (baseGlowSize + (player.isIt ? (pulseRatio * 8) : (pulseRatio * 2))) * pBottom.scale;
        
        ctx.beginPath();
        ctx.ellipse(pBottom.x, pBottom.y, glowRadius, glowRadius * 0.45, 0, 0, Math.PI * 2);
        
        let glowColor = player.isIt ? 'rgba(239, 68, 68, 0.4)' : `${player.color}44`;
        if (player.isIt && room.config.mode === 'bomb') glowColor = 'rgba(225, 29, 72, 0.5)';
        if (isFrozen) glowColor = 'rgba(56, 189, 248, 0.4)';

        ctx.fillStyle = glowColor;
        ctx.fill();

        // Pulse warning dashed ring on ground if in grace period
        if (player.isIt && nowTs < room.tagCooldownUntil) {
          ctx.beginPath();
          ctx.ellipse(pBottom.x, pBottom.y, (PLAYER_RADIUS + 8) * pBottom.scale, (PLAYER_RADIUS + 8) * 0.45 * pBottom.scale, 0, 0, Math.PI * 2);
          ctx.strokeStyle = '#EF4444';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 5]);
          ctx.stroke();
          ctx.setLineDash([]); // reset
        }

        // Draw player core shadow flat on floor
        ctx.beginPath();
        ctx.ellipse(pBottom.x, pBottom.y, PLAYER_RADIUS * pBottom.scale, PLAYER_RADIUS * 0.42 * pBottom.scale, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.5)';
        ctx.fill();

        // 3D Capsule-Shield if shielded
        if (isShielded) {
          ctx.beginPath();
          ctx.ellipse(pBody.x, pBody.y, (PLAYER_RADIUS + 5) * pBody.scale, (PLAYER_RADIUS + 5) * pBody.scale, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
          ctx.fill();
          ctx.strokeStyle = '#60A5FA';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Calculate movement or direction vector for trailing ribbons
        const vxRib = player.vx !== undefined ? player.vx : 0;
        const vyRib = player.vy !== undefined ? player.vy : 0;
        let flowDx = -vxRib;
        let flowDy = -vyRib;
        const flowSpeelen = Math.sqrt(flowDx * flowDx + flowDy * flowDy);
        if (flowSpeelen < 0.1) {
          flowDx = -1.2;
          flowDy = 0.3;
        } else {
          flowDx = (flowDx / flowSpeelen) * 1.5;
          flowDy = (flowDy / flowSpeelen) * 1.5;
        }

        // Draw trailing ninja ribbons (flapping dynamically)
        const timeVal = Date.now() / 130 + pBottom.x * 0.05;
        const ribbonCol = isFrozen ? '#93C5FD' : player.color;
        ctx.strokeStyle = ribbonCol;
        ctx.lineWidth = 3.5 * pBody.scale;
        ctx.lineCap = 'round';

        // Ribbon 1
        ctx.beginPath();
        ctx.moveTo(pBody.x, pBody.y + 1 * pBody.scale);
        const cp1x = pBody.x + flowDx * 15 * pBody.scale;
        const cp1y = pBody.y + flowDy * 10 * pBody.scale + Math.sin(timeVal) * 5 * pBody.scale;
        const end1x = pBody.x + flowDx * 28 * pBody.scale;
        const end1y = pBody.y + flowDy * 14 * pBody.scale + Math.sin(timeVal) * 7 * pBody.scale;
        ctx.quadraticCurveTo(cp1x, cp1y, end1x, end1y);
        ctx.stroke();

        // Ribbon 2 (phase desynchronized)
        ctx.beginPath();
        ctx.moveTo(pBody.x, pBody.y + 3 * pBody.scale);
        const cp2x = pBody.x + flowDx * 13 * pBody.scale;
        const cp2y = pBody.y + flowDy * 7 * pBody.scale + Math.cos(timeVal * 1.1) * 4 * pBody.scale;
        const end2x = pBody.x + flowDx * 24 * pBody.scale;
        const end2y = pBody.y + flowDy * 11 * pBody.scale + Math.cos(timeVal * 1.1) * 6 * pBody.scale;
        ctx.quadraticCurveTo(cp2x, cp2y, end2x, end2y);
        ctx.stroke();

        // Setup base colors
        let coreColor = isFrozen ? '#93C5FD' : player.color;
        const rSphere = PLAYER_RADIUS * pBody.scale;

        // Draw adorable 3D cat ears
        ctx.fillStyle = coreColor;
        ctx.strokeStyle = player.id === personalId ? '#FFFFFF' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1 * pBody.scale;

        // Left ear
        ctx.beginPath();
        const earAngleLeft = 2.4; // radian top left
        const earX1 = pBody.x + Math.cos(earAngleLeft - 0.28) * rSphere;
        const earY1 = pBody.y - Math.sin(earAngleLeft - 0.28) * rSphere;
        const earX2 = pBody.x + Math.cos(earAngleLeft + 0.28) * rSphere;
        const earY2 = pBody.y - Math.sin(earAngleLeft + 0.28) * rSphere;
        const earTpX = pBody.x + Math.cos(earAngleLeft) * (rSphere + 6 * pBody.scale);
        const earTpY = pBody.y - Math.sin(earAngleLeft) * (rSphere + 6.5 * pBody.scale);

        ctx.moveTo(earX1, earY1);
        ctx.lineTo(earTpX, earTpY);
        ctx.lineTo(earX2, earY2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Inner left ear peach flap
        ctx.fillStyle = '#FDA4AF';
        ctx.beginPath();
        ctx.moveTo(earX1 + (earTpX - earX1)*0.24, earY1 + (earTpY - earY1)*0.24);
        ctx.lineTo(earTpX - Math.cos(earAngleLeft)*1.2, earTpY + Math.sin(earAngleLeft)*1.2);
        ctx.lineTo(earX2 + (earTpX - earX2)*0.24, earY2 + (earTpY - earY2)*0.24);
        ctx.closePath();
        ctx.fill();

        // Right ear
        ctx.fillStyle = coreColor;
        ctx.beginPath();
        const earAngleRight = 0.74; // radian top right
        const earRX1 = pBody.x + Math.cos(earAngleRight - 0.28) * rSphere;
        const earRY1 = pBody.y - Math.sin(earAngleRight - 0.28) * rSphere;
        const earRX2 = pBody.x + Math.cos(earAngleRight + 0.28) * rSphere;
        const earRY2 = pBody.y - Math.sin(earAngleRight + 0.28) * rSphere;
        const earRTpX = pBody.x + Math.cos(earAngleRight) * (rSphere + 6 * pBody.scale);
        const earRTpY = pBody.y - Math.sin(earAngleRight) * (rSphere + 6.5 * pBody.scale);

        ctx.moveTo(earRX1, earRY1);
        ctx.lineTo(earRTpX, earRTpY);
        ctx.lineTo(earRX2, earRY2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Inner right ear peach flap
        ctx.fillStyle = '#FDA4AF';
        ctx.beginPath();
        ctx.moveTo(earRX1 + (earRTpX - earRX1)*0.24, earRY1 + (earRTpY - earRY1)*0.24);
        ctx.lineTo(earRTpX - Math.cos(earAngleRight)*1.2, earRTpY + Math.sin(earAngleRight)*1.2);
        ctx.lineTo(earRX2 + (earRTpX - earRX2)*0.24, earRY2 + (earRTpY - earRX2)*0.24);
        ctx.closePath();
        ctx.fill();

        // Shaded 3D Sphere Player Core Body
        ctx.beginPath();
        ctx.arc(pBody.x, pBody.y, rSphere, 0, Math.PI * 2);
        
        const grad = ctx.createRadialGradient(
          pBody.x - rSphere * 0.3,
          pBody.y - rSphere * 0.3,
          rSphere * 0.05,
          pBody.x,
          pBody.y,
          rSphere
        );

        grad.addColorStop(0, '#FFFFFF'); // glossy specular highlight
        grad.addColorStop(0.35, coreColor);
        grad.addColorStop(1, shadeColor(coreColor, -35)); // bottom right wrap shadow

        ctx.fillStyle = grad;
        ctx.fill();
        
        ctx.strokeStyle = player.id === personalId ? '#FFFFFF' : 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = player.id === personalId ? 2.5 : 1.2;
        ctx.stroke();

        // Draw Adorable Whiskers and blushing cheeks
        ctx.fillStyle = 'rgba(253, 164, 175, 0.7)'; // soft blushing cheeks
        ctx.beginPath();
        ctx.arc(pBody.x - rSphere * 0.45, pBody.y + rSphere * 0.15, rSphere * 0.18, 0, Math.PI * 2);
        ctx.arc(pBody.x + rSphere * 0.45, pBody.y + rSphere * 0.15, rSphere * 0.18, 0, Math.PI * 2);
        ctx.fill();

        // Whiskers outline
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.lineWidth = 1 * pBody.scale;
        ctx.beginPath();
        // Left cheeks whiskers
        ctx.moveTo(pBody.x - rSphere * 0.48, pBody.y + rSphere * 0.12);
        ctx.lineTo(pBody.x - rSphere * 0.85, pBody.y + rSphere * 0.1);
        ctx.moveTo(pBody.x - rSphere * 0.48, pBody.y + rSphere * 0.19);
        ctx.lineTo(pBody.x - rSphere * 0.82, pBody.y + rSphere * 0.25);
        // Right cheeks whiskers
        ctx.moveTo(pBody.x + rSphere * 0.48, pBody.y + rSphere * 0.12);
        ctx.lineTo(pBody.x + rSphere * 0.85, pBody.y + rSphere * 0.12);
        ctx.moveTo(pBody.x + rSphere * 0.48, pBody.y + rSphere * 0.19);
        ctx.lineTo(pBody.x + rSphere * 0.82, pBody.y + rSphere * 0.25);
        ctx.stroke();

        // Ninja Headband Strap wrapping across forehead
        ctx.fillStyle = '#111827'; // solid deep dark fabric
        ctx.fillRect(pBody.x - rSphere * 0.93, pBody.y - rSphere * 0.35, rSphere * 1.86, rSphere * 0.38);

        // Cozy curved focused ninja cat eyes inside the strap fabric
        ctx.lineWidth = 1.6 * pBody.scale;
        ctx.strokeStyle = '#FFFFFF';
        ctx.beginPath();
        // Left cute eye arc (sleeping happy style "^ _ ^")
        ctx.arc(pBody.x - rSphere * 0.32, pBody.y - rSphere * 0.12, rSphere * 0.1, Math.PI, 0, false);
        // Right cute eye arc
        ctx.arc(pBody.x + rSphere * 0.32, pBody.y - rSphere * 0.12, rSphere * 0.1, Math.PI, 0, false);
        ctx.stroke();

        // Draw speed motion trails if speed boosted
        if (isSpeedBoosted) {
          const t1 = project(lRef.x - player.vx * 12, lRef.y - player.vy * 12, 10);
          ctx.beginPath();
          ctx.arc(t1.x, t1.y, (PLAYER_RADIUS - 4) * t1.scale, 0, Math.PI * 2);
          ctx.fillStyle = `${player.color}44`;
          ctx.fill();
          
          const t2 = project(lRef.x - player.vx * 22, lRef.y - player.vy * 22, 10);
          ctx.beginPath();
          ctx.arc(t2.x, t2.y, (PLAYER_RADIUS - 8) * t2.scale, 0, Math.PI * 2);
          ctx.fillStyle = `${player.color}18`;
          ctx.fill();
        }

        // 3D Glass block / Frozen enclosure cage
        if (isFrozen) {
          const iceSz = PLAYER_RADIUS + 3;
          draw3DBox(lRef.x - iceSz, lRef.y - iceSz, iceSz * 2, iceSz * 2, 22, 'rgba(186, 230, 253, 0.3)', 'rgba(56, 189, 248, 0.5)');
        }

        // Player Labels & Initials inside Marble
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 12px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        let initialLabel = player.name.substring(0, 2).toUpperCase();
        if (player.isIt) {
          initialLabel = room.config.mode === 'bomb' ? '💣' : '🏃';
        }
        ctx.fillText(initialLabel, pBody.x, pBody.y);

        // Floating Indicator Arrow for active user
        if (player.id === personalId) {
          const arrowProj = project(lRef.x, lRef.y, PLAYER_RADIUS * 1.5 + 12);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 9px Inter';
          ctx.fillText('▼', arrowProj.x, arrowProj.y);
        }

        // Name tags above the floating player body
        const nameProj = project(lRef.x, lRef.y, PLAYER_RADIUS * 1.5);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 11px Inter';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        const namePlusStatus = player.isIt 
          ? (room.config.mode === 'bomb' ? `💣 ${player.name}` : `👹 ${player.name}`) 
          : player.name;
        ctx.strokeText(namePlusStatus, nameProj.x, nameProj.y - 6);
        ctx.fillText(namePlusStatus, nameProj.x, nameProj.y - 6);

        // Speech bubble balloon floating high up
        if (player.message && nowTs < player.messageExpiresAt) {
          const text = player.message;
          ctx.font = '11px Inter';
          const textWidth = ctx.measureText(text).width;
          const bubbleW = Math.max(45, textWidth + 14);
          const bubbleH = 22;

          const bubbleProj = project(lRef.x, lRef.y, PLAYER_RADIUS * 1.5 + 26);
          const bubbleX = bubbleProj.x - (bubbleW / 2);
          const bubbleY = bubbleProj.y - 20;

          ctx.fillStyle = '#FFFFFF';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 6);
          ctx.fill();
          ctx.stroke();

          // Anchor triangle
          ctx.beginPath();
          ctx.moveTo(bubbleProj.x - 5, bubbleY + bubbleH);
          ctx.lineTo(bubbleProj.x, bubbleY + bubbleH + 4);
          ctx.lineTo(bubbleProj.x + 5, bubbleY + bubbleH);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#0F172A';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 11px Inter';
          ctx.fillText(text, bubbleProj.x, bubbleY + (bubbleH / 2));
        }

        // Float emojis separately above everything
        if (player.emoji && nowTs < player.emojiExpiresAt) {
          const emojiProj = project(lRef.x, lRef.y, PLAYER_RADIUS * 1.5 + 44);
          ctx.font = '28px Inter';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const floatOffset = Math.sin(nowTs / 70) * 4;
          ctx.fillText(player.emoji, emojiProj.x, emojiProj.y + floatOffset);
        }
      });

      // 8. Draw Gentle Map-specific Atmospheric Particles
      if (activeMap === 'blocks') {
        // SNOW PARTICLES (Winter)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        const snowCount = 42;
        for (let i = 0; i < snowCount; i++) {
          const seedX = (i * 7919) % MAP_WIDTH;
          const seedSpeed = 1 + (i % 3) * 0.5;
          const timeOffset = (Date.now() / 15) * seedSpeed;
          
          const sx = (seedX + Math.sin(Date.now() / 1000 + i) * 20) % MAP_WIDTH;
          const sy = (timeOffset + (i * 17)) % MAP_HEIGHT;
          const sz = 1.2 + (i % 4) * 0.6;
          
          ctx.beginPath();
          ctx.arc(sx, sy, sz, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (activeMap === 'open') {
        // CHERRY BLOSSOM PETALS / NATURE FLURRY (Summer Garden)
        ctx.fillStyle = 'rgba(244, 143, 177, 0.75)'; // Soft pink petals
        const petalCount = 24;
        for (let i = 0; i < petalCount; i++) {
          const seedX = (i * 7919) % MAP_WIDTH;
          const seedSpeed = 0.6 + (i % 3) * 0.3;
          const timeOffset = (Date.now() / 24) * seedSpeed;
          
          // drift diagonally (wind blowing)
          const sx = (seedX + (Date.now() / 32) * 0.4 + Math.sin(Date.now() / 1500 + i) * 35) % MAP_WIDTH;
          const sy = (timeOffset + (i * 28)) % MAP_HEIGHT;
          const sz = 2.0 + (i % 3) * 1.2;
          
          ctx.beginPath();
          ctx.ellipse(sx, sy, sz, sz * 0.55, 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (activeMap === 'maze') {
        // GOLDEN SAND DUST (Egyptian Desert)
        ctx.fillStyle = 'rgba(245, 158, 11, 0.55)'; // Glowing amber sand grains
        const sandCount = 38;
        for (let i = 0; i < sandCount; i++) {
          const seedX = (i * 7919) % MAP_WIDTH;
          const seedSpeed = 1.2 + (i % 4) * 0.6;
          const timeOffset = (Date.now() / 12) * seedSpeed;
          
          // fast horizontal wind-blown sand
          const sx = (seedX - (Date.now() / 8) * seedSpeed) % MAP_WIDTH;
          const sy = (timeOffset + (i * 20)) % MAP_HEIGHT;
          const adjSx = sx < 0 ? MAP_WIDTH + (sx % MAP_WIDTH) : sx % MAP_WIDTH; // handle wrap around safely
          const sz = 1.0 + (i % 3) * 0.6;
          
          ctx.beginPath();
          ctx.arc(adjSx, sy, sz, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (activeMap === 'arena') {
        // SPARKLING SUNBEAMS / SEA MIST (Beach)
        ctx.fillStyle = 'rgba(254, 240, 138, 0.45)'; // Warm yellow-white sparkles
        const sunCount = 18;
        for (let i = 0; i < sunCount; i++) {
          const seedX = (i * 7919) % MAP_WIDTH;
          const seedY = (i * 31) % MAP_HEIGHT;
          
          // shimmering sparkle
          const sx = seedX;
          const sy = seedY + Math.sin(Date.now() / 600 + i) * 6;
          const sz = (1.5 + (i % 3) * 1.5) * (0.6 + Math.sin(Date.now() / 300 + i) * 0.4); // shiny pulse
          
          if (sz > 0.2) {
            ctx.beginPath();
            ctx.arc(sx, sy, sz, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Special Match Starting Overlay
      if (room.status === 'countdown') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 72px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(room.countdownTimer), MAP_WIDTH / 2, MAP_HEIGHT / 2 - 30);

        ctx.font = 'bold 20px Inter';
        ctx.fillStyle = '#E2E8F0';
        ctx.fillText('MATCH COMMENCING...', MAP_WIDTH / 2, MAP_HEIGHT / 2 + 40);

        ctx.font = '13px Inter';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText(`Mode: ${room.config.mode.toUpperCase() === 'BOMB' ? '💣 HOT BOMB (Potato)' : '🏃 CLASSIC CHASE'}  |  Map: ${room.config.map.toUpperCase()}`, MAP_WIDTH / 2, MAP_HEIGHT / 2 + 80);
      }

      animationId = requestAnimationFrame(gameLoop);
    };

    animationId = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animationId);
  }, [room, personalId, ws]);

  // Clean disconnect of unneeded predicted coordinate hashes
  useEffect(() => {
    return () => {
      otherPlayersLerpRef.current = {};
    };
  }, []);

  // Joystick controller directions
  const handleTouchDir = (dx: number, dy: number, keyName: string) => {
    touchDirectionRef.current = { x: dx, y: dy };
    setActiveTouchKeys({ [keyName]: true });
  };

  const handleTouchRelease = () => {
    touchDirectionRef.current = { x: 0, y: 0 };
    setActiveTouchKeys({});
  };

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden flex flex-col items-center bg-slate-900 border-4 border-slate-700 rounded-xl shadow-2xl">
      {/* HUD overlay inside top area */}
      <div className="absolute top-3 left-4 right-4 py-1.5 px-4 bg-slate-950/80 backdrop-blur-md border border-slate-800 rounded-lg flex items-center justify-between z-10 select-none">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2 py-0.5 bg-slate-800 rounded text-slate-400">Map</span>
          <span className="text-sm font-bold text-white capitalize">{room.config.map}</span>
        </div>

        <div className="flex items-center gap-1.5 bg-rose-500/10 text-rose-400 border border-rose-500/20 px-3 py-1 rounded-md font-mono text-sm font-black">
          {room.config.mode === 'bomb' ? '💣 BOMB ACTIVE' : '🏃 STATE: ACTIVE'}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400 font-bold uppercase font-mono">Time Left:</span>
          <span className={`text-xl font-black font-mono transition-colors ${room.timer <= 10 ? 'text-red-500 animate-pulse' : 'text-emerald-400'}`}>
            {room.timer}s
          </span>
        </div>
      </div>

      {/* Canvas */}
      <div className="bg-slate-900 flex items-center justify-center p-1 w-full max-w-full overflow-x-auto">
        <canvas
          id="tag-game-canvas"
          ref={canvasRef}
          width={MAP_WIDTH}
          height={MAP_HEIGHT}
          className="block bg-slate-950 max-w-[900px] w-full aspect-[3/2] h-auto cursor-crosshair"
        />
      </div>

      {/* Control Instruction Tips - Desktop */}
      <div className="hidden md:flex w-full justify-between items-center bg-slate-950 px-5 py-3 border-t border-slate-800 text-xs text-slate-400">
        <div>🔑 Use <strong className="text-slate-200">W, A, S, D</strong> or <strong className="text-slate-200">Arrow Keys</strong> to run around the arena.</div>
        <div className="flex gap-4">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#EF4444] inline-block animate-ping"></span> Red is IT/Bomb</span>
          <span>⚡ Powerups spawn every 8 seconds!</span>
        </div>
      </div>

      {/* Touch Controllers for Mobile */}
      {isMobile && (
        <div className="w-full flex flex-col items-center bg-slate-950 p-4 border-t border-slate-800 z-10 select-none">
          <div className="text-xs text-center text-slate-500 mb-2 font-bold uppercase tracking-wider">Mobile Virtual D-Pad</div>
          <div className="relative w-44 h-44 grid grid-cols-3 grid-rows-3 gap-1.5">
            {/* Top Empty padding */}
            <div></div>
            <button
              id="mobile-btn-up"
              onTouchStart={() => handleTouchDir(0, -1, 'up')}
              onTouchEnd={handleTouchRelease}
              className={`flex items-center justify-center rounded-xl font-bold text-2xl border transition-all ${
                activeTouchKeys['up']
                  ? 'bg-sky-500 text-white border-sky-400 scale-95 shadow-inner'
                  : 'bg-slate-800 text-slate-300 border-slate-700 active:bg-slate-700'
              }`}
            >
              ▲
            </button>
            <div></div>

            {/* Middle Row */}
            <button
              id="mobile-btn-left"
              onTouchStart={() => handleTouchDir(-1, 0, 'left')}
              onTouchEnd={handleTouchRelease}
              className={`flex items-center justify-center rounded-xl font-bold text-2xl border transition-all ${
                activeTouchKeys['left']
                  ? 'bg-sky-500 text-white border-sky-400 scale-95 shadow-inner'
                  : 'bg-slate-800 text-slate-300 border-slate-700 active:bg-slate-700'
              }`}
            >
              ◀
            </button>
            <div className="bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-center text-xs font-mono text-slate-600 font-bold">
              RUN
            </div>
            <button
              id="mobile-btn-right"
              onTouchStart={() => handleTouchDir(1, 0, 'right')}
              onTouchEnd={handleTouchRelease}
              className={`flex items-center justify-center rounded-xl font-bold text-2xl border transition-all ${
                activeTouchKeys['right']
                  ? 'bg-sky-500 text-white border-sky-400 scale-95 shadow-inner'
                  : 'bg-slate-800 text-slate-300 border-slate-700 active:bg-slate-700'
              }`}
            >
              ▶
            </button>

            {/* Bottom Row */}
            <div></div>
            <button
              id="mobile-btn-down"
              onTouchStart={() => handleTouchDir(0, 1, 'down')}
              onTouchEnd={handleTouchRelease}
              className={`flex items-center justify-center rounded-xl font-bold text-2xl border transition-all ${
                activeTouchKeys['down']
                  ? 'bg-sky-500 text-white border-sky-400 scale-95 shadow-inner'
                  : 'bg-slate-800 text-slate-300 border-slate-700 active:bg-slate-700'
              }`}
            >
              ▼
            </button>
            <div></div>
          </div>
        </div>
      )}
    </div>
  );
}
