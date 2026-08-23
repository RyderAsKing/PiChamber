import { describe, expect, test } from 'bun:test'
import { parseExtensionChatItem, PI_EXTENSION_UI_CUSTOM_TYPE } from './extension-ui'

describe('parseExtensionChatItem', () => {
  test('parses a pichamber.ui entry descriptor', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        title: 'Explore',
        component: 'progress',
        props: { label: 'Indexed', value: 40, max: 200 },
        actions: [{ label: 'Focus', command: 'explore:focus', args: 'src' }],
      },
    })
    expect(parsed.kind).toBe('ui')
    if (parsed.kind !== 'ui') return
    expect(parsed.descriptor.title).toBe('Explore')
    expect(parsed.descriptor.component).toEqual({
      component: 'progress',
      label: 'Indexed',
      value: 40,
      max: 200,
    })
    expect(parsed.descriptor.actions).toEqual([
      { label: 'Focus', command: 'explore:focus', args: 'src' },
    ])
  })

  test('accepts nested ui payload and namespaced custom types', () => {
    const nested = parseExtensionChatItem({
      customType: 'pichamber.explore',
      data: {
        ui: { component: 'kv', props: { rows: [{ label: 'Files', value: '12' }] } },
      },
    })
    expect(nested.kind).toBe('ui')
    if (nested.kind === 'ui') {
      expect(nested.descriptor.component.component).toBe('kv')
    }
  })

  test('falls back to a generic card for unknown components', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: { component: 'hologram', props: { whatever: true } },
      text: 'note',
    })
    expect(parsed.kind).toBe('fallback')
    if (parsed.kind !== 'fallback') return
    expect(parsed.title).toBe(PI_EXTENSION_UI_CUSTOM_TYPE)
    expect(parsed.body).toContain('hologram')
    expect(parsed.body).toContain('note')
  })

  test('renders actions even when the component is unknown', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'unknown-thing',
        actions: [{ label: 'Run', command: 'ext.run' }],
      },
    })
    expect(parsed.kind).toBe('ui')
    if (parsed.kind !== 'ui') return
    expect(parsed.descriptor.actions?.map((action) => action.command)).toEqual(['ext.run'])
  })

  test('rejects unsafe action commands', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'badges',
        props: { items: ['a'] },
        actions: [
          { label: 'ok', command: 'good' },
          { label: 'slash', command: 'a/b' },
          { label: 'traversal', command: '..etc' },
          { label: 'no label' },
        ],
      },
    })
    expect(parsed.kind).toBe('ui')
    if (parsed.kind !== 'ui') return
    expect(parsed.descriptor.actions?.map((action) => action.command)).toEqual(['good'])
  })

  test('non-pichamber custom types render as fallback with their content', () => {
    const fromMessage = parseExtensionChatItem({
      customType: 'my-extension',
      details: { count: 3 },
      text: 'Status update',
    })
    expect(fromMessage.kind).toBe('fallback')
    if (fromMessage.kind !== 'fallback') return
    expect(fromMessage.title).toBe('my-extension')
    expect(fromMessage.body).toContain('"count": 3')

    const fromEntry = parseExtensionChatItem({
      customType: 'internal-state',
      data: { items: [1, 2] },
    })
    expect(fromEntry.kind).toBe('fallback')
  })

  test('handles versioned protocol and unknown versions as fallback', () => {
    const versioned = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        protocol: 'pichamber-extension-ui',
        version: 1,
        component: 'markdown',
        props: { body: 'ok' },
      },
    })
    expect(versioned.kind).toBe('ui')

    const future = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        protocol: 'pichamber-extension-ui',
        version: 99,
        component: 'markdown',
        props: { body: 'future' },
      },
    })
    expect(future.kind).toBe('fallback')
  })

  test('validates table and badge payloads', () => {
    const table = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'table',
        props: { columns: ['File', 'Status'], rows: [['a.ts', 'done'], ['ignored']] },
      },
    })
    expect(table.kind).toBe('ui')
    if (table.kind === 'ui' && table.descriptor.component.component === 'table') {
      expect(table.descriptor.component.rows).toHaveLength(2)
    } else {
      throw new Error('expected table component')
    }

    const badges = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'badges',
        props: { items: [{ label: 'ok', tone: 'success' }, 'plain', 42] },
      },
    })
    expect(badges.kind).toBe('ui')
    if (badges.kind === 'ui' && badges.descriptor.component.component === 'badges') {
      expect(badges.descriptor.component.items).toEqual([
        { label: 'ok', tone: 'success' },
        { label: 'plain', tone: 'neutral' },
      ])
    }
  })
})

describe('generalized card actions', () => {
  test('parses icon, disabled, loading, confirm, and promptForArgs fields', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'markdown',
        props: { body: 'Agents' },
        actions: [
          {
            label: 'Cancel',
            command: 'agents-cancel',
            args: 'research',
            icon: 'close',
            confirm: 'Cancel the research agent?',
          },
          { label: 'Spawn', command: 'agents-spawn', promptForArgs: { label: 'Agent name', placeholder: 'research' } },
          { label: 'Frozen', command: 'agents-frozen', disabled: true, loading: true },
        ],
      },
    })
    expect(parsed.kind).toBe('ui')
    if (parsed.kind !== 'ui') throw new Error('expected ui')
    expect(parsed.descriptor.actions?.[0]).toEqual({
      label: 'Cancel',
      command: 'agents-cancel',
      args: 'research',
      icon: 'close',
      confirm: 'Cancel the research agent?',
    })
    expect(parsed.descriptor.actions?.[1]).toEqual({
      label: 'Spawn',
      command: 'agents-spawn',
      promptForArgs: { label: 'Agent name', placeholder: 'research' },
    })
    expect(parsed.descriptor.actions?.[2]).toEqual({
      label: 'Frozen',
      command: 'agents-frozen',
      disabled: true,
      loading: true,
    })
  })

  test('truncates oversized action text and drops hostile commands', () => {
    const parsed = parseExtensionChatItem({
      customType: PI_EXTENSION_UI_CUSTOM_TYPE,
      data: {
        component: 'markdown',
        props: { body: '' },
        actions: [
          { label: `${'x'.repeat(300)}`, command: 'ok-command', args: `${'y'.repeat(5000)}` },
          { label: 'Bad', command: '../escape' },
          { label: 'Bad', command: 'a/b' },
          { label: 'Long icon', command: 'ok-command', icon: `${'i'.repeat(100)}` },
        ],
      },
    })
    expect(parsed.kind).toBe('ui')
    if (parsed.kind !== 'ui') throw new Error('expected ui')
    expect(parsed.descriptor.actions).toHaveLength(2)
    const actions = parsed.descriptor.actions ?? []
    const first = actions[0]
    const longIcon = actions[1]
    expect(first?.label).toHaveLength(128)
    expect(first?.args).toHaveLength(2_000)
    expect(longIcon?.icon).toHaveLength(64)
  })
})
