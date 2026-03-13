type GridNode = { row: number; col: number };

const neighbors = (node: GridNode) => [
  { row: node.row + 1, col: node.col },
  { row: node.row - 1, col: node.col },
  { row: node.row, col: node.col + 1 },
  { row: node.row, col: node.col - 1 },
];

const key = (node: GridNode) => `${node.row},${node.col}`;

const findPath = (grid: number[][], start: GridNode, end: GridNode) => {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  const inBounds = (node: GridNode) =>
    node.row >= 0 && node.col >= 0 && node.row < rows && node.col < cols;
  const isWalkable = (node: GridNode) => grid[node.row][node.col] > 0;

  if (!inBounds(start) || !inBounds(end)) {
    return [] as GridNode[];
  }
  if (!isWalkable(start) || !isWalkable(end)) {
    return [] as GridNode[];
  }
  if (start.row === end.row && start.col === end.col) {
    return [start];
  }

  const startKey = key(start);
  const endKey = key(end);
  const queue: GridNode[] = [start];
  let head = 0;
  const visited = new Set<string>([startKey]);
  const cameFrom = new Map<string, string>();

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentKey = key(current);

    if (currentKey === endKey) {
      const path: GridNode[] = [];
      let cursor: string | undefined = endKey;
      while (cursor) {
        const [cr, cc] = cursor.split(",").map(Number);
        path.push({ row: cr, col: cc });
        cursor = cameFrom.get(cursor);
      }
      return path.reverse();
    }

    for (const next of neighbors(current)) {
      if (!inBounds(next) || !isWalkable(next)) {
        continue;
      }
      const nextKey = key(next);
      if (visited.has(nextKey)) {
        continue;
      }
      visited.add(nextKey);
      cameFrom.set(nextKey, currentKey);
      queue.push(next);
    }
  }

  return [] as GridNode[];
};

export type { GridNode };
export { findPath };
