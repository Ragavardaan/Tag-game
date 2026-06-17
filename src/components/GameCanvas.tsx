import { useEffect, useRef, useState } from 'react';
import { Room, Player } from '../types';
import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, POWERUP_RADIUS, MAP_WALLS, checkWallCollision } from '../maps';

interface GameCanvasProps {
  room: Room;
  personalId: string;
  ws: WebSocket | null;
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

          // If moved, save state and send ws message
          if (targetX !== oldX || targetY !== oldY) {
            playerPosRef.current = { x: targetX, y: targetY };
            
            if (ws && ws.readyState === WebSocket.OPEN) {
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

      // 4. DRAW GRAPHICS FOR THE SCREEN
      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

      // Draw Grid lines background for high-tech arena feel
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 1;
      const gridSize = 40;
      for (let x = 0; x < MAP_WIDTH; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, MAP_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0; y < MAP_HEIGHT; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(MAP_WIDTH, y);
        ctx.stroke();
      }

      // Draw Walls configured for the map
      walls.forEach(wall => {
        // Drop shadows
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(wall.x + 3, wall.y + 3, wall.w, wall.h);

        // Core Block
        ctx.fillStyle = '#334155';
        ctx.fillRect(wall.x, wall.y, wall.w, wall.h);

        // Tech borders
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);

        // Inner glowing stripes for aesthetic
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(wall.x + 4, wall.y + 4);
        ctx.lineTo(wall.x + wall.w - 4, wall.y + wall.h - 4);
        ctx.stroke();
      });

      // Draw power-ups
      room.powerUps.forEach(pu => {
        if (!pu.active) return;

        // Pulsing power-up radius circle glow
        const pulse = 2 + Math.abs(Math.sin(Date.now() / 200)) * 5;
        ctx.beginPath();
        ctx.arc(pu.x, pu.y, POWERUP_RADIUS + pulse, 0, Math.PI * 2);

        let color = '#EAB308'; // Default yellow speed
        let char = '⚡';
        if (pu.type === 'shield') {
          color = '#3B82F6'; // Blue
          char = '🛡️';
        } else if (pu.type === 'teleport') {
          color = '#A855F7'; // Purple
          char = '🌀';
        } else if (pu.type === 'freeze') {
          color = '#06B6D4'; // Cyan
          char = '❄️';
        }

        ctx.fillStyle = `${color}22`; // semi-transparent glow
        ctx.fill();

        // Core circle
        ctx.beginPath();
        ctx.arc(pu.x, pu.y, POWERUP_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Icon symbol inside
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(char, pu.x, pu.y);
      });

      // Draw all players
      Object.keys(room.players).forEach(pId => {
        const player = room.players[pId];
        
        // Setup lerped positions to prevent other player coordinates jumping around
        if (!otherPlayersLerpRef.current[pId]) {
          otherPlayersLerpRef.current[pId] = { x: player.x, y: player.y };
        }

        const lRef = otherPlayersLerpRef.current[pId];

        // Smooth lerping for remote players, lock direct representation for local player
        if (pId === personalId) {
          lRef.x = playerPosRef.current.x;
          lRef.y = playerPosRef.current.y;
        } else {
          // Lerp towards target server absolute coordinates
          lRef.x += (player.x - lRef.x) * 0.25;
          lRef.y += (player.y - lRef.y) * 0.25;
        }

        if (!player.isAlive) {
          // Dead players (Exploded in Bomb Mode) are represented as tiny custom cross/skull tombstone
          ctx.font = '22px Inter';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('💀', lRef.x, lRef.y);
          
          // Draw gray name above
          ctx.fillStyle = '#94A3B8';
          ctx.font = 'bold 11px Inter';
          ctx.fillText(`${player.name} (RIP)`, lRef.x, lRef.y - 25);
          return;
        }

        const nowTs = Date.now();
        const isShielded = nowTs < player.shieldUntil;
        const isSpeedBoosted = nowTs < player.speedBoostUntil;
        const isFrozen = nowTs < player.frozenUntil;

        // Glow halo under player
        const baseGlowSize = player.isIt ? 22 : 12;
        const pulseRatio = Math.sin(nowTs / 120);
        const glowRadius = baseGlowSize + (player.isIt ? (pulseRatio * 8) : (pulseRatio * 2));
        
        ctx.beginPath();
        ctx.arc(lRef.x, lRef.y, glowRadius, 0, Math.PI * 2);
        
        let glowColor = player.isIt ? '#EF4444' : `${player.color}55`;
        if (player.isIt && room.config.mode === 'bomb') glowColor = '#E11D48'; // intense red for bomb
        if (isFrozen) glowColor = '#38BDF8';

        ctx.fillStyle = glowColor;
        ctx.fill();

        // Pulse warning bands if Tag grace/cooldown is active and they are IT
        if (player.isIt && nowTs < room.tagCooldownUntil) {
          ctx.beginPath();
          ctx.arc(lRef.x, lRef.y, PLAYER_RADIUS + 8, 0, Math.PI * 2);
          ctx.strokeStyle = '#EF4444';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.stroke();
          ctx.setLineDash([]); // reset
        }

        // Draw Player core circular avatar
        ctx.beginPath();
        ctx.arc(lRef.x, lRef.y, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = isFrozen ? '#93C5FD' : player.color;
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = player.id === personalId ? 2.5 : 1.5;
        ctx.stroke();

        // Speed trailing circles for visual feedback
        if (isSpeedBoosted) {
          ctx.beginPath();
          ctx.arc(lRef.x - (player.vx * 12), lRef.y - (player.vy * 12), PLAYER_RADIUS - 4, 0, Math.PI * 2);
          ctx.fillStyle = `${player.color}55`;
          ctx.fill();
          
          ctx.beginPath();
          ctx.arc(lRef.x - (player.vx * 22), lRef.y - (player.vy * 22), PLAYER_RADIUS - 8, 0, Math.PI * 2);
          ctx.fillStyle = `${player.color}22`;
          ctx.fill();
        }

        // Shield glowing bubble overlay
        if (isShielded) {
          ctx.beginPath();
          ctx.arc(lRef.x, lRef.y, PLAYER_RADIUS + 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
          ctx.fill();
          ctx.strokeStyle = '#60A5FA';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Frozen ice cube overlay
        if (isFrozen) {
          ctx.fillStyle = 'rgba(186, 230, 253, 0.5)';
          ctx.fillRect(lRef.x - 14, lRef.y - 14, 28, 28);
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(lRef.x - 14, lRef.y - 14, 28, 28);
        }

        // Draw Initials inside Avatar
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 12px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        let initialLabel = player.name.substring(0, 2).toUpperCase();
        if (player.isIt) {
          initialLabel = room.config.mode === 'bomb' ? '💣' : '🏃';
        }
        ctx.fillText(initialLabel, lRef.x, lRef.y);

        // Draw Indicator label for "YOU"
        if (player.id === personalId) {
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 9px Inter';
          ctx.fillText('▼', lRef.x, lRef.y - PLAYER_RADIUS - 16);
        }

        // Draw name tags cleanly above character
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 11px Inter';
        ctx.textAlign = 'center';
        // Stroke around text for readability under grid
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        const namePlusStatus = player.isIt 
          ? (room.config.mode === 'bomb' ? `💣 ${player.name}` : `👹 ${player.name}`) 
          : player.name;
        ctx.strokeText(namePlusStatus, lRef.x, lRef.y - PLAYER_RADIUS - 6);
        ctx.fillText(namePlusStatus, lRef.x, lRef.y - PLAYER_RADIUS - 6);

        // Draw Speech Bubble / Text Messages dynamically above player
        if (player.message && nowTs < player.messageExpiresAt) {
          const text = player.message;
          ctx.font = '11px Inter';
          const textWidth = ctx.measureText(text).width;
          const bubbleW = Math.max(45, textWidth + 14);
          const bubbleH = 22;
          const bubbleX = lRef.x - (bubbleW / 2);
          const bubbleY = lRef.y - PLAYER_RADIUS - 44;

          // Drawing bubble box
          ctx.fillStyle = '#FFFFFF';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 6);
          ctx.fill();
          ctx.stroke();

          // Bubble little anchor triangle pointing down
          ctx.beginPath();
          ctx.moveTo(lRef.x - 5, bubbleY + bubbleH);
          ctx.lineTo(lRef.x, bubbleY + bubbleH + 5);
          ctx.lineTo(lRef.x + 5, bubbleY + bubbleH);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.stroke();

          // Print message text
          ctx.fillStyle = '#0F172A';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 11px Inter';
          ctx.fillText(text, lRef.x, bubbleY + (bubbleH / 2));
        }

        // Draw Big Floating Emoji above Player separately for funny interactions!
        if (player.emoji && nowTs < player.emojiExpiresAt) {
          ctx.font = '28px Inter';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Draw floating animated emoji (rhythm wave)
          const floatOffset = Math.sin(nowTs / 70) * 4;
          ctx.fillText(player.emoji, lRef.x, lRef.y - PLAYER_RADIUS - 64 + floatOffset);
        }
      });

      // Special Status overlays for Countdown states on the Canvas
      if (room.status === 'countdown') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
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
