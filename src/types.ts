export interface GameConfig {
  maxPlayers: number;
  duration: number; // in seconds
  speed: 'slow' | 'normal' | 'fast' | 'insane';
  mode: 'classic' | 'bomb'; // classic: standard tag, bomb: hot potato
  map: 'arena' | 'maze' | 'open' | 'blocks';
}

export interface Player {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  isIt: boolean;
  isAlive: boolean;
  score: number; // points/survival time
  shieldUntil: number; // server timestamp
  speedBoostUntil: number; // server timestamp
  frozenUntil: number; // server timestamp
  emoji: string | null;
  emojiExpiresAt: number; // server timestamp
  message: string | null;
  messageExpiresAt: number; // server timestamp
  lastTeleportTime?: number; // server timestamp to handle portal exit cooldowns
}

export interface PowerUp {
  id: string;
  type: 'speed' | 'shield' | 'teleport' | 'freeze';
  x: number;
  y: number;
  active: boolean;
}

export interface Wall {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: 'lobby' | 'countdown' | 'playing' | 'gameover';
  config: GameConfig;
  players: Record<string, Player>;
  powerUps: PowerUp[];
  timer: number; // remaining seconds
  countdownTimer: number; // pre-game countdown (e.g., 5 seconds)
  tagCooldownUntil: number; // server timestamp when tagging is valid
  lastTaggerId: string | null;
  winnerId: string | null;
}

export type ClientMessage =
  | { type: 'join'; name: string; color: string; roomCode: string }
  | { type: 'create'; config: GameConfig; name: string; color: string }
  | { type: 'update_config'; config: GameConfig }
  | { type: 'start_game' }
  | { type: 'move'; x: number; y: number; vx: number; vy: number }
  | { type: 'emoji'; emoji: string }
  | { type: 'chat'; text: string }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'room_snapshot'; room: Room; personalId: string }
  | { type: 'room_updated'; room: Room }
  | { type: 'error'; message: string }
  | { type: 'chat_feed'; id: string; name: string; color: string; text: string; timestamp: number }
  | { type: 'tag_event'; fromName: string; toName: string; gameMode: 'classic' | 'bomb' }
  | { type: 'explosion_event'; playerName: string }
  | { type: 'powerup_grant'; powerupType: string; playerName: string };
