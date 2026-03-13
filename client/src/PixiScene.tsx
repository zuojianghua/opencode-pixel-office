import { Container, Graphics, Sprite, Stage, Text, useTick } from "@pixi/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Graphics as PixiGraphics } from "pixi.js";
import {
  BaseTexture,
  Rectangle,
  SCALE_MODES,
  settings,
  Texture,
  TextMetrics,
  TextStyle,
} from "pixi.js";
import type { Agent, Interaction, SessionInfo, TodoSummary } from "./useOfficeState";
import { ActivityBubble } from "./components/pixi/ActivityBubble";
import type { ActivityBubbleData } from "./components/pixi/ActivityBubble";
import { MessageBubble } from "./components/pixi/MessageBubble";
import type { MessageBubbleData } from "./components/pixi/MessageBubble";
import { drawRoundedRect } from "./components/pixi/drawRoundedRect";
import { buildOfficeMap } from "./OfficeMap";
import { runAgentSimulation } from "./AgentSimulation";
import {
  computePath,
  hashId,
  nodeKey,
  pickExitTarget,
  pickMainExitNode,
  pickNode,
} from "./Agent";
import type {
  CollisionMapData,
  DoorVisualState,
  RoomRegion,
  SpriteState,
} from "./Agent";

settings.SCALE_MODE = SCALE_MODES.NEAREST;
settings.ROUND_PIXELS = true;



type RenderableItem = { type: "agent"; id: string; y: number };

type DirectionFrames = {
  right: Texture[];
  down: Texture[];
  up: Texture[];
};

type SpriteSheets = {
  idle?: DirectionFrames;
  walk?: DirectionFrames;
  run?: DirectionFrames;
  jump?: DirectionFrames;
};

const TileMap = ({ map, textures }: { map: string[][]; textures: { [key: string]: Texture | null } }) => {
  if (!map || !textures) return null;
  const sprites: JSX.Element[] = [];

  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      const type = map[r][c];

      // Filter out transparent tiles for Overlay Mode
      // We explicitly WANT "door_open" to render (as floor) to cover the background.
      // We explicitly WANT "door_closed" (or partition) to render.
      // We SKIP normal "floor" and "grass" to let background show.
      if (!type || type === "grass" || type === "floor" || type === "path" || type === "carpet" || type === "window") {
        continue;
      }

      const texture = textures[type];
      if (texture) {
        sprites.push(<Sprite key={`${r}-${c}`} texture={texture} x={c * TILE} y={r * TILE} />);
      }
    }
  }
  return <Container>{sprites}</Container>;
};

type PixiSceneProps = {
  agents: Agent[];
  interactions: Interaction[];
  sessions: SessionInfo[];
  activeSessionId: string | null;
  lastTodoSummary: TodoSummary | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  activeTab?: "opencode" | "claude";
};

const TILE = 4;
// Offset for grid alignment (if needed)
const OFFSET_Y = 0;
const OFFSET_X = 0;

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;
const DEFAULT_MAP_COLS = Math.floor(DEFAULT_WIDTH / TILE);
const DEFAULT_MAP_ROWS = Math.floor(DEFAULT_HEIGHT / TILE);

const COLORS = {
  grass: 0xa8d070,
  grassShadow: 0x8bb85f,
  path: 0xf0d69a,
  pathShadow: 0xd7be7f,
  floor: 0xdabf86,
  floorShadow: 0xc5a874,
  wall: 0x8b7a5c,
  wallShadow: 0x6f5f45,
  desk: 0x8d6b4f,
  deskShadow: 0x75543d,
  window: 0x8ccde9,
  hud: 0x3b3766,
  hudBorder: 0x6f6ab0,
  hudInset: 0x242047,
  text: 0xfaf2dd,
  shadow: 0x1b1a2b,
  idle: 0x9ac7b8,
  thinking: 0xf6c876,
  working: 0x6fb5ff,
  planning: 0xc1a1ff,
  error: 0xff7a7a,
  link: 0x9df5c0,
};

const AVATAR_COLORS = [
  0xf2a271,
  0x7bdff2,
  0xb9f18c,
  0xf5e960,
  0xb38df4,
  0xf28ca2,
  0x8cc5ff,
  0xf7b978,
];

const MESSAGE_TTL_MS = 3000;
const TYPING_TTL_MS = 800;
const MESSAGE_MAX_WIDTH = 140;
const MESSAGE_MIN_WIDTH = 48;
const MESSAGE_MAX_LINES = 10;
const MESSAGE_PADDING = 6;
const ACTIVITY_TTL_MS = 1400;
// Event visuals mapping:
// tool.execute.before/after => ring (color by before/after)
// file.edited/file.watcher.updated => ✏️
// message.updated/message.part.updated => 💭 (status)
// message.removed/message.part.removed => gray badge
// command.executed/installation.updated/lsp.*/permission.*/server.connected/tui.* => colored badge
// session.* => meeting-room lamp
// todo.updated => clipboard pop
const EVENT_TTL_MS = 4000;
const EVENT_BADGE_COLORS: Record<string, number> = {
  "command.executed": 0xf2c14e,
  "installation.updated": 0x7aa0d8,
  "lsp.client.diagnostics": 0xf06a6a,
  "lsp.updated": 0x7aa0d8,
  "message.removed": 0x9aa3b2,
  "message.part.removed": 0x9aa3b2,
  "permission.asked": 0xc39be0,
  "permission.replied": 0x7fcf9a,
  "server.connected": 0x6bd5c1,
  "tui.prompt.append": 0x7fd3ff,
  "tui.command.execute": 0x7fd3ff,
  "tui.toast.show": 0x7fd3ff,
};
const EXIT_TTL_MS = 2600;
const GOODBYE_TTL_MS = 1400;
const PRE_EXIT_FAREWELL_MS = 1200;
const IDLE_DESK_GRACE_MS = 7000;
const FAREWELL_TEXTS = ["再见", "我先溜了", "下班了"];

const EXIT_OFFSET_X = 0;
const EXIT_OFFSET_Y = 0;

const tileToPixel = (tile: { col: number; row: number }) => ({
  x: tile.col * TILE + TILE / 2 + OFFSET_X,
  y: tile.row * TILE + TILE / 2 + OFFSET_Y,
});

const pixelToTile = (x: number, y: number) => ({
  col: Math.round((x - OFFSET_X - TILE / 2) / TILE),
  row: Math.round((y - OFFSET_Y - TILE / 2) / TILE),
});

const doorTile = () => {
  // Fallback to center of default layout (48, 48)
  return { row: 48 * 2, col: 48 * 2 };
};

const statusRadius = (status: string) => {
  switch (status) {
    case "working":
      return 0;
    case "idle":
      return 6;
    case "thinking":
      return 3;
    case "planning":
      return 4;
    case "error":
      return 1;
    default:
      return 2;
  }
};

const pickAvatarColor = (agent: Agent) => {
  const id = agent.id || "";
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 997;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};

// Tag color palettes for different sessions (fill, stroke pairs)
const TAG_COLORS: [number, number][] = [
  [0x2b5a3c, 0x73d28f], // green
  [0x3a4a6b, 0x7a9fd8], // blue
  [0x5a3a5a, 0xc28fd2], // purple
  [0x5a4a2b, 0xd2a873], // orange
  [0x3a5a5a, 0x73c2c2], // teal
  [0x5a2b3a, 0xd27389], // pink
  [0x4a4a3a, 0xa8a878], // olive
  [0x3a3a5a, 0x8888c2], // indigo
];

const pickTagColors = (sessionId?: string): [number, number] => {
  if (!sessionId) return TAG_COLORS[0];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) % 997;
  }
  return TAG_COLORS[hash % TAG_COLORS.length];
};

const statusBubbleText = (status: string) => {
  switch (status) {
    case "idle":
      return "空闲";
    case "thinking":
      return "思考中";
    case "planning":
      return "规划中";
    case "working":
      return "工作中";
    case "error":
      return "出错";
    default:
      return "工作中";
  }
};

const wrapLines = (
  text: string,
  maxWidth: number,
  style: TextStyle,
  maxLines: number
) => {
  if (!text) {
    return [""];
  }
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";

  chars.forEach((char) => {
    if (char === "\n") {
      if (current) {
        lines.push(current);
        current = "";
      }
      return;
    }
    if (!current && /\s/.test(char)) {
      return;
    }
    const next = `${current}${char}`;
    if (TextMetrics.measureText(next, style).width <= maxWidth) {
      current = next;
      return;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (!/\s/.test(char)) {
      const charWidth = TextMetrics.measureText(char, style).width;
      if (charWidth <= maxWidth) {
        current = char;
      }
    }
  });

  if (current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    const trimmed = lines.slice(lines.length - maxLines);
    trimmed[0] = `...${trimmed[0]}`;
    return trimmed;
  }

  return lines;
};

const buildTileTexture = (type: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const drawRect = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  switch (type) {
    case "grass":
      drawRect("#a8d070", 0, 0, TILE, TILE);
      drawRect("#b7de7c", 0, 0, TILE, 4);
      drawRect("#8bb85f", 0, TILE - 12, TILE, 12);
      drawRect("#7aa44f", 0, TILE - 4, TILE, 4);
      drawRect("#96c86a", 8, 8, 8, 8);
      drawRect("#96c86a", 36, 24, 8, 8);
      break;
    case "path":
      drawRect("#d4c4a8", 0, 0, TILE, TILE);
      drawRect("#e4d7bf", 0, 0, TILE, 4);
      drawRect("#bfae94", 0, TILE - 10, TILE, 10);
      drawRect("#ac9b82", 0, TILE - 4, TILE, 4);
      drawRect("#c9b89e", 12, 12, 8, 8);
      drawRect("#c9b89e", 40, 28, 8, 8);
      break;
    case "wall_face":
      // Top Cap (Partition style) - Height 10
      drawRect("#4a4a5c", 0, 0, TILE, 20);
      drawRect("#5a5a6e", 0, 0, TILE, 4);
      drawRect("#3a3a4a", 0, 16, TILE, 4);

      // Wall Face - Middle
      drawRect("#6e6e82", 0, 20, TILE, TILE - 28);

      // Baseboard - Bottom 4
      drawRect("#4a4a5c", 0, TILE - 8, TILE, 8);
      break;
    case "partition_h":
    case "partition_h_top":
      // Thin horizontal partition strip
      if (type === "partition_h") {
        drawRect("#e8dcc8", 0, 0, TILE, TILE); // Floor Background for internal
      } else {
        // partition_h_top: Wall at top, Void below
        // Wall is 0..12. Void is 12..32
        drawRect("#121212", 0, 24, TILE, TILE - 24);
      }

      const phH = 24;
      const phY = type === "partition_h_top" ? 0 : (TILE - phH) / 2;

      drawRect("#4a4a5c", 0, phY, TILE, phH); // Dark base
      drawRect("#5a5a6e", 0, phY + 4, TILE, phH - 8); // Lighter top surface
      drawRect("#3a3a4a", 0, phY + phH - 4, TILE, 4); // Shadow on bottom
      break;
    case "partition_v":
    case "partition_v_left":
    case "partition_v_right":
      // Thin vertical partition strip
      const pvW = 24;
      let pvX = (TILE - pvW) / 2;
      if (type === "partition_v_left") pvX = 0;
      if (type === "partition_v_right") pvX = TILE - pvW;

      if (type === "partition_v") {
        drawRect("#e8dcc8", 0, 0, TILE, TILE); // Floor Background for internal
      } else if (type === "partition_v_left") {
        // Wall at Left (0..12). Void at Right (12..32)
        drawRect("#121212", 24, 0, TILE - 24, TILE);
      } else if (type === "partition_v_right") {
        // Wall at Right (20..32). Void at Left (0..20)
        drawRect("#121212", 0, 0, TILE - 24, TILE);
      }

      drawRect("#4a4a5c", pvX, 0, pvW, TILE); // Dark base
      drawRect("#5a5a6e", pvX + 4, 0, pvW - 8, TILE); // Lighter top surface
      drawRect("#3a3a4a", pvX + pvW - 4, 0, 4, TILE); // Shadow on right
      break;
    case "floor":
      drawRect("#e8dcc8", 0, 0, TILE, TILE);
      drawRect("#f3ead9", 0, 0, TILE, 4);
      drawRect("#d9ccb5", 0, TILE - 4, TILE, 4);
      drawRect("#c7b59f", 0, TILE - 2, TILE, 2);
      drawRect("#f0e6d6", 4, 4, 4, 4);
      drawRect("#f0e6d6", 36, 36, 4, 4);
      break;


    default:
      // Empty transparency for default
      ctx.clearRect(0, 0, TILE, TILE);
  }
  const texture = Texture.from(canvas);
  texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
  return texture;
};
const TitleBadge = ({ x, y, activeTab }: { x: number; y: number; activeTab?: "opencode" | "claude" }) => {
  const titleText = activeTab === "claude" ? "Claude 办公室" : "OpenCode 办公室";
  const titleStyle = useMemo(
    () =>
      new TextStyle({
        fill: 0xffffff,
        fontFamily: "Courier New",
        fontSize: 11,
        fontWeight: "bold",
        letterSpacing: 1,
      }),
    []
  );
  const textWidth = TextMetrics.measureText(titleText, titleStyle).width;
  const paddingX = 10;
  const paddingY = 5;
  const badgeWidth = textWidth + paddingX * 2;
  const badgeHeight = 18;

  return (
    <Container x={x} y={y}>
      <Graphics
        draw={(graphics: PixiGraphics) => {
          graphics.clear();
          graphics.beginFill(0x1a1a2e, 0.5);
          graphics.drawRoundedRect(2, 2, badgeWidth, badgeHeight, 4);
          graphics.endFill();
          graphics.beginFill(0x2d3a4f);
          graphics.drawRoundedRect(0, 0, badgeWidth, badgeHeight, 4);
          graphics.endFill();
          graphics.beginFill(0x3d4a5f);
          graphics.drawRoundedRect(0, 0, badgeWidth, 6, 4);
          graphics.endFill();
          graphics.lineStyle(1, 0x4a5a6f);
          graphics.drawRoundedRect(0, 0, badgeWidth, badgeHeight, 4);
          graphics.lineStyle(0);
          graphics.beginFill(0x6fb5ff);
          graphics.drawCircle(8, badgeHeight / 2, 2);
          graphics.endFill();
        }}
      />
      <Text
        text={titleText}
        x={paddingX + 4}
        y={paddingY - 1}
        style={titleStyle}
      />
    </Container>
  );
};

// SceneLayer now accepts dims props to handle logic that depends on map size
const SceneLayer = ({
  agents,
  interactions,
  sessions,
  activeSessionId,
  lastTodoSummary,
  selectedAgentId,
  onSelectAgent,
  activeTab,
  sceneWidth,
  sceneHeight,
  setDimensions,
}: PixiSceneProps & { sceneWidth: number; sceneHeight: number; setDimensions: (d: { width: number; height: number }) => void }) => {
  const [, setFrame] = useState(0);
  const timeRef = useRef(0);
  const spritesRef = useRef<Map<string, SpriteState>>(new Map());
  const agentCacheRef = useRef<Map<string, Agent>>(new Map());
  const [spriteSheets, setSpriteSheets] = useState<SpriteSheets>({});

  // Clear sprite state when switching tabs for a clean refresh
  useEffect(() => {
    spritesRef.current.clear();
    agentCacheRef.current.clear();
  }, [activeTab]);

  const [tileMap, setTileMap] = useState<string[][]>(() =>
    Array.from({ length: DEFAULT_MAP_ROWS }, () =>
      Array.from({ length: DEFAULT_MAP_COLS }, () => "")
    )
  );
  const tileMapRef = useRef<string[][]>(tileMap);
  useEffect(() => {
    tileMapRef.current = tileMap;
  }, [tileMap]);
  const doorStateRef = useRef<Map<string, DoorVisualState>>(new Map());
  const doorNodesSetRef = useRef<Set<string>>(new Set());
  const doorOpenSinceRef = useRef<Map<string, number>>(new Map());
  const doorDirtyRef = useRef<Set<string>>(new Set());
  const workNodesSetRef = useRef<Set<string>>(new Set());
  const roomSlackNodesRef = useRef<Record<RoomRegion, { row: number; col: number }[]>>({
    top_left: [],
    top_right: [],
    bottom_left: [],
    bottom_right: [],
  });
  const lastRenderAtRef = useRef(0);
  // Collision State
  const [collisionMap, setCollisionMap] = useState<CollisionMapData | null>(null);

  // Helper to check walkability
  const isWalkable = (col: number, row: number) => {
    if (!collisionMap) {
      return col >= 0 && row >= 0 && row < DEFAULT_MAP_ROWS && col < DEFAULT_MAP_COLS;
    }
    if (col < 0 || row < 0 || col >= collisionMap.cols || row >= collisionMap.rows) return false;
    // Walkable if state > 0. (1=Floor, 2=Work, 3=Rest, 4=Door)
    return collisionMap.grid[row][col] > 0;
  };

  const getRandomWalkable = (allowChairs: boolean) => {
    if (!collisionMap) return { row: 32, col: 32 };

    for (let i = 0; i < 80; i++) {
      const r = Math.floor(Math.random() * collisionMap.rows);
      const c = Math.floor(Math.random() * collisionMap.cols);
      const state = collisionMap.grid[r][c];
      if (state <= 0) continue;
      if (!allowChairs && state === 2) continue;
      return { row: r, col: c };
    }

    const rowOffset = Math.floor(Math.random() * collisionMap.rows);
    const colOffset = Math.floor(Math.random() * collisionMap.cols);
    for (let ri = 0; ri < collisionMap.rows; ri += 1) {
      const r = (ri + rowOffset) % collisionMap.rows;
      for (let ci = 0; ci < collisionMap.cols; ci += 1) {
        const c = (ci + colOffset) % collisionMap.cols;
        const state = collisionMap.grid[r][c];
        if (state <= 0) continue;
        if (!allowChairs && state === 2) continue;
        return { row: r, col: c };
      }
    }

    return { row: Math.floor(collisionMap.rows / 2), col: Math.floor(collisionMap.cols / 2) };
  };

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const map = await buildOfficeMap("/office_floor.png", TILE);
        if (disposed) {
          return;
        }
        setDimensions({ width: map.width, height: map.height });
        setTileMap(map.initialTileMap);
        tileMapRef.current = map.initialTileMap;
        doorNodesSetRef.current = map.doorNodeKeys;
        doorStateRef.current = map.doorStates;
        doorOpenSinceRef.current = new Map();
        setCollisionMap(map.collisionMap);
        roomSlackNodesRef.current = map.roomSlackNodes;
        workNodesSetRef.current = map.workNodeKeys;
        console.log("Generated Collision Map", {
          width: map.width,
          height: map.height,
          rows: map.collisionMap.rows,
          cols: map.collisionMap.cols,
        });
      } catch {
        if (!disposed) {
          setCollisionMap(null);
        }
      }
    };

    void load();

    return () => {
      disposed = true;
    };
  }, []); // Run once

  // ... (rest of component, replacing usage of globals with local helpers)

  const tileTextures = useMemo(() => {
    const types = [
      "floor",
    ];
    const textures: Record<string, Texture | null> = {};
    types.forEach((type) => {
      textures[type] = buildTileTexture(type);
    });
    // Dynamic Door Aliases
    textures["door_open"] = textures["floor"];
    textures["door_closed"] = null; // No visual, show background
    return textures;
  }, []);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const labelStyle = useMemo(
    () =>
      new TextStyle({
        fill: COLORS.text,
        fontFamily: "Courier New",
        fontSize: 10,
      }),
    []
  );
  const aliasStyle = useMemo(
    () =>
      new TextStyle({
        fill: 0xd0f5df,
        fontFamily: "Courier New",
        fontSize: 10,
      }),
    []
  );
  const statusStyle = useMemo(
    () =>
      new TextStyle({
        fill: 0x2b3f5c,
        fontFamily: "Courier New",
        fontSize: 10,
      }),
    []
  );
  const bubbleStyle = useMemo(
    () =>
      new TextStyle({
        fill: 0x3a5b3c,
        fontFamily: "Courier New",
        fontSize: 9,
      }),
    []
  );
  const activityStyle = useMemo(
    () =>
      new TextStyle({
        fill: 0x2b3f5c,
        fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji",
        fontSize: 12,
      }),
    []
  );

  useEffect(() => {
    const loadSheet = (url: string, columns: number) =>
      new Promise<DirectionFrames>((resolve, reject) => {
        const base = BaseTexture.from(url);
        base.scaleMode = SCALE_MODES.NEAREST;
        const build = () => {
          const frameWidth = Math.floor(base.width / columns);
          const frameHeight = Math.floor(base.height / 3);
          const buildRow = (row: number) => {
            const frames = [] as Texture[];
            for (let col = 0; col < columns; col += 1) {
              frames.push(
                new Texture(
                  base,
                  new Rectangle(col * frameWidth, row * frameHeight, frameWidth, frameHeight)
                )
              );
            }
            return frames;
          };
          resolve({
            right: buildRow(0),
            down: buildRow(1),
            up: buildRow(2),
          });
        };
        if (base.valid) {
          build();
        } else {
          base.once("loaded", build);
          base.once("error", reject);
        }
      });

    const loadAll = async () => {
      try {
        const [idle, walk, run, jump] = await Promise.all([
          loadSheet("/idle.png", 4),
          loadSheet("/walk.png", 8),
          loadSheet("/run.png", 8),
          loadSheet("/jump.png", 6),
        ]);
        setSpriteSheets({ idle, walk, run, jump });

      } catch {
        setSpriteSheets({});
      }
    };
    loadAll();
  }, []);

  useEffect(() => {
    const spriteMap = spritesRef.current;
    const agentCache = agentCacheRef.current;
    const now = Date.now();
    const ids = new Set(agents.map((agent) => agent.id));
    const exitNode = collisionMap
      ? pickMainExitNode(collisionMap.exitNodes, doorTile())
      : doorTile();
    agents.forEach((agent) => {
      agentCache.set(agent.id, agent);
    });
    for (const id of spriteMap.keys()) {
      if (!ids.has(id)) {
        const existing = spriteMap.get(id);
        if (existing && !existing.exiting) {
          const targetTile = collisionMap
            ? pickExitTarget(
                pixelToTile(existing.x, existing.y),
                collisionMap.exitNodes.length > 0 ? collisionMap.exitNodes : [exitNode],
                collisionMap.grid
              )
            : exitNode;
          const baseTarget = tileToPixel(targetTile);
          const exitTarget = { x: baseTarget.x + EXIT_OFFSET_X, y: baseTarget.y + EXIT_OFFSET_Y };
          const farewellAt = now + PRE_EXIT_FAREWELL_MS;
          const farewellText = FAREWELL_TEXTS[hashId(id) % FAREWELL_TEXTS.length];
          spriteMap.set(id, {
            ...existing,
            exiting: true,
            exitAt: now,
            preFarewellUntil: farewellAt,
            farewellText,
            goodbyeUntil: undefined,
            removeAt: undefined,
            targetX: exitTarget.x,
            targetY: exitTarget.y,
            targetKind: "exit",
            targetTile: targetTile,
            path: collisionMap
              ? computePath(collisionMap.grid, pixelToTile(existing.x, existing.y), targetTile, true)
              : [],
            pathIndex: 1,
            direction: "front",
          });
        }
      }
    }
    agents.forEach((agent) => {
      if (spriteMap.has(agent.id)) {
        return;
      }
      const fallbackTile = { row: 32, col: 32 };
      const homeTile = collisionMap?.workCenters?.length
        ? pickNode(agent.id, collisionMap.workCenters, fallbackTile)
        : collisionMap?.workNodes?.length
          ? pickNode(agent.id, collisionMap.workNodes, fallbackTile)
          : fallbackTile;
      const position = tileToPixel(homeTile);
      spriteMap.set(agent.id, {
        x: position.x,
        y: position.y,
        targetX: position.x,
        targetY: position.y,
        homeTile: { row: homeTile.row, col: homeTile.col },
        direction: "front",
        lastMoveAt: now,
        lastPosX: position.x,
        lastPosY: position.y,
      });
    });
  }, [agents, collisionMap]); // Re-run when collision map loads

  useTick((delta: number) => {
    runAgentSimulation({
      delta,
      agents,
      collisionMap,
      spritesRef,
      agentCacheRef,
      timeRef,
      doorNodesSetRef,
      doorStateRef,
      doorOpenSinceRef,
      doorDirtyRef,
      lastRenderAtRef,
      tileMapRef,
      getRandomWalkable,
      isWalkable,
      tileToPixel,
      pixelToTile,
      doorTile,
      setTileMap,
      triggerFrame: () => setFrame((current) => current + 1),
      idleDeskGraceMs: IDLE_DESK_GRACE_MS,
      goodbyeTtlMs: GOODBYE_TTL_MS,
      exitTtlMs: EXIT_TTL_MS,
      frameBudgetMs: 1000 / 24,
      exitOffsetX: EXIT_OFFSET_X,
      exitOffsetY: EXIT_OFFSET_Y,
      farewellTexts: FAREWELL_TEXTS,
    });
  });

  const time = timeRef.current;
  const renderNow = Date.now();
  const activeStatus = activeSession?.status ? activeSession.status.toLowerCase() : "";
  const statusUpdatedAt = activeSession?.updatedAt || 0;
  const showStatusPulse = statusUpdatedAt && time - statusUpdatedAt < EVENT_TTL_MS;
  const statusLampColor =
    activeStatus === "busy" || activeStatus === "working"
      ? 0xf2b74e
      : activeStatus === "idle"
        ? 0x6bd59b
        : activeStatus === "error"
          ? 0xf06a6a
          : 0x7aa0d8;
  const showTodoPulse =
    lastTodoSummary?.updatedAt && time - lastTodoSummary.updatedAt < EVENT_TTL_MS;
  const todoTargetId = activeSessionId
    ? agents.find((agent) => agent.sessionId === activeSessionId)?.id
    : undefined;
  const renderList: RenderableItem[] = [];
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  for (const [id, sprite] of spritesRef.current.entries()) {
    if (sprite && (agentMap.has(id) || sprite.exiting)) {
      renderList.push({ type: "agent", id, y: sprite.y });
    }
  }
  renderList.sort((a, b) => a.y - b.y);

  return (
    <>
      <Container>
        <Sprite texture={Texture.from("/office.png")} x={0} y={0} />
      </Container>
      <TileMap map={tileMap} textures={tileTextures} />
      <TitleBadge x={8} y={8} activeTab={activeTab} />
      <Graphics
        draw={(graphics: PixiGraphics) => {
          graphics.clear();
          if (activeSession && activeStatus) {
            const lampX = sceneWidth - 26;
            const lampY = 10;
            graphics.lineStyle(2, 0x4a5f66, 1);
            graphics.beginFill(statusLampColor, showStatusPulse ? 1 : 0.6);
            graphics.drawRoundedRect(lampX, lampY, 10, 10, 3);
            graphics.endFill();
            if (showStatusPulse) {
              graphics.lineStyle(2, statusLampColor, 0.5);
              graphics.drawRoundedRect(lampX - 3, lampY - 3, 16, 16, 4);
            }
            graphics.lineStyle(0, 0, 0);
          }
        }}
      />
      <Graphics
        draw={(graphics: PixiGraphics) => {
          graphics.clear();
          interactions.forEach((interaction) => {
            const fromSprite = spritesRef.current.get(interaction.from);
            const toSprite = spritesRef.current.get(interaction.to);
            if (!fromSprite || !toSprite) {
              return;
            }
            graphics.lineStyle(2, COLORS.link, 1);
            graphics.moveTo(fromSprite.x, fromSprite.y - 8);
            graphics.lineTo(toSprite.x, toSprite.y - 8);
            graphics.lineStyle(0, 0, 0);
          });
        }}
      />
      {
        renderList.map((item) => {
          if (item.type !== "agent") return null;
          const agent = agentMap.get(item.id) || agentCacheRef.current.get(item.id);
          if (!agent) return null;
          const sprite = spritesRef.current.get(agent.id);
          if (!sprite) return null;
          const isLiveAgent = agentMap.has(agent.id);

          const x = sprite.x - 8;
          const y = sprite.y - 12;
          const motion = 0;
          const direction = sprite.direction || "front";
          const movement = Math.hypot(sprite.targetX - sprite.x, sprite.targetY - sprite.y);
          const recentlyMoved = Boolean(
            sprite.lastMoveAt && renderNow - sprite.lastMoveAt < 220
          );
          const isRunning = recentlyMoved && movement > 0.8;
          const isWalking = recentlyMoved && movement > 0.2;
          const currentTile = pixelToTile(sprite.x, sprite.y);
          const isOnWorkChair = workNodesSetRef.current.has(
            nodeKey(currentTile.row, currentTile.col)
          );
          const shouldJump = agent.status === "thinking" && isOnWorkChair;
          const state = shouldJump ? "jump" : isRunning ? "run" : isWalking ? "walk" : "idle";
          const sheet = spriteSheets[state] || spriteSheets.idle;
          const frameCount = sheet?.right.length || 1;
          const frameSpeed = isRunning ? 90 : isWalking ? 120 : 200;
          const frameIndex = Math.floor(time / frameSpeed) % frameCount;
          const frameSet = sheet
            ? direction === "back"
              ? sheet.up
              : direction === "front"
                ? sheet.down
                : sheet.right
            : null;
          const texture = frameSet ? frameSet[frameIndex] : null;
          const flipX = direction === "left" ? -1 : 1;
          const aliasLabel = (agent.alias || agent.name || agent.id || "Agent")
            .slice(0, 10)
            .toUpperCase();
          const [tagFill, tagStroke] = pickTagColors(agent.sessionId);
          const messageEventAt =
            agent.lastEventType?.startsWith("message.") ? agent.lastEventAt || 0 : 0;
          const messageTimestamp = agent.lastMessageAt || messageEventAt || 0;
          const isMessageFresh =
            messageTimestamp && renderNow - messageTimestamp < MESSAGE_TTL_MS;
          const isStreaming =
            agent.lastStreamingAt &&
            renderNow - agent.lastStreamingAt < TYPING_TTL_MS;
          const statusText = statusBubbleText(agent.status || "working");
          const snippet = agent.lastMessageSnippet || "";
          const showCustomBubble = Boolean(
            sprite.bubbleText && sprite.bubbleUntil && renderNow < sprite.bubbleUntil
          );
          const customBubbleText = sprite.bubbleText || "";
          const showGoodbye = Boolean(
            (sprite.preFarewellUntil && renderNow < sprite.preFarewellUntil) ||
            (sprite.goodbyeUntil && renderNow < sprite.goodbyeUntil)
          );
          const goodbyeText = sprite.farewellText || "再见";
          const messageText = showCustomBubble
            ? customBubbleText
            : showGoodbye
              ? goodbyeText
              : isStreaming
                ? ".".repeat(Math.max(1, Math.floor(time / 250) % 4))
                : snippet;
          const hasRecentEdit =
            agent.lastFileEditAt && renderNow - agent.lastFileEditAt < ACTIVITY_TTL_MS;
          const eventType = agent.lastEventType || "";
          const lastEventAt = agent.lastEventAt || agent.lastActivityAt || 0;
          const hasRecentEvent = lastEventAt && renderNow - lastEventAt < EVENT_TTL_MS;
          const isMessageUpdateEvent =
            eventType === "message.updated" || eventType === "message.part.updated";
          const isSessionEvent = eventType.startsWith("session.");
          const isToolEvent =
            hasRecentEvent &&
            (eventType === "tool.execute.before" || eventType === "tool.execute.after");
          const toolRingColor = eventType === "tool.execute.before" ? 0xf2b74e : 0x7aa0d8;
          const eventBadgeColor = EVENT_BADGE_COLORS[eventType];
          const showEventBadge =
            hasRecentEvent &&
            !isToolEvent &&
            !hasRecentEdit &&
            !isMessageUpdateEvent &&
            !isSessionEvent &&
            eventBadgeColor !== undefined;
          const isPermissionEvent = hasRecentEvent && eventType === "permission.asked";
          const isWaitingForInput = hasRecentEvent && eventType === "tui.toast.show";
          const activityEmoji =
            isPermissionEvent
              ? "❓"
              : isWaitingForInput
                ? "⏳"
                : hasRecentEdit
                  ? "✏️"
                  : agent.status === "thinking"
                    ? "💭"
                    : agent.status === "working"
                      ? "🛠️"
                      : "";
          const showActivity = Boolean(activityEmoji);
          const messageLines = wrapLines(
            messageText,
            MESSAGE_MAX_WIDTH,
            bubbleStyle,
            MESSAGE_MAX_LINES
          );
          const messageLineWidths = messageLines.map(
            (line) => TextMetrics.measureText(line, bubbleStyle).width
          );
          const messageContentWidth = messageLineWidths.length
            ? Math.max(...messageLineWidths)
            : 0;
          const messageBubbleWidth =
            Math.max(MESSAGE_MIN_WIDTH, Math.min(messageContentWidth, MESSAGE_MAX_WIDTH)) +
            MESSAGE_PADDING * 2;
          const lineHeight = (Number(bubbleStyle.fontSize) || 9) + 2;
          const messageHeight = messageLines.length * lineHeight + MESSAGE_PADDING * 2;
          const messageBubbleX = sprite.x - messageBubbleWidth / 2;
          const messageBubbleY = y - 56 + motion - (messageLines.length - 1) * 6;
          const messageTextX = messageBubbleX + MESSAGE_PADDING;
          const messageTextY = messageBubbleY + MESSAGE_PADDING;
          const labelPaddingX = 4;
          const chipHeight = 12;
          const chipGap = 4;
          const labelY = y + 34 + motion;
          const activityBubbleSize = 18;
          const activityBubbleX = sprite.x - activityBubbleSize / 2;
          const messageBubble: MessageBubbleData = {
            show: Boolean(showCustomBubble || showGoodbye || (agent.lastMessageSnippet && isMessageFresh)),
            x: messageBubbleX,
            y: messageBubbleY,
            width: messageBubbleWidth,
            height: messageHeight,
            textX: messageTextX,
            textY: messageTextY,
            lines: messageLines,
          };
          const statusY = messageBubble.show
            ? messageBubbleY + messageHeight + 4
            : y - 28 + motion;
          const activityBubbleY = statusY;
          const activityBubble: ActivityBubbleData = {
            show: showActivity,
            x: activityBubbleX,
            y: activityBubbleY,
            size: activityBubbleSize,
            emoji: activityEmoji,
            textX: activityBubbleX + 3,
            textY: activityBubbleY + 1,
          };

          return (
            <Container
              key={agent.id}
              eventMode={isLiveAgent ? "static" : "none"}
              cursor={isLiveAgent ? "pointer" : undefined}
              onpointerdown={isLiveAgent ? () => onSelectAgent(agent.id) : undefined}
            >
              <Graphics
                draw={(graphics: PixiGraphics) => {
                  graphics.clear();
                  graphics.beginFill(COLORS.shadow);
                  graphics.drawRect(x + 2, y + 18 + motion, 12, 4);
                  graphics.endFill();

                  if (!texture) {
                    const bodyColor = pickAvatarColor(agent);
                    graphics.beginFill(bodyColor);
                    // 32x32 Character Size (User requested 32x32)
                    graphics.drawRect(x - 8, y + motion - 8, 32, 28);
                    graphics.drawRect(x - 4, y - 20 + motion, 24, 16); // Head
                    graphics.endFill();
                    graphics.beginFill(0x13131a);
                    // Eyes
                    if (direction === "front") {
                      graphics.drawRect(x + 4, y - 12 + motion, 4, 4);
                      graphics.drawRect(x + 16, y - 12 + motion, 4, 4);
                    } else if (direction === "right") {
                      graphics.drawRect(x + 16, y - 12 + motion, 4, 4);
                    } else if (direction === "left") {
                      graphics.drawRect(x + 4, y - 12 + motion, 4, 4);
                    }
                    graphics.endFill();
                  }

                  if (isToolEvent) {
                    // Small notification square at top-right of agent
                    const notifSize = 6;
                    const notifX = sprite.x + 12;
                    const notifY = y - 24 + motion;
                    graphics.beginFill(toolRingColor, 0.95);
                    graphics.lineStyle(1, 0xffffff, 0.8);
                    graphics.drawRoundedRect(notifX, notifY, notifSize, notifSize, 1);
                    graphics.endFill();
                    graphics.lineStyle(0, 0, 0);
                  }

                  if (showEventBadge) {
                    const badgeSize = 8;
                    const badgeX = sprite.x + 10;
                    const badgeY = y - 26 + motion;
                    drawRoundedRect(
                      graphics,
                      badgeX,
                      badgeY,
                      badgeSize,
                      badgeSize,
                      2,
                      0xf1f3ff,
                      eventBadgeColor,
                      1
                    );
                  }

                  const aliasWidth =
                    TextMetrics.measureText(aliasLabel, labelStyle).width +
                    labelPaddingX * 2;
                  const aliasX = sprite.x - aliasWidth / 2; // Centered on sprite (which is center of tile)

                  drawRoundedRect(
                    graphics,
                    aliasX,
                    labelY - 10,
                    aliasWidth,
                    chipHeight,
                    6,
                    tagFill,
                    tagStroke
                  );

                  if (showTodoPulse && agent.id === todoTargetId) {
                    const badgeX = aliasX + aliasWidth + 6;
                    const badgeY = labelY - 12;
                    const badgeOuterSize = 10;
                    const badgeInnerSize = 4;
                    graphics.beginFill(0xf7f0d4);
                    graphics.lineStyle(2, 0x4a5f66, 1);
                    graphics.drawRoundedRect(badgeX, badgeY + 4, badgeOuterSize, badgeOuterSize, 2);
                    graphics.endFill();
                    graphics.beginFill(0x4a5f66);
                    graphics.drawRect(badgeX + 3, badgeY + 7, badgeInnerSize, badgeInnerSize);
                    graphics.endFill();
                    graphics.lineStyle(0, 0, 0);
                  }

                  if (messageBubble.show) {
                    drawRoundedRect(
                      graphics,
                      messageBubble.x,
                      messageBubble.y,
                      messageBubble.width,
                      messageBubble.height,
                      4,
                      0xf1fff3,
                      0x3a5b3c,
                      1.5
                    );
                  }

                  if (activityBubble.show) {
                    drawRoundedRect(
                      graphics,
                      activityBubble.x,
                      activityBubble.y,
                      activityBubble.size,
                      activityBubble.size,
                      6,
                      0xf1f3ff,
                      0x5a6aa0,
                      1
                    );
                  }
                }}
              />
              {texture && (
                <Sprite
                  texture={texture}
                  anchor={0.5}
                  x={sprite.x}
                  y={sprite.y + motion}
                  scale={{ x: flipX * 2, y: 2 }}
                />
              )}
              <Text
                text={aliasLabel}
                anchor={0.5}
                x={x + 8}
                y={y + 30 + motion}
                style={aliasStyle}
              />
              <MessageBubble bubble={messageBubble} style={bubbleStyle} />
              <ActivityBubble bubble={activityBubble} style={activityStyle} />
            </Container>
          );
        })
      }
    </>
  );
};

export const PixiScene = (props: PixiSceneProps) => {
  const [dimensions, setDimensions] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

  return (
    <Stage
      width={dimensions.width}
      height={dimensions.height}
      style={{ display: "block" }}
      options={{
        antialias: false,
        backgroundColor: 0x101615,
        preserveDrawingBuffer: true,
      }}
    >
      <SceneLayer
        {...props}
        sceneWidth={dimensions.width}
        sceneHeight={dimensions.height}
        setDimensions={setDimensions}
      />
    </Stage>
  );
};
