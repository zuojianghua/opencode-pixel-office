import { findPath } from "./pathfinding";

export type RoomRegion = "top_left" | "top_right" | "bottom_left" | "bottom_right";
export type DoorVisualState = "door_open" | "door_closed";

export type SpriteState = {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  homeTile: { row: number; col: number };
  targetTile?: { row: number; col: number };
  path?: { row: number; col: number }[];
  pathIndex?: number;
  targetKind?: "work" | "wander" | "exit";
  retargetAt?: number;
  dirLockUntil?: number;
  wanderUntil?: number;
  idlePauseUntil?: number;
  deskGraceUntil?: number;
  lastStatus?: string;
  workLockUntil?: number;
  lastMoveAt?: number;
  lastWanderRegion?: RoomRegion;
  lastPosX?: number;
  lastPosY?: number;
  direction: "front" | "back" | "left" | "right";
  exiting?: boolean;
  exitAt?: number;
  preFarewellUntil?: number;
  farewellText?: string;
  goodbyeUntil?: number;
  removeAt?: number;
  bubbleText?: string;
  bubbleUntil?: number;
};

export type CollisionMapData = {
  rows: number;
  cols: number;
  grid: number[][];
  workNodes: { row: number; col: number }[];
  workCenters: { row: number; col: number }[];
  doorNodes: { row: number; col: number }[];
  exitNodes: { row: number; col: number }[];
  transitNodes: { row: number; col: number }[];
  slackNodes: { row: number; col: number }[];
};

export const nodeKey = (row: number, col: number) => `${row},${col}`;

export const hashId = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 997;
  }
  return hash;
};

export const pickNode = (
  id: string,
  nodes: { row: number; col: number }[],
  fallback: { row: number; col: number }
) => {
  if (!nodes || nodes.length === 0) {
    return fallback;
  }
  return nodes[hashId(id) % nodes.length];
};

export const getRoomRegion = (
  tile: { row: number; col: number },
  rows: number,
  cols: number
): RoomRegion => {
  const top = tile.row < rows / 2;
  const left = tile.col < cols / 2;
  if (top && left) return "top_left";
  if (top && !left) return "top_right";
  if (!top && left) return "bottom_left";
  return "bottom_right";
};

export const simplifyPath = (path: { row: number; col: number }[]) => {
  if (path.length <= 2) {
    return path;
  }
  const result: { row: number; col: number }[] = [path[0]];
  let prevDir = {
    row: path[1].row - path[0].row,
    col: path[1].col - path[0].col,
  };
  for (let i = 1; i < path.length - 1; i += 1) {
    const current = path[i];
    const next = path[i + 1];
    const dir = { row: next.row - current.row, col: next.col - current.col };
    if (dir.row !== prevDir.row || dir.col !== prevDir.col) {
      result.push(current);
      prevDir = dir;
    }
  }
  result.push(path[path.length - 1]);
  return result;
};

export const statusSpeed = (status: string) => {
  switch (status) {
    case "idle":
      return 0.35;
    case "thinking":
      return 0.55;
    case "planning":
      return 0.5;
    case "error":
      return 0.35;
    case "working":
    default:
      return 0.7;
  }
};

export const shouldBeAtDesk = (status: string) => {
  const normalized = (status || "").toLowerCase();
  return normalized !== "idle" && normalized !== "";
};

export const pickMainExitNode = (
  exitNodes: { row: number; col: number }[],
  fallback: { row: number; col: number }
) => {
  const base = exitNodes.length > 0 ? exitNodes : fallback ? [fallback] : [];
  if (!base.length) {
    return fallback;
  }
  return base.reduce((best, current) => {
    if (current.row > best.row) return current;
    if (current.row === best.row && current.col < best.col) return current;
    return best;
  }, base[0]);
};

export const pickExitTarget = (
  current: { row: number; col: number },
  exitNodes: { row: number; col: number }[],
  grid: number[][]
) => {
  const inBounds = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < grid.length && col < grid[0].length;
  const isWalkable = (row: number, col: number) => grid[row][col] > 0;

  let bestDirect: { row: number; col: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  exitNodes.forEach((node) => {
    if (!isWalkable(node.row, node.col)) {
      return;
    }
    const dist = Math.abs(node.row - current.row) + Math.abs(node.col - current.col);
    if (dist < bestDist) {
      bestDist = dist;
      bestDirect = node;
    }
  });
  if (bestDirect) {
    return bestDirect;
  }

  let best = exitNodes[0] || current;
  let bestDoorDist = Number.POSITIVE_INFINITY;
  let bestCurrentDist = Number.POSITIVE_INFINITY;

  exitNodes.forEach((node) => {
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const row = node.row + dr;
        const col = node.col + dc;
        if (!inBounds(row, col)) continue;
        if (!isWalkable(row, col)) continue;
        const doorDist = Math.abs(row - node.row) + Math.abs(col - node.col);
        const currentDist = Math.abs(row - current.row) + Math.abs(col - current.col);
        if (
          doorDist < bestDoorDist ||
          (doorDist === bestDoorDist && currentDist < bestCurrentDist)
        ) {
          bestDoorDist = doorDist;
          bestCurrentDist = currentDist;
          best = { row, col };
        }
      }
    }
  });

  return best;
};

export const pickIdleSlackTarget = ({
  currentTile,
  getRandomWalkable,
}: {
  currentTile: { row: number; col: number };
  getRandomWalkable: (allowChairs: boolean) => { row: number; col: number };
}) => {
  const MIN_RANDOM_WANDER_DISTANCE = 60;
  const distanceTo = (node: { row: number; col: number }) =>
    Math.abs(node.row - currentTile.row) + Math.abs(node.col - currentTile.col);
  let fallback = getRandomWalkable(false);
  let fallbackDist = distanceTo(fallback);
  for (let i = 0; i < 18; i += 1) {
    const candidate = getRandomWalkable(false);
    const dist = distanceTo(candidate);
    if (dist >= MIN_RANDOM_WANDER_DISTANCE) {
      return candidate;
    }
    if (dist > fallbackDist) {
      fallback = candidate;
      fallbackDist = dist;
    }
  }
  return fallback;
};

export const computePath = (
  grid: number[][],
  start: { row: number; col: number },
  end: { row: number; col: number },
  simplify: boolean
) => {
  const raw = findPath(grid, start, end);
  if (!simplify) {
    return raw;
  }
  return simplifyPath(raw);
};
