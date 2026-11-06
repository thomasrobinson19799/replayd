import { expect, it } from 'vitest'
import { collect, emptyPanels, sortPanels } from '../app/utils/replay'
it('keeps timestamped field history separate from timeline markers', () => {
  const panels = emptyPanels()
  collect([
    { type: 5, timestamp: 20, data: { tag: 'fields', payload: { field: 'custom_fields', value: { plan: 'pro' } } } },
    { type: 5, timestamp: 10, data: { tag: 'fields', payload: { field: 'user', value: { name: 'First' } } } },
    { type: 5, timestamp: 30, data: { tag: 'fields', payload: { field: 'user', value: null } } },
  ], panels)
  sortPanels(panels)
  expect(panels.fields.map(f => f.ts)).toEqual([10, 20, 30])
  expect(panels.fields[0]?.text).toContain('First')
  expect(panels.fields[2]?.text).toBe('null')
  expect(panels.markers).toEqual([])
})
