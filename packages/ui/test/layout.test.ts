import { describe, expect, it } from 'vitest'
import {
  dividers,
  equalize,
  insertBeside,
  nearestSide,
  neighbour,
  pane,
  panes,
  rects,
  remove,
  resize,
  type Layout,
} from '../src/layout'

const close = (r: { x: number; y: number; w: number; h: number } | undefined) =>
  r && { x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) }

describe('layout', () => {
  it('splits a pane side by side and above/below', () => {
    let l: Layout = pane('a')
    l = insertBeside(l, 'a', 'right', pane('b'))
    expect(l).toEqual({ kind: 'split', dir: 'row', children: [pane('a'), pane('b')], sizes: [0.5, 0.5] })
    l = insertBeside(l, 'b', 'bottom', pane('c'))
    expect(panes(l)).toEqual(['a', 'b', 'c'])
    expect(close(rects(l).get('c'))).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    l = insertBeside(l, 'a', 'top', pane('d'))
    expect(close(rects(l).get('d'))).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(close(rects(l).get('a'))).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('splitting again the same way shares that pane, not the whole row', () => {
    let l: Layout = insertBeside(pane('a'), 'a', 'right', pane('b'))
    l = insertBeside(l, 'b', 'right', pane('c'))
    expect(l.kind === 'split' && l.children.length).toBe(3)
    expect(l.kind === 'split' && l.sizes).toEqual([0.5, 0.25, 0.25])
    l = insertBeside(l, 'a', 'left', pane('z'))
    expect(panes(l)).toEqual(['z', 'a', 'b', 'c'])
    expect(l.kind === 'split' && l.sizes).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it('splits as deep as wanted', () => {
    let l: Layout = pane('p0')
    for (let i = 1; i <= 8; i++) l = insertBeside(l, `p${i - 1}`, i % 2 ? 'right' : 'bottom', pane(`p${i}`))
    expect(panes(l)).toHaveLength(9)
    const area = [...rects(l).values()].reduce((s, r) => s + r.w * r.h, 0)
    expect(area).toBeCloseTo(1)
  })

  it('inserts a whole layout (a tab moved into another)', () => {
    const other = insertBeside(pane('x'), 'x', 'bottom', pane('y'))
    const l = insertBeside(pane('a'), 'a', 'right', other)
    expect(panes(l)).toEqual(['a', 'x', 'y'])
    expect(close(rects(l).get('y'))).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('removing a pane gives its space to the rest and collapses single splits', () => {
    let l: Layout = insertBeside(pane('a'), 'a', 'right', pane('b'))
    l = insertBeside(l, 'b', 'bottom', pane('c'))
    l = remove(l, 'b')!
    expect(l).toEqual({ kind: 'split', dir: 'row', children: [pane('a'), pane('c')], sizes: [0.5, 0.5] })
    l = remove(l, 'a')!
    expect(l).toEqual(pane('c'))
    expect(remove(l, 'c')).toBeNull()
    expect(remove(l, 'missing')).toEqual(pane('c'))
  })

  it('removing from a nested split merges a same-direction remainder into its parent', () => {
    // a | (b / (c | d)) -> remove b -> a | c | d
    let l: Layout = insertBeside(pane('a'), 'a', 'right', pane('b'))
    l = insertBeside(l, 'b', 'bottom', pane('c'))
    l = insertBeside(l, 'c', 'right', pane('d'))
    l = remove(l, 'b')!
    expect(l.kind === 'split' && l.dir).toBe('row')
    expect(panes(l)).toEqual(['a', 'c', 'd'])
    expect(l.kind === 'split' && l.sizes).toEqual([0.5, 0.25, 0.25])
  })

  it('reports dividers and resizes them within limits', () => {
    let l: Layout = insertBeside(pane('a'), 'a', 'right', pane('b'))
    l = insertBeside(l, 'b', 'bottom', pane('c'))
    const ds = dividers(l)
    expect(ds.map((d) => [d.path, d.index, d.dir])).toEqual([
      [[], 0, 'row'],
      [[1], 0, 'column'],
    ])
    l = resize(l, [], 0, 0.7)
    expect(close(rects(l).get('a'))?.w).toBe(0.7)
    l = resize(l, [1], 0, 0.99, 0.1)
    expect(close(rects(l).get('c'))?.h).toBe(0.1)
    l = resize(l, [], 0, -1, 0.1)
    expect(close(rects(l).get('a'))?.w).toBe(0.1)
    expect(close(rects(equalize(l)).get('a'))?.w).toBe(0.5)
  })

  it('finds the neighbouring pane in each direction', () => {
    // a | (b / c)
    let l: Layout = insertBeside(pane('a'), 'a', 'right', pane('b'))
    l = insertBeside(l, 'b', 'bottom', pane('c'))
    expect(neighbour(l, 'a', 'right')).toBe('b') // overlaps b and c equally: first wins
    expect(neighbour(l, 'c', 'left')).toBe('a')
    expect(neighbour(l, 'b', 'bottom')).toBe('c')
    expect(neighbour(l, 'c', 'top')).toBe('b')
    expect(neighbour(l, 'a', 'left')).toBeNull()
    expect(neighbour(l, 'b', 'right')).toBeNull()
  })

  it('picks the nearest edge for a drop', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 }
    expect(nearestSide(r, 5, 25)).toBe('left')
    expect(nearestSide(r, 95, 25)).toBe('right')
    expect(nearestSide(r, 50, 2)).toBe('top')
    expect(nearestSide(r, 50, 48)).toBe('bottom')
  })
})
