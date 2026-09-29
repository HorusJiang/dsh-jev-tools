/**
 * The bundle configuration card.
 *
 * This card is the plugin's **only** configuration surface: it occupies
 * `plugins.bundle.config` under the bundle's package name, and that seat is
 * single-occupant, so every settings field the card does not draw is a field a
 * GUI user cannot reach at all. That is how `baseUrl` shipped from 0.1.6 to
 * 0.1.10 — declared, wired on the host side, and unreachable from the page
 * (issue #3).
 *
 * So the assertions here are about reachability, not styling: the two endpoint
 * fields exist and carry the host's values, an edit reaches the settings seam
 * with the revision the host reported, an invalid or unchanged draft reaches it
 * not at all, and both languages are worded.
 *
 * The card is a lazy-CJS bundle that talks to a real React and a real host, so
 * it is rendered here through a React stub with exactly the hooks it uses. The
 * stub is not a reconciler: `render` re-invokes the component until it stops
 * marking itself dirty, which is all this card's state machine needs.
 *
 * @module dsh-jev-tools/test/client
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CARD = path.join(ROOT, 'client', 'client.js')
/** The namespace the card reads and writes; the host half declares the same one. */
const NS = 'dsh-jev-tools'

/** Yield to every pending microtask, so an awaited seam has settled. */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** One element of the stub's tree. */
interface Element { type: unknown, props: Record<string, any> }

/**
 * A React just large enough to run one function component.
 *
 * @returns the stub, plus a `render` that settles the component.
 */
function createReact (): { React: Record<string, unknown>, render: (component: any, props: unknown) => Promise<unknown> } {
  const hooks: any[] = []
  const hookDeps = new Map<number, unknown[]>()
  let pending: Array<() => unknown> = []
  let cursor = 0
  let dirty = false

  /**
   * Whether a hook's dependencies changed since the previous render.
   *
   * Faithful to React on purpose: a stub that ignored dependencies would hand
   * the card a stale closure and then blame the card for it.
   */
  function changed (index: number, deps: unknown[] | undefined): boolean {
    if (deps === undefined) return true
    const previous = hookDeps.get(index)
    hookDeps.set(index, deps)
    if (previous === undefined || previous.length !== deps.length) return true
    return deps.some((dep, position) => !Object.is(dep, previous[position]))
  }

  const React = {
    createElement (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
      const list = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: list } }
    },
    useState (initial: unknown) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (next: unknown): void => {
        hooks[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks[index]) : next
        dirty = true
      }
      return [hooks[index], set]
    },
    useRef (initial: unknown) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback (fn: unknown, deps?: unknown[]) {
      const index = cursor++
      const differs = changed(index, deps)
      if (!(index in hooks) || differs) hooks[index] = fn
      return hooks[index]
    },
    useEffect (fn: () => unknown, deps?: unknown[]) {
      const index = cursor++
      if (!(index in hooks) || changed(index, deps)) pending.push(fn)
    },
  }

  async function render (component: any, props: unknown): Promise<unknown> {
    for (let pass = 0; pass < 40; pass += 1) {
      cursor = 0
      dirty = false
      pending = []
      const tree = component(props)
      for (const effect of pending) effect()
      await flush()
      if (!dirty) return tree
    }
    throw new Error('the card never settled: it kept setting state after 40 renders')
  }

  return { React, render }
}

/** Visit every node in the stub's tree, elements and text alike. */
function walk (node: unknown, visit: (node: any) => void): void {
  if (typeof node === 'string' || typeof node === 'number') { visit(node); return }
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  walk((node as any).props?.children, visit)
}

/** Every element matching a predicate, in document order. */
function nodesOf (tree: unknown, predicate: (node: Element) => boolean): Element[] {
  const found: Element[] = []
  walk(tree, node => {
    if (typeof node === 'object' && node !== null && !Array.isArray(node) && predicate(node)) found.push(node)
  })
  return found
}

/** The text inside one node, concatenated. */
function textOf (node: unknown): string {
  let text = ''
  walk(node, child => { if (typeof child === 'string') text += child })
  return text
}

/** Every string the card renders, one per line: copy assertions read this. */
function allText (tree: unknown): string {
  let text = ''
  walk(tree, node => { if (typeof node === 'string') text += `${node}\n` })
  return text
}

/** The one button carrying a label. More than one means an ambiguous card. */
function buttonWith (tree: unknown, label: string): Element {
  const found = nodesOf(tree, node => node.type === 'button' && textOf(node).includes(label))
  assert.equal(found.length, 1, `expected exactly one "${label}" button, found ${found.length}`)
  return found[0]!
}

/** The one text input carrying a placeholder. */
function inputWith (tree: unknown, placeholder: string): Element {
  const found = nodesOf(tree, node => node.type === 'input' && node.props.placeholder === placeholder)
  assert.equal(found.length, 1, `expected exactly one input with placeholder "${placeholder}", found ${found.length}`)
  return found[0]!
}

/** Type a value into a stub input the way the browser would. */
function type (input: Element, value: string): void {
  input.props.onChange({ target: { value } })
}

let cachedFactory: ((require: (name: string) => unknown) => any) | undefined

/**
 * Import the card bundle once, capturing the module it registers.
 *
 * The bundle is executed as a real module with `window.__ModuleLoader__` as its
 * only entry point, so this is the same code path the harness runs.
 *
 * @returns the captured factory.
 */
async function factoryOf (): Promise<(require: (name: string) => unknown) => any> {
  if (cachedFactory !== undefined) return cachedFactory
  let captured: unknown
  ;(globalThis as any).window = {
    __ModuleLoader__: { load (descriptor: { factory?: unknown }) { captured = descriptor.factory } },
  }
  await import(`${pathToFileURL(CARD).href}?client-test`)
  assert.equal(typeof captured, 'function', 'client.js did not register a module factory')
  cachedFactory = captured as (require: (name: string) => unknown) => any
  return cachedFactory
}

/** A host that behaves like the seams the card talks to. */
interface CardHarness {
  /** The settled page view. */
  readonly tree: unknown
  /** Every settings write the card made, as the shared form received it. */
  readonly updates: Array<{ ns: string, ops: Array<{ op: string, path: string[], value?: unknown }>, revision: unknown }>
  /** Re-render after a state change, e.g. after typing. */
  rerender: () => Promise<unknown>
}

/**
 * Mount the card against a host holding the given settings.
 *
 * The fake mirrors the real seam's shape: `configForms.get(namespace)` returns a
 * form whose snapshot carries the resolved values, and whose `mutate` applies the
 * operations and bumps the revision exactly as the provider does, so a re-read
 * after a write shows what the host accepted.
 *
 * @param options - the host's settings values, interface language, and the
 *   namespace its mirror serves (the mount row id, which DSH keys it by).
 * @returns the rendered card and its write log.
 */
async function harness (options: { value?: Record<string, unknown>, locale?: string, servedNamespace?: string } = {}): Promise<CardHarness> {
  const { React, render } = createReact()
  const updates: CardHarness['updates'] = []
  const served = options.servedNamespace ?? NS
  const store = {
    value: {
      enabled: true,
      apiKeyEnv: 'TYPESAFE_API_KEY',
      baseUrl: 'https://api.typesafe.ai',
      model: 'jev-latest',
      prune: { enabled: true },
      suggest: { enabled: true },
      ...(options.value ?? {}),
    } as Record<string, unknown>,
    revision: 7,
  }
  const listeners = new Set<() => void>()

  /** Apply one `set` operation to the fake document. */
  function applyOp (op: { path: string[], value?: unknown }): void {
    let node = store.value
    for (const key of op.path.slice(0, -1)) {
      const child = node[key]
      node = (child !== null && typeof child === 'object' ? child : (node[key] = {})) as Record<string, unknown>
    }
    node[op.path[op.path.length - 1]!] = op.value
  }

  /** The one shared form this namespace resolves to. */
  const form = {
    // The host serves the namespace under its mount row id; a profile that mounts
    // it elsewhere leaves the form with no value, which is the state the card has
    // to name rather than draw as an empty form.
    getSnapshot: () => served === NS
      ? { status: 'ready', value: { ...store.value }, revision: store.revision, writable: true }
      : { status: 'ready', value: undefined, revision: undefined, writable: true },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field: string, value: unknown) => form.mutate([{ op: 'set', path: [field], value }]),
    mutate: async (ops: Array<{ op: string, path: string[], value?: unknown }>, revision?: unknown) => {
      updates.push({ ns: NS, ops, revision })
      for (const op of ops) applyOp(op)
      store.revision += 1
      for (const listener of listeners) listener()
      return true
    },
  }

  let card: any
  const ctx = {
    locale: { getLocale: () => ({ active: options.locale ?? 'zh' }) },
    configForms: {
      get: (_ns: string) => form,
      describe: () => ({
        getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: served }] } }),
      }),
    },
    remote: {
      credentials: {
        describe: async (refs: string[]) => ({
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
        }),
        set: async () => {},
      },
    },
    slots: {
      inject: (_key: string, callback: () => void) => { callback() },
      register: (_registration: unknown, component: unknown) => { card = component },
    },
  }

  const factory = await factoryOf()
  factory((name: string) => {
    if (name === 'react') return React
    throw new Error(`the card required an unexpected module: ${name}`)
  }).apply(ctx)
  assert.ok(card !== undefined, 'the card did not register into plugins.bundle.config')

  return {
    tree: await render(card, { view: 'page' }),
    updates,
    rerender: () => render(card, { view: 'page' }),
  }
}

test('the card exposes the judgment endpoint and model the host resolves', async () => {
  const page = await harness()
  // Before the fix these two fields did not exist, so a GUI user could only set
  // them by restarting the host with an edited composition entry.
  assert.equal(inputWith(page.tree, 'https://api.typesafe.ai').props.value, 'https://api.typesafe.ai')
  assert.equal(inputWith(page.tree, 'jev-latest').props.value, 'jev-latest')
  assert.match(allText(page.tree), /判定端点/)
})

test('an edit reaches the settings seam with the revision the host reported', async () => {
  const page = await harness()
  type(inputWith(page.tree, 'https://api.typesafe.ai'), 'https://openrouter.ai/api')
  const tree = await page.rerender()

  const save = buttonWith(tree, '保存端点')
  assert.equal(save.props.disabled, false, 'a changed endpoint must be writable')
  save.props.onClick()
  await flush()

  // Only the changed field: writing the untouched model would turn reading the
  // card into an override that pins the value against future default changes.
  assert.deepEqual(page.updates, [
    { ns: 'dsh-jev-tools', ops: [{ op: 'set', path: ['baseUrl'], value: 'https://openrouter.ai/api' }], revision: 7 },
  ])

  // The host is re-read after the write, and the card then says where content goes.
  const settled = await page.rerender()
  assert.match(allText(settled), /端点已保存/)
  assert.match(allText(settled), /openrouter\.ai 进行判定/)

  // A capability toggle rides the same seam with an operation path, which is what
  // lets one write carry `prune.enabled` without restating the rest of `prune` —
  // and the shared form serializes it with every other editor of this entry.
  const toggles = nodesOf(settled, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(toggles.length, 3, 'the card draws exactly the three capability toggles')
  toggles[1]!.props.onChange({ target: { checked: false } })
  await flush()
  assert.deepEqual(page.updates.at(-1), {
    ns: 'dsh-jev-tools',
    ops: [{ op: 'set', path: ['prune', 'enabled'], value: false }],
    revision: 8,
  })
})

test('an untouched endpoint is never written', async () => {
  const page = await harness()
  const save = buttonWith(page.tree, '保存端点')
  assert.equal(save.props.disabled, true, 'nothing changed, so there is nothing to save')
  save.props.onClick()
  await flush()
  assert.deepEqual(page.updates, [])
})

test('an address that is not an absolute http(s) root is rejected with a reason', async () => {
  const page = await harness()
  type(inputWith(page.tree, 'https://api.typesafe.ai'), 'openrouter.ai/api')
  let tree = await page.rerender()

  assert.equal(buttonWith(tree, '保存端点').props.disabled, true)
  assert.match(allText(tree), /http:\/\/ 或 https:\/\//)
  assert.deepEqual(page.updates, [], 'a rejected draft must not reach the settings seam')

  // Blank is the same failure one step later: an empty root would POST to a
  // relative URL, and that failure is invisible everywhere else.
  type(inputWith(tree, 'https://api.typesafe.ai'), '   ')
  tree = await page.rerender()
  assert.equal(buttonWith(tree, '保存端点').props.disabled, true)

  // So is a blank model.
  type(inputWith(tree, 'https://api.typesafe.ai'), 'https://openrouter.ai/api')
  type(inputWith(tree, 'jev-latest'), '')
  tree = await page.rerender()
  assert.equal(buttonWith(tree, '保存端点').props.disabled, true)
  assert.match(allText(tree), /模型不能为空/)
  assert.deepEqual(page.updates, [])
})

test('the endpoint decides where content goes and where a key comes from', async () => {
  const vendor = await harness()
  const vendorLinks = nodesOf(vendor.tree, node => node.type === 'a')
  assert.equal(vendorLinks.length, 1)
  assert.equal(vendorLinks[0]!.props.href, 'https://console.typesafe.ai/keys')
  assert.match(allText(vendor.tree), /api\.typesafe\.ai 进行判定/)

  // OpenRouter issues its own keys, so neither the link nor the privacy line
  // may keep naming the vendor's host.
  const openRouter = await harness({ value: { baseUrl: 'https://openrouter.ai/api' } })
  const links = nodesOf(openRouter.tree, node => node.type === 'a')
  assert.equal(links[0]!.props.href, 'https://openrouter.ai/settings/keys')
  assert.match(allText(openRouter.tree), /openrouter\.ai 进行判定/)
})

test('the endpoint fields are worded in both languages', async () => {
  const en = await harness({ locale: 'en' })
  assert.match(allText(en.tree), /Judgment endpoint/)
  assert.match(allText(en.tree), /Service address/)
  assert.equal(buttonWith(en.tree, 'Save endpoint').props.disabled, true)
})

test('a namespace the host does not publish is named, not drawn as an empty form', async () => {
  // DSH publishes a bundle's settings namespace under its **mount row id**, while
  // this card addresses the bundle by package name. Mounted as `jev-tools` the
  // two disagreed for eleven releases, and the card rendered a form that looked
  // exactly like "nothing is configured": every toggle disabled, both endpoint
  // fields blank, not one word about why. Naming the missing namespace — and the
  // ones the host does serve — is what turns that silence into a diagnosis.
  const page = await harness({ locale: 'en', servedNamespace: 'jev-tools' })

  assert.match(allText(page.tree), /dsh-jev-tools/, 'the card must name the namespace it looked for')
  assert.match(allText(page.tree), /cordis\.patch\.yml/, 'and the file that decides it')
  assert.match(allText(page.tree), /host serves: jev-tools/, 'and what the host does serve')
  assert.equal(buttonWith(page.tree, 'Save endpoint').props.disabled, true)
  assert.deepEqual(page.updates, [], 'an unreadable namespace must not enable writes')
})
