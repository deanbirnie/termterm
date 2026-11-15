/**
 * The arrangement of panes inside a tab, like tmux: a tree whose leaves are
 * sessions and whose inner nodes split their space into a row (side by side)
 * or a column (one above the other). Everything here is pure; the interface
 * keeps one tree per tab and renders each session once, placed by `rects`, so
 * rearranging panes never restarts a session.
 */

export type Direction = 'row' | 'column'
export type Side = 'left' | 'right' | 'top' | 'bottom'

export type Layout =
  | { kind: 'pane'; id: string }
  | { kind: 'split'; dir: Direction; children: Layout[]; sizes: number[] }

/** A rectangle in fractions of the tab's area (0 to 1). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A draggable boundary between children `index` and `index + 1` of the split at `path`. */
export interface Divider {
  path: number[]
  index: number
  dir: Direction
  rect: Rect
}

export const pane = (id: string): Layout => ({ kind: 'pane', id })

export function panes(layout: Layout): string[] {
  return layout.kind === 'pane' ? [layout.id] : layout.children.flatMap(panes)
}

export function contains(layout: Layout, id: string): boolean {
  return panes(layout).includes(id)
}

const sideDir = (side: Side): Direction => (side === 'left' || side === 'right' ? 'row' : 'column')
const sideBefore = (side: Side) => side === 'left' || side === 'top'

/** Builds a split, merging children that split the same way into it. */
function makeSplit(dir: Direction, children: Layout[], sizes: number[]): Layout {
  const outChildren: Layout[] = []
  const outSizes: number[] = []
  children.forEach((child, i) => {
    if (child.kind === 'split' && child.dir === dir) {
      child.children.forEach((c, j) => {
        outChildren.push(c)
        outSizes.push(sizes[i]! * child.sizes[j]!)
      })
    } else {
      outChildren.push(child)
      outSizes.push(sizes[i]!)
    }
  })
  if (outChildren.length === 1) return outChildren[0]!
  const total = outSizes.reduce((a, b) => a + b, 0)
  return { kind: 'split', dir, children: outChildren, sizes: outSizes.map((s) => s / total) }
}

/**
 * Puts `insert` (a pane or a whole layout) beside the pane `target`, on the
 * given side, sharing the target's space equally. Returns the layout
 * unchanged if `target` is not in it.
 */
export function insertBeside(layout: Layout, target: string, side: Side, insert: Layout): Layout {
  if (layout.kind === 'pane') {
    if (layout.id !== target) return layout
    const children = sideBefore(side) ? [insert, layout] : [layout, insert]
    return makeSplit(sideDir(side), children, [0.5, 0.5])
  }
  const index = layout.children.findIndex((c) => contains(c, target))
  if (index < 0) return layout
  const child = layout.children[index]!
  // Beside a pane that sits directly in a split of the same direction: take
  // half of that pane's share rather than nesting another split.
  if (child.kind === 'pane' && layout.dir === sideDir(side)) {
    const half = layout.sizes[index]! / 2
    const children = [...layout.children]
    const sizes = [...layout.sizes]
    const at = sideBefore(side) ? index : index + 1
    sizes[index] = half
    children.splice(at, 0, insert)
    sizes.splice(at, 0, half)
    return makeSplit(layout.dir, children, sizes)
  }
  const children = [...layout.children]
  children[index] = insertBeside(child, target, side, insert)
  return makeSplit(layout.dir, children, layout.sizes)
}

/** Removes a pane; its space goes to its neighbours. Null if it was the only pane. */
export function remove(layout: Layout, id: string): Layout | null {
  if (layout.kind === 'pane') return layout.id === id ? null : layout
  const children: Layout[] = []
  const sizes: number[] = []
  layout.children.forEach((child, i) => {
    const next = remove(child, id)
    if (next) {
      children.push(next)
      sizes.push(layout.sizes[i]!)
    }
  })
  if (children.length === 0) return null
  return makeSplit(layout.dir, children, sizes)
}

/** Where every pane sits, in fractions of the whole area. */
export function rects(layout: Layout, area: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const walk = (node: Layout, r: Rect) => {
    if (node.kind === 'pane') {
      out.set(node.id, r)
      return
    }
    childRects(node, r).forEach((cr, i) => walk(node.children[i]!, cr))
  }
  walk(layout, area)
  return out
}

function childRects(node: Extract<Layout, { kind: 'split' }>, r: Rect): Rect[] {
  let offset = 0
  return node.sizes.map((size) => {
    const cr =
      node.dir === 'row'
        ? { x: r.x + offset * r.w, y: r.y, w: size * r.w, h: r.h }
        : { x: r.x, y: r.y + offset * r.h, w: r.w, h: size * r.h }
    offset += size
    return cr
  })
}

/** Every boundary between neighbouring children, for drag handles. */
export function dividers(layout: Layout): Divider[] {
  const out: Divider[] = []
  const walk = (node: Layout, r: Rect, path: number[]) => {
    if (node.kind === 'pane') return
    const crs = childRects(node, r)
    crs.forEach((cr, i) => {
      if (i < crs.length - 1) {
        out.push({
          path,
          index: i,
          dir: node.dir,
          rect:
            node.dir === 'row'
              ? { x: cr.x + cr.w, y: cr.y, w: 0, h: cr.h }
              : { x: cr.x, y: cr.y + cr.h, w: cr.w, h: 0 },
        })
      }
      walk(node.children[i]!, cr, [...path, i])
    })
  }
  walk(layout, { x: 0, y: 0, w: 1, h: 1 }, [])
  return out
}

/** The rectangle of the split at `path`. */
export function splitRect(layout: Layout, path: number[]): Rect {
  let node = layout
  let r: Rect = { x: 0, y: 0, w: 1, h: 1 }
  for (const i of path) {
    if (node.kind !== 'split') break
    r = childRects(node, r)[i]!
    node = node.children[i]!
  }
  return r
}

/**
 * Moves the boundary after child `index` of the split at `path` to `fraction`
 * of that split's length (0 to 1), keeping both neighbours at least `min`.
 */
export function resize(layout: Layout, path: number[], index: number, fraction: number, min = 0.05): Layout {
  if (layout.kind !== 'split') return layout
  if (path.length > 0) {
    const [head, ...rest] = path
    const children = [...layout.children]
    children[head!] = resize(children[head!]!, rest, index, fraction, min)
    return { ...layout, children }
  }
  const sizes = [...layout.sizes]
  const start = sizes.slice(0, index).reduce((a, b) => a + b, 0)
  const pair = sizes[index]! + sizes[index + 1]!
  const lo = Math.min(min, pair / 2)
  const first = Math.min(Math.max(fraction - start, lo), pair - lo)
  sizes[index] = first
  sizes[index + 1] = pair - first
  return { ...layout, sizes }
}

/** Gives every child of every split an equal share. */
export function equalize(layout: Layout): Layout {
  if (layout.kind === 'pane') return layout
  const n = layout.children.length
  return { ...layout, children: layout.children.map(equalize), sizes: layout.children.map(() => 1 / n) }
}

/**
 * The pane next to `from` in a direction: of the panes across the nearest
 * edge on that side, the one overlapping `from` the most.
 */
export function neighbour(layout: Layout, from: string, side: Side): string | null {
  const all = rects(layout)
  const a = all.get(from)
  if (!a) return null
  const eps = 1e-6
  let best: string | null = null
  let bestDistance = Infinity
  let bestOverlap = 0
  for (const [id, b] of all) {
    if (id === from) continue
    let distance: number
    let overlap: number
    if (side === 'left' || side === 'right') {
      distance = side === 'left' ? a.x - (b.x + b.w) : b.x - (a.x + a.w)
      overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    } else {
      distance = side === 'top' ? a.y - (b.y + b.h) : b.y - (a.y + a.h)
      overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    }
    if (distance < -eps || overlap <= eps) continue
    if (distance < bestDistance - eps || (Math.abs(distance - bestDistance) <= eps && overlap > bestOverlap)) {
      best = id
      bestDistance = distance
      bestOverlap = overlap
    }
  }
  return best
}

/** Which edge of a rectangle a point (in the same units) is nearest to. */
export function nearestSide(r: Rect, px: number, py: number): Side {
  const fx = (px - r.x) / r.w
  const fy = (py - r.y) / r.h
  const d: [Side, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
}
