import { getRoomRegion, nodeKey } from "./Agent";
import type { CollisionMapData, DoorVisualState, RoomRegion } from "./Agent";

export type OfficeMapBuildResult = {
  width: number;
  height: number;
  collisionMap: CollisionMapData;
  roomSlackNodes: Record<RoomRegion, { row: number; col: number }[]>;
  doorNodeKeys: Set<string>;
  doorStates: Map<string, DoorVisualState>;
  initialTileMap: string[][];
  workNodeKeys: Set<string>;
};

const computeWorkCenters = (grid: number[][], rows: number, cols: number) => {
  const workCenters: { row: number; col: number }[] = [];
  const visited = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false)
  );
  const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols;
  const deltas = [
    { row: 1, col: 0 },
    { row: -1, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: -1 },
  ];

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (visited[r][c] || grid[r][c] !== 2) continue;
      const stack = [{ row: r, col: c }];
      const cluster: { row: number; col: number }[] = [];
      visited[r][c] = true;
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        cluster.push(node);
        deltas.forEach((d) => {
          const nr = node.row + d.row;
          const nc = node.col + d.col;
          if (!inBounds(nr, nc)) return;
          if (visited[nr][nc]) return;
          if (grid[nr][nc] !== 2) return;
          visited[nr][nc] = true;
          stack.push({ row: nr, col: nc });
        });
      }
      if (cluster.length > 0) {
        const avgRow = cluster.reduce((sum, n) => sum + n.row, 0) / cluster.length;
        const avgCol = cluster.reduce((sum, n) => sum + n.col, 0) / cluster.length;
        let best = cluster[0];
        let bestDist = Number.POSITIVE_INFINITY;
        cluster.forEach((n) => {
          const dist = Math.abs(n.row - avgRow) + Math.abs(n.col - avgCol);
          if (dist < bestDist) {
            bestDist = dist;
            best = n;
          }
        });
        workCenters.push(best);
      }
    }
  }

  return workCenters;
};

export const buildOfficeMap = async (
  imageUrl: string,
  tileSize: number
): Promise<OfficeMapBuildResult> => {
  const img = new Image();
  img.src = imageUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load map image: ${imageUrl}`));
  });

  const width = img.width;
  const height = img.height;
  const cols = Math.floor(width / tileSize);
  const rows = Math.floor(height / tileSize);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D context for office map generation");
  }
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowArr: number[] = [];
    for (let c = 0; c < cols; c++) {
      let transparentSamples = 0;
      let blueSamples = 0;
      let greenSamples = 0;
      let redSamples = 0;
      let totalSamples = 0;
      const px = c * tileSize;
      const py = r * tileSize;

      for (let sy = 1; sy < tileSize; sy += 2) {
        for (let sx = 1; sx < tileSize; sx += 2) {
          const sampleX = px + sx;
          const sampleY = py + sy;

          if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
            totalSamples += 1;
            continue;
          }

          const idx = (Math.floor(sampleY) * width + Math.floor(sampleX)) * 4;
          if (idx >= 0 && idx < pixels.length) {
            const red = pixels[idx];
            const green = pixels[idx + 1];
            const blue = pixels[idx + 2];
            const alpha = pixels[idx + 3];

            if (blue > 200 && red < 50 && green < 50) {
              blueSamples += 1;
            } else if (green > 200 && red < 50 && blue < 50) {
              greenSamples += 1;
            } else if (red > 200 && green < 50 && blue < 50) {
              redSamples += 1;
            } else if (alpha < 50) {
              transparentSamples += 1;
            }
          }
          totalSamples += 1;
        }
      }

      const blueRatio = totalSamples > 0 ? blueSamples / totalSamples : 0;
      const greenRatio = totalSamples > 0 ? greenSamples / totalSamples : 0;
      const redRatio = totalSamples > 0 ? redSamples / totalSamples : 0;
      const transparentRatio = totalSamples > 0 ? transparentSamples / totalSamples : 0;

      let state = 0;
      if (redRatio > 0.3) state = 5;
      else if (greenRatio > 0.3) state = 4;
      else if (blueRatio > 0.3) state = 2;
      else if (transparentRatio > 0.6) state = 1;

      rowArr.push(state);
    }
    grid.push(rowArr);
  }

  const workNodes: { row: number; col: number }[] = [];
  const doorNodes: { row: number; col: number }[] = [];
  const exitNodes: { row: number; col: number }[] = [];

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const state = grid[r][c];
      if (state === 2) workNodes.push({ row: r, col: c });
      if (state === 4) doorNodes.push({ row: r, col: c });
      if (state === 5) exitNodes.push({ row: r, col: c });
    }
  }

  const workCenters = computeWorkCenters(grid, rows, cols);
  const allWorkNodes = workCenters.length > 0 ? workCenters : workNodes;

  const transitSet = new Set<string>();
  const addTransitNearby = (nodes: { row: number; col: number }[], radius: number) => {
    nodes.forEach((node) => {
      for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
          const row = node.row + dr;
          const col = node.col + dc;
          if (row < 0 || col < 0 || row >= rows || col >= cols) continue;
          const state = grid[row][col];
          if (state <= 0 || state === 2) continue;
          transitSet.add(nodeKey(row, col));
        }
      }
    });
  };

  addTransitNearby(doorNodes, 5);
  addTransitNearby(exitNodes, 7);

  const transitNodes = Array.from(transitSet).map((entry) => {
    const [row, col] = entry.split(",").map(Number);
    return { row, col };
  });

  const slackNodes: { row: number; col: number }[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r][c] !== 1) continue;
      if (transitSet.has(nodeKey(r, c))) continue;

      let hasClearance = true;
      for (let dr = -1; dr <= 1 && hasClearance; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) {
            hasClearance = false;
            break;
          }
          const state = grid[rr][cc];
          if (state <= 0) {
            hasClearance = false;
            break;
          }
        }
      }
      if (!hasClearance) continue;

      let minWorkDist = Number.POSITIVE_INFINITY;
      allWorkNodes.forEach((node) => {
        const dist = Math.abs(node.row - r) + Math.abs(node.col - c);
        if (dist < minWorkDist) {
          minWorkDist = dist;
        }
      });

      if (allWorkNodes.length === 0 || minWorkDist >= 10) {
        slackNodes.push({ row: r, col: c });
      }
    }
  }

  const roomSlackNodes: Record<RoomRegion, { row: number; col: number }[]> = {
    top_left: [],
    top_right: [],
    bottom_left: [],
    bottom_right: [],
  };
  const centerRow = rows / 2;
  const centerCol = cols / 2;
  const centerMargin = 3;
  slackNodes.forEach((node) => {
    if (
      Math.abs(node.row - centerRow) <= centerMargin &&
      Math.abs(node.col - centerCol) <= centerMargin
    ) {
      return;
    }
    const region = getRoomRegion(node, rows, cols);
    roomSlackNodes[region].push(node);
  });

  const initialTileMap = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => "")
  );
  const doorNodeKeys = new Set<string>();
  const doorStates = new Map<string, DoorVisualState>();
  doorNodes.forEach((node) => {
    if (node.row < initialTileMap.length && node.col < initialTileMap[0].length) {
      initialTileMap[node.row][node.col] = "door_closed";
      const key = nodeKey(node.row, node.col);
      doorNodeKeys.add(key);
      doorStates.set(key, "door_closed");
    }
  });

  return {
    width,
    height,
    collisionMap: {
      rows,
      cols,
      grid,
      workNodes,
      workCenters,
      doorNodes,
      exitNodes,
      transitNodes,
      slackNodes,
    },
    roomSlackNodes,
    doorNodeKeys,
    doorStates,
    initialTileMap,
    workNodeKeys: new Set(workNodes.map((node) => nodeKey(node.row, node.col))),
  };
};
