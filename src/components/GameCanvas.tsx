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

  // Update starting position when room begins
  useEffect(() => {
    const localPlayer = room.players[personalId];
    if (localPlayer) {
      playerPosRef.current = { x: localPlayer.x, y: localPlayer.y };
    }
  }, [room.status, personalId]);

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

      // Define 3D projection mathematical system
      const project = (wx: number, wy: number, wz: number = 0) => {
        const cx = wx - MAP_WIDTH / 2;
        const cy = wy - MAP_HEIGHT / 2;

        const tiltAngle = 36 * Math.PI / 180; // beautiful 36 deg tilt
        const cosT = Math.cos(tiltAngle);
        const sinT = Math.sin(tiltAngle);

        const xScaled = cx * 0.82;
        const yScaled = cy * 0.65;

        const rotY = yScaled * cosT - wz * sinT;
        const rotZ = yScaled * sinT + wz * cosT;

        const D = 550;
        const perspectiveScale = D / (D + rotZ * 0.55);

        const screenX = MAP_WIDTH / 2 + xScaled * perspectiveScale;
        const screenY = MAP_HEIGHT / 2 + 35 + rotY * perspectiveScale;

        return { x: screenX, y: screenY, scale: perspectiveScale };
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

      // 1. Draw Space background starry grid field
      ctx.fillStyle = '#020617'; // deepest space dark blue
      ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

      // 2. Draw 3D Arena Ground Floor plate
      const fl1 = project(0, 0, 0);
      const fl2 = project(MAP_WIDTH, 0, 0);
      const fl3 = project(MAP_WIDTH, MAP_HEIGHT, 0);
      const fl4 = project(0, MAP_HEIGHT, 0);

      ctx.fillStyle = '#0F172A'; // slate-900 floor
      ctx.beginPath();
      ctx.moveTo(fl1.x, fl1.y);
      ctx.lineTo(fl2.x, fl2.y);
      ctx.lineTo(fl3.x, fl3.y);
      ctx.lineTo(fl4.x, fl4.y);
      ctx.closePath();
      ctx.fill();

      // Neon glowing platform outline
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)'; // cyan sky glow rim
      ctx.lineWidth = 3;
      ctx.stroke();

      // 3. Draw Beautiful receding Grid Lines on the floor plate
      ctx.strokeStyle = '#1e293b';
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
      // This builds real thick physical borders on our platform
      const borderH = 20;
      const bcTop = '#334155';
      const bcSide = '#1E293B';
      draw3DBox(-8, -8, MAP_WIDTH + 16, 8, borderH, bcTop, bcSide); // Top wall
      draw3DBox(-8, MAP_HEIGHT, MAP_WIDTH + 16, 8, borderH, bcTop, bcSide); // Bottom wall
      draw3DBox(-8, 0, 8, MAP_HEIGHT, borderH, bcTop, bcSide); // Left wall
      draw3DBox(MAP_WIDTH, 0, 8, MAP_HEIGHT, borderH, bcTop, bcSide); // Right wall

      // 5. Draw 3D Walls for the active map configuration
      walls.forEach(wall => {
        // High-tech slate block with illuminated cyan/slate highlight rims
        draw3DBox(wall.x, wall.y, wall.w, wall.h, 34, '#475569', '#334155');
      });

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
        const pBody = project(lRef.x, lRef.y, 10); // slightly float players on the 3D surface!

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

        // Shaded 3D Sphere Player Core
        const rSphere = PLAYER_RADIUS * pBody.scale;
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

        let coreColor = isFrozen ? '#93C5FD' : player.color;
        grad.addColorStop(0, '#FFFFFF'); // dynamic glossy reflection highlight
        grad.addColorStop(0.35, coreColor);
        grad.addColorStop(1, shadeColor(coreColor, -35)); // bottom right shadow wrap

        ctx.fillStyle = grad;
        ctx.fill();
        
        ctx.strokeStyle = player.id === personalId ? '#FFFFFF' : 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = player.id === personalId ? 2.5 : 1.2;
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
