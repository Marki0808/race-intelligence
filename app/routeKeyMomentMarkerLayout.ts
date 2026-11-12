export type ProjectedKeyMoment = { id: string; x: number; y: number };
export type KeyMomentOffset = { x: number; y: number };

/** Deterministic small-grid offsets for screen-space marker collisions; source coordinates stay untouched. */
export function layoutKeyMomentMarkerOffsets(
  points: readonly ProjectedKeyMoment[],
  viewportWidth: number,
  viewportHeight: number,
  collisionDistance = 30,
  spacing = 32,
  markerRadius = 14,
): Map<string, KeyMomentOffset> {
  const offsets = new Map(points.map(({ id }) => [id, { x: 0, y: 0 }]));
  const parent = points.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (left: number, right: number) => { parent[find(right)] = find(left); };
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = points[left].x - points[right].x;
      const dy = points[left].y - points[right].y;
      if (dx * dx + dy * dy < collisionDistance * collisionDistance) join(left, right);
    }
  }
  const groups = new Map<number, ProjectedKeyMoment[]>();
  points.forEach((point, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(point);
    groups.set(root, group);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.id.localeCompare(right.id));
    const columns = Math.ceil(Math.sqrt(group.length));
    const rows = Math.ceil(group.length / columns);
    const centerX = group.reduce((sum, point) => sum + point.x, 0) / group.length;
    const centerY = group.reduce((sum, point) => sum + point.y, 0) / group.length;
    const leftEdge = centerX - ((columns - 1) * spacing) / 2 - markerRadius;
    const rightEdge = centerX + ((columns - 1) * spacing) / 2 + markerRadius;
    const topEdge = centerY - ((rows - 1) * spacing) / 2 - markerRadius;
    const bottomEdge = centerY + ((rows - 1) * spacing) / 2 + markerRadius;
    const shiftX = leftEdge < markerRadius ? markerRadius - leftEdge : rightEdge > viewportWidth - markerRadius ? viewportWidth - markerRadius - rightEdge : 0;
    const shiftY = topEdge < markerRadius ? markerRadius - topEdge : bottomEdge > viewportHeight - markerRadius ? viewportHeight - markerRadius - bottomEdge : 0;
    group.forEach((point, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const targetX = centerX + (column - (columns - 1) / 2) * spacing + shiftX;
      const targetY = centerY + (row - (rows - 1) / 2) * spacing + shiftY;
      offsets.set(point.id, { x: targetX - point.x, y: targetY - point.y });
    });
  }
  return offsets;
}
