import { TuiLensError } from "./errors.js";
import type { ClickTextOptions, Region } from "./types.js";

export interface ClickTarget {
  hitbox: Region;
  point: { x: number; y: number };
}

/** 文本匹配只给出字形范围；命中区由调用方显式声明，不能把两者混为一谈。 */
export function clickTarget(
  match: Region,
  cols: number,
  rows: number,
  options: ClickTextOptions = {},
): ClickTarget {
  const left = options.hitbox?.left ?? 0;
  const right = options.hitbox?.right ?? 0;
  const top = options.hitbox?.top ?? 0;
  const bottom = options.hitbox?.bottom ?? 0;
  const hitbox = {
    x: match.x - left,
    y: match.y - top,
    width: match.width + left + right,
    height: match.height + top + bottom,
  };
  if (hitbox.x < 0 || hitbox.y < 0 || hitbox.width < 1 || hitbox.height < 1
    || hitbox.x + hitbox.width > cols || hitbox.y + hitbox.height > rows) {
    throw new TuiLensError("INVALID_HITBOX", "点击命中区必须位于终端字符网格内", { hitbox, cols, rows });
  }
  const centerX = hitbox.x + Math.floor(hitbox.width / 2);
  const centerY = hitbox.y + Math.floor(hitbox.height / 2);
  const point = (() => {
    switch (options.point ?? "center") {
      case "left": return { x: hitbox.x, y: centerY };
      case "right": return { x: hitbox.x + hitbox.width - 1, y: centerY };
      case "top": return { x: centerX, y: hitbox.y };
      case "bottom": return { x: centerX, y: hitbox.y + hitbox.height - 1 };
      default: return { x: centerX, y: centerY };
    }
  })();
  point.x += options.offset?.x ?? 0;
  point.y += options.offset?.y ?? 0;
  if (point.x < hitbox.x || point.y < hitbox.y
    || point.x >= hitbox.x + hitbox.width || point.y >= hitbox.y + hitbox.height) {
    throw new TuiLensError("INVALID_HITBOX", "点击点必须位于声明的命中区内", { hitbox, point });
  }
  return { hitbox, point };
}
