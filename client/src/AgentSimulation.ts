import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Agent } from "./useOfficeState";
import {
  computePath,
  getRoomRegion,
  hashId,
  nodeKey,
  pickExitTarget,
  pickIdleSlackTarget,
  pickMainExitNode,
  shouldBeAtDesk,
  statusSpeed,
} from "./Agent";
import type {
  CollisionMapData,
  DoorVisualState,
  SpriteState,
} from "./Agent";

type Tile = { row: number; col: number };

type RunAgentSimulationArgs = {
  delta: number;
  agents: Agent[];
  collisionMap: CollisionMapData | null;
  spritesRef: MutableRefObject<Map<string, SpriteState>>;
  agentCacheRef: MutableRefObject<Map<string, Agent>>;
  timeRef: MutableRefObject<number>;
  doorNodesSetRef: MutableRefObject<Set<string>>;
  doorStateRef: MutableRefObject<Map<string, DoorVisualState>>;
  doorOpenSinceRef: MutableRefObject<Map<string, number>>;
  doorDirtyRef: MutableRefObject<Set<string>>;
  lastRenderAtRef: MutableRefObject<number>;
  tileMapRef: MutableRefObject<string[][]>;
  getRandomWalkable: (allowChairs: boolean) => Tile;
  isWalkable: (col: number, row: number) => boolean;
  tileToPixel: (tile: { row: number; col: number }) => { x: number; y: number };
  pixelToTile: (x: number, y: number) => { row: number; col: number };
  doorTile: () => Tile;
  setTileMap: Dispatch<SetStateAction<string[][]>>;
  triggerFrame: () => void;
  idleDeskGraceMs: number;
  goodbyeTtlMs: number;
  exitTtlMs: number;
  frameBudgetMs: number;
  exitOffsetX: number;
  exitOffsetY: number;
  farewellTexts: string[];
};

export const runAgentSimulation = ({
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
  triggerFrame,
  idleDeskGraceMs,
  goodbyeTtlMs,
  exitTtlMs,
  frameBudgetMs,
  exitOffsetX,
  exitOffsetY,
  farewellTexts,
}: RunAgentSimulationArgs) => {
  timeRef.current += delta * 16;
  const tickNow = Date.now();
  const spriteMap = spritesRef.current;
  const agentCache = agentCacheRef.current;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const occupiedTiles = new Map<string, string>();
  const reservedIdleTargets = new Set<string>();
  const doorClusters = new Map<string, string[]>();

  if (doorNodesSetRef.current.size > 0) {
    const remaining = new Set(doorNodesSetRef.current);
    const offsets = [
      { row: 1, col: 0 },
      { row: -1, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: -1 },
    ];

    while (remaining.size > 0) {
      const start = remaining.values().next().value;
      if (!start) {
        break;
      }
      remaining.delete(start);
      const cluster: string[] = [start];
      const stack = [start];

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          continue;
        }
        const [row, col] = current.split(",").map(Number);
        if (Number.isNaN(row) || Number.isNaN(col)) {
          continue;
        }

        offsets.forEach((offset) => {
          const neighborKey = nodeKey(row + offset.row, col + offset.col);
          if (!remaining.has(neighborKey)) {
            return;
          }
          remaining.delete(neighborKey);
          cluster.push(neighborKey);
          stack.push(neighborKey);
        });
      }

      cluster.forEach((key) => {
        doorClusters.set(key, cluster);
      });
    }
  }

  const openDoorCluster = (doorKey: string, openAt: number) => {
    const cluster = doorClusters.get(doorKey) || [doorKey];
    cluster.forEach((key) => {
      if (doorStateRef.current.get(key) !== "door_open") {
        doorStateRef.current.set(key, "door_open");
        doorDirtyRef.current.add(key);
      }
      doorOpenSinceRef.current.set(key, openAt);
    });
  };

  agents.forEach((agent) => {
    const sprite = spriteMap.get(agent.id);
    if (!sprite || sprite.exiting) {
      return;
    }
    const tile = pixelToTile(sprite.x, sprite.y);
    occupiedTiles.set(nodeKey(tile.row, tile.col), agent.id);
  });

  agents.forEach((agent) => {
    const sprite = spriteMap.get(agent.id);
    if (!sprite) {
      return;
    }
    const now = tickNow;
    const normalizedStatus = (agent.status || "working").toLowerCase();
    const previousStatus = sprite.lastStatus || normalizedStatus;

    if (normalizedStatus !== "idle") {
      sprite.deskGraceUntil = undefined;
    } else if (previousStatus !== "idle" || !sprite.deskGraceUntil) {
      sprite.deskGraceUntil = now + idleDeskGraceMs + Math.floor(Math.random() * 2000);
    }
    sprite.lastStatus = normalizedStatus;
    const inDeskGrace =
      normalizedStatus === "idle" &&
      Boolean(sprite.deskGraceUntil && now < sprite.deskGraceUntil);
    const isIdleWander = normalizedStatus === "idle" && !inDeskGrace;

    const currentTile = pixelToTile(sprite.x, sprite.y);
    const isWorking = shouldBeAtDesk(normalizedStatus) || inDeskGrace;
    const isOccupied = (tile: Tile) => {
      const occupant = occupiedTiles.get(nodeKey(tile.row, tile.col));
      return Boolean(occupant && occupant !== agent.id);
    };
    let workTarget = sprite.homeTile;
    const workCandidates = collisionMap?.workCenters?.length
      ? collisionMap.workCenters
      : collisionMap?.workNodes || [];
    if (workCandidates.length) {
      let best: Tile | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      let bestAny: Tile | null = null;
      let bestAnyDist = Number.POSITIVE_INFINITY;
      workCandidates.forEach((node) => {
        const dist = Math.abs(node.row - currentTile.row) + Math.abs(node.col - currentTile.col);
        if (dist < bestAnyDist) {
          bestAny = node;
          bestAnyDist = dist;
        }
        if (!isOccupied(node) && dist < bestDist) {
          best = node;
          bestDist = dist;
        }
      });
      workTarget = best || bestAny || sprite.homeTile;
    }

    const idlePauseActive =
      isIdleWander && Boolean(sprite.idlePauseUntil && now < sprite.idlePauseUntil);
    if (isIdleWander && sprite.idlePauseUntil && now >= sprite.idlePauseUntil) {
      sprite.idlePauseUntil = undefined;
    } else if (!isIdleWander) {
      sprite.idlePauseUntil = undefined;
    }

    const desiredKind: "work" | "wander" = isWorking ? "work" : "wander";
    let desiredTile = workTarget;
    if (!isWorking) {
      if (idlePauseActive) {
        desiredTile = currentTile;
      } else if (sprite.targetTile && sprite.targetKind === "wander") {
        desiredTile = sprite.targetTile;
      } else {
        desiredTile = pickIdleSlackTarget({
          currentTile,
          getRandomWalkable,
        });
        if (isIdleWander) {
          reservedIdleTargets.add(nodeKey(desiredTile.row, desiredTile.col));
          sprite.bubbleText = "指挥官没有分配新任务，我要去摸鱼";
          sprite.bubbleUntil = now + 1800;
        }
      }
    }

    const plannedDistance = Math.hypot(sprite.targetX - sprite.x, sprite.targetY - sprite.y);
    const reachedTarget = plannedDistance < 0.6;

    const workLocked = sprite.workLockUntil && now < sprite.workLockUntil;
    const retargetDue = sprite.retargetAt !== undefined && now >= sprite.retargetAt;
    const needsNewTarget =
      !idlePauseActive &&
      (!sprite.targetTile ||
        (sprite.targetKind !== desiredKind && (!workLocked || desiredKind === "wander")) ||
        (isWorking && reachedTarget) ||
        retargetDue);

    if (collisionMap && needsNewTarget) {
      sprite.retargetAt = undefined;
      sprite.targetKind = desiredKind;
      sprite.targetTile = desiredTile;
      if (desiredKind === "wander") {
        sprite.lastWanderRegion = getRoomRegion(desiredTile, collisionMap.rows, collisionMap.cols);
      }
      const rawPath = computePath(collisionMap.grid, currentTile, desiredTile, false);
      if (rawPath.length === 0 && desiredKind === "work") {
        const chairPos = tileToPixel(desiredTile);
        sprite.x = chairPos.x;
        sprite.y = chairPos.y;
        sprite.targetX = chairPos.x;
        sprite.targetY = chairPos.y;
        sprite.path = [];
        sprite.pathIndex = undefined;
        sprite.lastMoveAt = now;
      } else if (
        rawPath.length === 0 &&
        (desiredTile.row !== currentTile.row || desiredTile.col !== currentTile.col)
      ) {
        if (desiredKind === "wander") {
          let fallbackTarget = getRandomWalkable(false);
          let bestFallbackDist =
            Math.abs(fallbackTarget.row - currentTile.row) +
            Math.abs(fallbackTarget.col - currentTile.col);
          for (let i = 0; i < 10; i += 1) {
            const candidate = getRandomWalkable(false);
            const dist = Math.abs(candidate.row - currentTile.row) + Math.abs(candidate.col - currentTile.col);
            if (dist > bestFallbackDist) {
              bestFallbackDist = dist;
              fallbackTarget = candidate;
            }
          }

          const fallbackPath = computePath(collisionMap.grid, currentTile, fallbackTarget, false);
          if (fallbackPath.length > 0) {
            sprite.targetTile = fallbackTarget;
            sprite.path = fallbackPath;
            sprite.pathIndex = fallbackPath.length > 1 ? 1 : 0;
            sprite.retargetAt = now + 1400;
          } else {
            sprite.path = [];
            sprite.pathIndex = undefined;
            sprite.targetTile = undefined;
            sprite.targetKind = undefined;
            sprite.retargetAt = now + 700 + Math.floor(Math.random() * 500);
          }
        } else {
          sprite.path = [];
          sprite.pathIndex = undefined;
          sprite.targetTile = undefined;
          sprite.targetKind = undefined;
          sprite.retargetAt = now + 700 + Math.floor(Math.random() * 500);
        }
      } else {
        sprite.path = rawPath;
        sprite.pathIndex = rawPath.length > 1 ? 1 : 0;
        sprite.retargetAt = now + 1400;
        if (isWorking) {
          sprite.workLockUntil = now + 2200;
        }
      }
    }

    if (sprite.path && sprite.path.length > 0 && sprite.pathIndex !== undefined) {
      const nextIndex = Math.min(sprite.pathIndex, sprite.path.length - 1);
      const nextNode = sprite.path[nextIndex];
      const px = tileToPixel(nextNode);
      const toWaypoint = Math.hypot(px.x - sprite.x, px.y - sprite.y);
      if (toWaypoint <= 0.45) {
        sprite.x = px.x;
        sprite.y = px.y;
        if (sprite.pathIndex < sprite.path.length - 1) {
          sprite.pathIndex += 1;
          const followNode = sprite.path[Math.min(sprite.pathIndex, sprite.path.length - 1)];
          const followPx = tileToPixel(followNode);
          sprite.targetX = followPx.x;
          sprite.targetY = followPx.y;
        } else {
          sprite.path = [];
          sprite.pathIndex = undefined;
          sprite.targetX = px.x;
          sprite.targetY = px.y;
          if (isIdleWander) {
            sprite.bubbleText = "趁机休息一下";
            sprite.bubbleUntil = now + 1800;
            sprite.targetTile = undefined;
            sprite.targetKind = undefined;
            sprite.retargetAt = undefined;
            sprite.idlePauseUntil = now + 2000 + Math.floor(Math.random() * 3000);
          }
        }
      } else {
        sprite.targetX = px.x;
        sprite.targetY = px.y;
      }
    }

    let dx = sprite.targetX - sprite.x;
    let dy = sprite.targetY - sprite.y;
    let distance = Math.hypot(dx, dy);
    const speed = statusSpeed(agent.status || "working");

    if (distance > 0.1) {
      const step = Math.min(speed, distance, 0.4);
      const nextX = sprite.x + (dx / distance) * step;
      const nextY = sprite.y + (dy / distance) * step;
      const smoothing = distance < 2 ? 0.4 : 1;
      const smoothX = sprite.x + (nextX - sprite.x) * smoothing;
      const smoothY = sprite.y + (nextY - sprite.y) * smoothing;
      const nextTile = pixelToTile(smoothX, smoothY);

      let canMove = true;
      if (doorNodesSetRef.current.size > 0) {
        const currentTile = pixelToTile(sprite.x, sprite.y);
        const curDoorKey = nodeKey(currentTile.row, currentTile.col);

        if (doorNodesSetRef.current.has(curDoorKey)) {
          openDoorCluster(curDoorKey, now);
        }
      }

      let moveX = smoothX;
      let moveY = smoothY;
      const isTileBlocked = (tile: Tile) => {
        if (collisionMap && !isWalkable(tile.col, tile.row)) {
          return { blocked: true, terrain: true, agent: false };
        }
        const occupant = occupiedTiles.get(nodeKey(tile.row, tile.col));
        if (occupant && occupant !== agent.id) {
          return { blocked: true, terrain: false, agent: true };
        }
        return { blocked: false, terrain: false, agent: false };
      };

      const primaryBlock = isTileBlocked(nextTile);
      if (primaryBlock.blocked) {
        const stepX = smoothX - sprite.x;
        const stepY = smoothY - sprite.y;
        const axisCandidates = [
          { x: smoothX, y: sprite.y },
          { x: sprite.x, y: smoothY },
          { x: sprite.x + stepX * 1.6, y: sprite.y },
          { x: sprite.x, y: sprite.y + stepY * 1.6 },
          { x: sprite.x + stepX * 1.2, y: sprite.y - stepY * 0.9 },
          { x: sprite.x - stepX * 0.9, y: sprite.y + stepY * 1.2 },
          { x: sprite.x + stepX * 1.2, y: sprite.y + stepY * 1.2 },
          { x: sprite.x - stepX * 1.2, y: sprite.y - stepY * 1.2 },
        ];
        const randomizedCandidates = [...axisCandidates]
          .map((candidate) => ({
            candidate,
            weight: Math.random(),
          }))
          .sort((a, b) => a.weight - b.weight)
          .map((entry) => entry.candidate);
        let fallbackMove: { x: number; y: number } | undefined;
        for (const candidate of randomizedCandidates) {
          const tile = pixelToTile(candidate.x, candidate.y);
          const test = isTileBlocked(tile);
          if (!test.blocked) {
            fallbackMove = candidate;
            break;
          }
        }
        if (fallbackMove) {
          moveX = fallbackMove.x;
          moveY = fallbackMove.y;
          const fallbackTile = pixelToTile(moveX, moveY);
          const fallbackPx = tileToPixel(fallbackTile);
          sprite.targetX = fallbackPx.x;
          sprite.targetY = fallbackPx.y;
          canMove = true;
        } else {
          canMove = false;
        }
      }

      if (canMove) {
        sprite.x = moveX;
        sprite.y = moveY;
        const lastX = sprite.lastPosX ?? sprite.x;
        const lastY = sprite.lastPosY ?? sprite.y;
        const moved =
          sprite.lastPosX === undefined ||
          Math.hypot(sprite.x - lastX, sprite.y - lastY) > 0.05;
        if (moved) {
          sprite.lastPosX = sprite.x;
          sprite.lastPosY = sprite.y;
          sprite.lastMoveAt = now;
        }
        const lockExpired = !sprite.dirLockUntil || now > sprite.dirLockUntil;
        if (lockExpired && distance > 3) {
          if (Math.abs(dx) > Math.abs(dy)) {
            if (Math.abs(dx) > 4) {
              sprite.direction = dx > 0 ? "right" : "left";
              sprite.dirLockUntil = now + 250;
            }
          } else if (Math.abs(dy) > 4) {
            sprite.direction = dy > 0 ? "front" : "back";
            sprite.dirLockUntil = now + 250;
          }
        }
      } else {
        sprite.targetX = sprite.x;
        sprite.targetY = sprite.y;
        sprite.direction = "front";
        sprite.path = [];
        sprite.pathIndex = undefined;
        sprite.targetTile = undefined;
        sprite.targetKind = undefined;
        sprite.retargetAt = isWorking ? now + 500 : undefined;
        if (isIdleWander) {
          sprite.bubbleText = "趁机休息一下";
          sprite.bubbleUntil = now + 1800;
          sprite.idlePauseUntil = now + 2000 + Math.floor(Math.random() * 3000);
        }
      }
    } else if (distance < 0.2) {
      sprite.direction = isWorking ? "back" : "front";
    }

    if (isWorking && !inDeskGrace && sprite.lastMoveAt && now - sprite.lastMoveAt > 1500) {
      const chairPos = tileToPixel(workTarget);
      sprite.x = chairPos.x;
      sprite.y = chairPos.y;
      sprite.targetX = chairPos.x;
      sprite.targetY = chairPos.y;
      sprite.path = [];
      sprite.pathIndex = undefined;
      sprite.lastMoveAt = now;
    }

    if (distance < 0.2 && sprite.path && sprite.pathIndex !== undefined) {
      if (sprite.pathIndex < sprite.path.length - 1) {
        sprite.pathIndex += 1;
      } else {
        sprite.path = [];
        sprite.pathIndex = undefined;
        if (isIdleWander) {
          sprite.bubbleText = "趁机休息一下";
          sprite.bubbleUntil = now + 1800;
          sprite.targetTile = undefined;
          sprite.targetKind = undefined;
          sprite.retargetAt = undefined;
          sprite.idlePauseUntil = now + 5000 + Math.floor(Math.random() * 5000);
        }
      }
    }
  });

  if (doorNodesSetRef.current.size > 0) {
    const occupiedDoorKeys = new Set<string>();
    spriteMap.forEach((s) => {
      const tile = pixelToTile(s.x, s.y);
      const k = nodeKey(tile.row, tile.col);
      if (doorNodesSetRef.current.has(k)) {
        const cluster = doorClusters.get(k) || [k];
        cluster.forEach((doorKey) => {
          occupiedDoorKeys.add(doorKey);
        });
        openDoorCluster(k, tickNow);
      }
    });

    const keepOpenMs = 1200;
    for (const k of doorNodesSetRef.current) {
      if (occupiedDoorKeys.has(k)) {
        continue;
      }
      const openedAt = doorOpenSinceRef.current.get(k);
      if (openedAt && tickNow - openedAt < keepOpenMs) {
        continue;
      }
      if (doorStateRef.current.get(k) !== "door_closed") {
        doorStateRef.current.set(k, "door_closed");
        doorDirtyRef.current.add(k);
      }
    }
  }

  const exitNode = collisionMap
    ? pickMainExitNode(collisionMap.exitNodes, doorTile())
    : doorTile();
  for (const [id, sprite] of spriteMap.entries()) {
    if (!sprite.exiting || agentIds.has(id)) {
      continue;
    }
    if (!sprite.exitAt) {
      sprite.exitAt = tickNow;
    }
    if (!sprite.farewellText) {
      sprite.farewellText = farewellTexts[hashId(id) % farewellTexts.length];
    }
    if (sprite.preFarewellUntil && tickNow < sprite.preFarewellUntil) {
      sprite.targetX = sprite.x;
      sprite.targetY = sprite.y;
      sprite.direction = "front";
      continue;
    }
    if (sprite.preFarewellUntil && tickNow >= sprite.preFarewellUntil) {
      sprite.preFarewellUntil = undefined;
    }
    const targetTile = collisionMap
      ? pickExitTarget(
          pixelToTile(sprite.x, sprite.y),
          collisionMap.exitNodes.length > 0 ? collisionMap.exitNodes : [exitNode],
          collisionMap.grid
        )
      : exitNode;
    const baseTarget = tileToPixel(targetTile);
    const exitTarget = { x: baseTarget.x + exitOffsetX, y: baseTarget.y + exitOffsetY };

    if (collisionMap && (!sprite.path || sprite.path.length === 0)) {
      const currentTile = pixelToTile(sprite.x, sprite.y);
      const rawPath = computePath(collisionMap.grid, currentTile, targetTile, true);
      if (rawPath.length > 0) {
        sprite.path = rawPath;
        sprite.pathIndex = rawPath.length > 1 ? 1 : 0;
      } else if (!sprite.goodbyeUntil) {
        const now = tickNow;
        sprite.goodbyeUntil = now + goodbyeTtlMs;
        sprite.removeAt = now + goodbyeTtlMs;
      }
    }

    if (sprite.path && sprite.path.length > 0 && sprite.pathIndex !== undefined) {
      const nextIndex = Math.min(sprite.pathIndex, sprite.path.length - 1);
      const nextNode = sprite.path[nextIndex];
      const px = tileToPixel(nextNode);
      sprite.targetX = px.x;
      sprite.targetY = px.y;
    } else if (!sprite.goodbyeUntil) {
      sprite.targetX = exitTarget.x;
      sprite.targetY = exitTarget.y;
    }

    const dx = sprite.targetX - sprite.x;
    const dy = sprite.targetY - sprite.y;
    const distance = Math.hypot(dx, dy);
    const exitDistance = Math.hypot(exitTarget.x - sprite.x, exitTarget.y - sprite.y);
    const step = Math.min(0.85, distance);
    if (!sprite.goodbyeUntil && distance > 0.1) {
      const nextX = sprite.x + (dx / distance) * step;
      const nextY = sprite.y + (dy / distance) * step;
      const nextTile = pixelToTile(nextX, nextY);
      if (!collisionMap || isWalkable(nextTile.col, nextTile.row)) {
        sprite.x = nextX;
        sprite.y = nextY;
      } else {
        sprite.path = [];
        sprite.pathIndex = undefined;
      }
    }
    if (!sprite.goodbyeUntil) {
      sprite.direction = dy > 0 ? "front" : "back";
    }

    const reachedDoor = exitDistance < 1;
    const pathCompleted = !sprite.path || sprite.path.length === 0;
    if ((reachedDoor || (pathCompleted && exitDistance < 8)) && !sprite.goodbyeUntil) {
      const now = tickNow;
      sprite.goodbyeUntil = now + goodbyeTtlMs;
      sprite.removeAt = now + goodbyeTtlMs;
    }

    if (distance < 0.2 && sprite.path && sprite.pathIndex !== undefined) {
      if (sprite.pathIndex < sprite.path.length - 1) {
        sprite.pathIndex += 1;
      } else {
        sprite.path = [];
        sprite.pathIndex = undefined;
      }
    }

    const exitExpired = Boolean(sprite.removeAt && tickNow > sprite.removeAt);
    const hardExpiry = Boolean(sprite.exitAt && tickNow - sprite.exitAt > exitTtlMs * 4);
    if (hardExpiry && !sprite.goodbyeUntil) {
      const now = tickNow;
      sprite.goodbyeUntil = now + goodbyeTtlMs;
      sprite.removeAt = now + goodbyeTtlMs;
    }
    if (exitExpired) {
      spriteMap.delete(id);
      agentCache.delete(id);
    }
  }

  if (tickNow - lastRenderAtRef.current >= frameBudgetMs) {
    if (doorDirtyRef.current.size > 0) {
      const dirtyDoors = Array.from(doorDirtyRef.current);
      doorDirtyRef.current.clear();
      setTileMap((prev) => {
        if (!prev.length || !prev[0]?.length) {
          return prev;
        }
        let changed = false;
        const next = [...prev];
        dirtyDoors.forEach((k) => {
          const [row, col] = k.split(",").map(Number);
          if (
            Number.isNaN(row) ||
            Number.isNaN(col) ||
            row < 0 ||
            col < 0 ||
            row >= prev.length ||
            col >= prev[0].length
          ) {
            return;
          }
          const desired =
            doorStateRef.current.get(k) === "door_open" ? "door_open" : "door_closed";
          if (prev[row][col] !== desired) {
            if (next[row] === prev[row]) {
              next[row] = [...prev[row]];
            }
            next[row][col] = desired;
            changed = true;
          }
        });
        if (changed) {
          tileMapRef.current = next;
          return next;
        }
        return prev;
      });
    }
    lastRenderAtRef.current = tickNow;
    triggerFrame();
  }
};
