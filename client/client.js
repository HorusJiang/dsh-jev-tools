/**
 * dsh-jev-tools browser half: the bundle's own configuration card.
 *
 * Hand-written lazy-CJS bundle (`window.__ModuleLoader__.load`), no build step,
 * no imports beyond React — deliberately so, because the npm-published
 * `@deepseek-ai/dsh-*` packages lag the running harness badly and requiring one
 * would couple this plugin to a stale signature.
 *
 * It renders into `plugins.bundle.config`, the purpose-built seat for a
 * bundle's own configuration, keyed by the bundle's package name.
 *
 * The card follows the DSH language: it reads the client locale service and
 * re-renders when that changes. (The host half cannot do this — the locale
 * service is client-only — so it infers the language from the conversation
 * instead. See `src/i18n.ts`.)
 *
 * Two seams carry the data, both already present in the harness:
 *   - `remote.credentials` answers only whether a key is configured, its
 *     source, and whether it is writable. The secret literal never rides a
 *     response; the input starts blank on every load.
 *   - `remote.settings` reads and writes this plugin's own namespace, so the
 *     capability toggles are the same values the host resolves.
 *
 * @module dsh-jev-tools/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-jev-tools',
  factory: (require) => {
    /** Settings namespace owned by the host half. */
    const NS = 'dsh-jev-tools'
    /** Where a user creates a TypeSafe API key. */
    const KEYS_URL = 'https://console.typesafe.ai/keys'
    /** Credential reference used when the settings name none. */
    const DEFAULT_REF = 'TYPESAFE_API_KEY'

    /** Every user-facing string, in both languages. */
    const S = {
      zh: {
        heading: '自动精简工具输出、自动推荐技能',
        status: '状态',
        reading: '读取中…',
        configured: (source) => `已配置（来源：${source}）`,
        unconfigured: '未配置',
        intro: '还没有 API key。到 TypeSafe 控制台 创建一个，然后粘贴到下面。',
        getKey: '获取 API key →',
        keyPlaceholder: (ref) => `粘贴 ${ref}`,
        keyPlaceholderSet: '已配置，粘贴新值可覆盖',
        save: '保存',
        saved: '已保存。',
        readFailed: (error) => `读取配置失败：${error}`,
        saveFailed: (error) => `保存失败：${error}`,
        noCredentialService: '凭据服务不可用，无法保存。可改用环境变量方式配置。',
        noSettingsService: '设置服务不可用。',
        readonlyRef: (ref) => `环境变量 ${ref} 由只读来源提供，无法在界面上覆盖。要修改请改动它的来源。`,
        toggleMaster: '启用插件',
        togglePrune: '精简超长的工具输出',
        toggleSuggest: '推荐该用的技能',
        privacy: '隐私：启用后，被精简掉的工具输出内容会发送到 api.typesafe.ai 进行判定；'
          + '推荐技能时只发送当前请求与技能名称、描述。密钥保存在本机凭据存储中，不会回显。'
          + '没配 key 时两项能力完全不生效、不发任何网络请求。',
        ledger: '判定台账只记元数据（token 数、段数、作答版本、跳过原因），不含任何提示词或工具输出正文，'
          + '且只留在本机。有 storage 时持久化到 $DSH_HOME/storages，重启后累计数字不丢。',
        summary: (status) => `Jev · ${status}`,
        unknownSource: '未知',
      },
      en: {
        heading: 'Prunes long tool output, suggests which skill to use',
        status: 'Status',
        reading: 'reading…',
        configured: (source) => `configured (source: ${source})`,
        unconfigured: 'not configured',
        intro: 'No API key yet. Create one in the TypeSafe console, then paste it below.',
        getKey: 'Get an API key →',
        keyPlaceholder: (ref) => `paste ${ref}`,
        keyPlaceholderSet: 'configured — paste a new value to replace it',
        save: 'Save',
        saved: 'Saved.',
        readFailed: (error) => `Could not read settings: ${error}`,
        saveFailed: (error) => `Save failed: ${error}`,
        noCredentialService: 'The credentials service is unavailable, so the key cannot be stored here. Use an environment variable instead.',
        noSettingsService: 'The settings service is unavailable.',
        readonlyRef: (ref) => `${ref} comes from a read-only source and cannot be overridden here; change that source instead.`,
        toggleMaster: 'Enable the plugin',
        togglePrune: 'Prune oversized tool output',
        toggleSuggest: 'Suggest which skill to use',
        privacy: 'Privacy: once enabled, the tool output that gets pruned is sent to api.typesafe.ai for judging; '
          + 'skill suggestions send only the current request plus skill names and descriptions. '
          + 'The key is stored in this machine\u2019s credential store and is never echoed back. '
          + 'With no key configured both capabilities are completely inert and make no network request.',
        ledger: 'The judgment ledger records metadata only — token counts, segment counts, the version that '
          + 'answered, and why a judgment was skipped. No prompt or tool-output text, and it never leaves this '
          + 'machine. With a storage domain it persists under $DSH_HOME/storages, so the cumulative numbers '
          + 'survive a restart.',
        summary: (status) => `Jev · ${status}`,
        unknownSource: 'unknown',
      },
    }

    /** The active language, from the client locale service. */
    function langOf (ctx) {
      try {
        const locale = ctx.locale
        if (locale === undefined || typeof locale.getLocale !== 'function') return 'en'
        const snapshot = locale.getLocale()
        const active = snapshot !== null && snapshot !== undefined ? snapshot.active : undefined
        return typeof active === 'string' && active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /**
     * Build the card component bound to one client context.
     *
     * @param {object} React - the browser module table's React.
     * @param {object} ctx - the client plugin context.
     * @returns {Function} the card component.
     */
    function makeCard (React, ctx) {
      const h = React.createElement

      /** Read one remote namespace defensively: absent services are not errors. */
      function remote (path) {
        const parts = path.split('.')
        let node = ctx
        for (const part of parts) {
          if (node === undefined || node === null) return undefined
          node = node[part]
        }
        return node
      }

      /** Resolve a RemoteResult to its value, or undefined on any failure. */
      function valueOf (response) {
        if (response === undefined || response === null) return undefined
        if (response.ok === false) return undefined
        return response.value
      }

      /** Normalise `settings.describe()` output: an array or `{namespaces}`. */
      function namespacesOf (described) {
        if (Array.isArray(described)) return described
        if (described !== null && typeof described === 'object' && Array.isArray(described.namespaces)) {
          return described.namespaces
        }
        return []
      }

      /** Hidden characters without being a password field, so the key stays out of keychain offers. */
      function maskedProps () {
        const props = { autoComplete: 'off' }
        if (typeof CSS !== 'undefined' && 'textSecurity' in document.documentElement.style) {
          props.style = { textSecurity: 'disc', WebkitTextSecurity: 'disc' }
        } else {
          props.type = 'password'
        }
        return props
      }

      const MUTED = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))'
      const ACCENT = 'var(--dsw-alias-accent, #4f8cff)'
      const TEXT = 'var(--dsw-alias-label-primary, inherit)'
      const BORDER = 'var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))'

      function row (label, value) {
        return h('div', { style: { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: '18px' } },
          h('span', { style: { color: MUTED, minWidth: '76px' } }, label),
          h('span', { style: { color: TEXT } }, value))
      }

      function toggle (label, checked, disabled, onChange) {
        return h('label', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 },
        },
        h('input', {
          type: 'checkbox', checked: checked === true, disabled: disabled === true,
          onChange: (event) => { onChange(event.target.checked) },
        }),
        h('span', { style: { color: TEXT } }, label))
      }

      const link = (href, text) => h('a', {
        href, target: '_blank', rel: 'noreferrer',
        style: { color: ACCENT, fontSize: '12px', textDecoration: 'none' },
      }, text)

      /**
       * The card.
       *
       * @param {{ view?: 'summary' | 'page' }} props - `summary` renders the
       *   one-liner alone; `page` renders the full form with its save control.
       */
      return function JevCard (props) {
        const view = props !== null && props !== undefined && props.view === 'summary' ? 'summary' : 'page'
        const [lang, setLang] = React.useState(() => langOf(ctx))
        const [settings, setSettings] = React.useState(null)
        const [revision, setRevision] = React.useState(undefined)
        const [credential, setCredential] = React.useState(null)
        const [draft, setDraft] = React.useState('')
        const [note, setNote] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const t = S[lang]

        // Follow the DSH language: re-render whenever the locale changes.
        React.useEffect(() => {
          const locale = ctx.locale
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(() => { setLang(langOf(ctx)) })
        }, [])

        const ref = settings !== null && typeof settings.apiKeyEnv === 'string' && settings.apiKeyEnv !== ''
          ? settings.apiKeyEnv
          : DEFAULT_REF

        /** Re-read both seams. Never throws: a failure becomes a visible note. */
        const load = React.useCallback(async () => {
          try {
            const settingsApi = remote('remote.settings')
            if (settingsApi !== undefined) {
              const described = valueOf(await settingsApi.describe())
              const mine = namespacesOf(described).find((entry) => entry !== null && entry !== undefined && entry.ns === NS)
              if (mine !== undefined) {
                setSettings(mine.value ?? null)
                setRevision(mine.revision)
              }
            }
            const credentialsApi = remote('remote.credentials')
            if (credentialsApi !== undefined) {
              const described = valueOf(await credentialsApi.describe([ref]))
              const info = described !== null && described !== undefined ? described[ref] : undefined
              setCredential(info ?? { configured: false, writable: true })
            } else {
              setCredential({ configured: false, writable: true, unavailable: true })
            }
          } catch (error) {
            setNote(S[langOf(ctx)].readFailed(String(error)))
          }
        }, [ref])

        React.useEffect(() => {
          if (settings === null && credential === null) void load()
        }, [settings, credential, load])

        /** Write the staged key, then re-read: the host is the only authority on whether it landed. */
        const saveKey = React.useCallback(async () => {
          if (draft === '') return
          setBusy(true)
          setNote('')
          const strings = S[langOf(ctx)]
          try {
            const credentialsApi = remote('remote.credentials')
            if (credentialsApi === undefined) {
              setNote(strings.noCredentialService)
              return
            }
            await credentialsApi.set(ref, draft)
            setDraft('')
            await load()
            setNote(strings.saved)
          } catch (error) {
            setNote(strings.saveFailed(String(error)))
          } finally {
            setBusy(false)
          }
        }, [draft, ref, load])

        /** Patch one top-level settings field. */
        const patch = React.useCallback(async (change) => {
          setBusy(true)
          setNote('')
          try {
            const settingsApi = remote('remote.settings')
            if (settingsApi === undefined) {
              setNote(S[langOf(ctx)].noSettingsService)
              return
            }
            await settingsApi.update(NS, change, revision)
            await load()
          } catch (error) {
            setNote(S[langOf(ctx)].saveFailed(String(error)))
          } finally {
            setBusy(false)
          }
        }, [revision, load])

        const configured = credential !== null && credential.configured === true
        const status = credential === null
          ? t.reading
          : configured
            ? t.configured(credential.source ?? t.unknownSource)
            : t.unconfigured

        if (view === 'summary') {
          return h('div', { style: { fontSize: '12px', color: MUTED } }, t.summary(status))
        }

        const pruneOn = settings !== null && settings.prune !== undefined && settings.prune.enabled === true
        const suggestOn = settings !== null && settings.suggest !== undefined && settings.suggest.enabled === true
        const masterOn = settings !== null && settings.enabled === true
        const writable = credential === null || credential.writable !== false

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' } },
          h('div', { style: { fontSize: '13px', fontWeight: 600, color: TEXT } }, t.heading),

          row(t.status, status),
          configured ? null : h('div', { style: { fontSize: '12px', color: MUTED } }, t.intro),
          h('div', { style: { fontSize: '12px' } }, link(KEYS_URL, t.getKey)),

          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', Object.assign({
              value: draft,
              placeholder: configured ? t.keyPlaceholderSet : t.keyPlaceholder(ref),
              disabled: busy || !writable,
              onChange: (event) => { setDraft(event.target.value) },
              style: { flex: 1, minWidth: 0, fontSize: '12px', padding: '6px 8px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT },
            }, maskedProps())),
            h('button', {
              type: 'button',
              disabled: busy || draft === '' || !writable,
              onClick: () => { void saveKey() },
              style: { fontSize: '12px', padding: '6px 12px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT, cursor: busy || draft === '' ? 'default' : 'pointer' },
            }, t.save)),
          writable ? null : h('div', { style: { fontSize: '11px', color: MUTED } }, t.readonlyRef(ref)),

          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px', borderTop: `1px solid ${BORDER}` } },
            toggle(t.toggleMaster, masterOn, busy || settings === null, (next) => { void patch({ enabled: next }) }),
            toggle(t.togglePrune, pruneOn, busy || settings === null, (next) => { void patch({ prune: { enabled: next } }) }),
            toggle(t.toggleSuggest, suggestOn, busy || settings === null, (next) => { void patch({ suggest: { enabled: next } }) })),

          h('div', { style: { fontSize: '11px', color: MUTED, lineHeight: '16px' } }, t.privacy),

          h('div', { style: { fontSize: '11px', color: MUTED, lineHeight: '16px' } }, t.ledger),

          note === '' ? null : h('div', { style: { fontSize: '11px', color: MUTED } }, note))
      }
    }

    return {
      // `remote` is injected alongside its namespaces, matching how the shipped
      // settings plugins declare the same dependencies. `locale` drives the
      // card's language.
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings'],
      /**
       * Register the card into the bundle-configuration seat.
       *
       * @param {object} ctx - the client plugin context.
       */
      apply (ctx) {
        const slots = ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') return
        const React = require('react')
        const Card = makeCard(React, ctx)
        slots.inject('plugins.bundle.config', () => slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-jev-tools',
        }, Card))
      },
    }
  },
})
