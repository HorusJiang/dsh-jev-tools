/**
 * Language detection and the message catalog.
 *
 * The load-bearing test is the bilingual balance check: a missing English entry
 * is invisible at runtime (the key itself renders, which looks like a bug in
 * the plugin), so it has to fail here instead.
 *
 * @module dsh-jev-tools/test/i18n
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MESSAGE_KEYS, detectLang, resolveLang, t } from '../lib/i18n.js'
import { skipMessage, reasonFromFailure } from '../lib/degrade.js'

test('the catalog is balanced across both languages', () => {
  assert.ok(MESSAGE_KEYS.length > 40, `only ${MESSAGE_KEYS.length} keys — did a group get dropped?`)
  for (const key of MESSAGE_KEYS) {
    for (const lang of ['zh', 'en'] as const) {
      const text = t(lang, key)
      assert.notEqual(text, key, `${key} has no ${lang} entry`)
      assert.ok(text.trim().length > 0, `${key} is empty in ${lang}`)
    }
  }
})

test('no catalog entry is accidentally left in the other language', () => {
  // Catches the common slip of pasting the Chinese string into the English slot.
  const han = /[\u4e00-\u9fff]/
  for (const key of MESSAGE_KEYS) {
    assert.equal(han.test(t('en', key)), false, `${key} contains Chinese in its English entry`)
  }
})

test('language is inferred from the conversation', () => {
  assert.equal(detectLang('帮我把这些反馈分类'), 'zh')
  assert.equal(detectLang('classify these tickets'), 'en')
  // Nothing said yet: English is the safer default for a model-facing runtime.
  assert.equal(detectLang(undefined), 'en')
  assert.equal(detectLang('   '), 'en')
  // Mixed input follows the CJK present, which is the common real case.
  assert.equal(detectLang('帮我改一下 foo.ts'), 'zh')
})

test('an explicit preference overrides detection', () => {
  assert.equal(resolveLang('en', '帮我改一下'), 'en')
  assert.equal(resolveLang('zh', 'fix the bug'), 'zh')
  assert.equal(resolveLang('auto', '帮我改一下'), 'zh')
  assert.equal(resolveLang('auto', 'fix the bug'), 'en')
})

test('placeholders are substituted, not left in the output', () => {
  const zh = t('zh', 'prune.notice', { summary: 'read: 100 → 40 tokens' })
  const en = t('en', 'prune.notice', { summary: 'read: 100 → 40 tokens' })
  assert.equal(zh.includes('{summary}'), false)
  assert.equal(en.includes('{summary}'), false)
  assert.match(zh, /read: 100 → 40 tokens/)
  assert.match(en, /read: 100 → 40 tokens/)
})

test('an unknown key renders as itself rather than throwing', () => {
  assert.equal(t('en', 'no.such.key' as never), 'no.such.key')
})

test('every skip reason has wording in both languages', () => {
  for (const reason of ['disabled', 'no-key', 'too-small', 'no-task', 'task-too-vague', 'budget-turn'] as const) {
    for (const lang of ['zh', 'en'] as const) {
      const text = skipMessage(reason, lang)
      assert.notEqual(text, `skip.${reason}`, `${reason} is missing from the ${lang} catalog`)
    }
  }
})

test('an unrecognised backend failure becomes the generic reason', () => {
  assert.equal(reasonFromFailure('rate-limited'), 'rate-limited')
  assert.equal(reasonFromFailure('something-new'), 'unknown')
  assert.equal(reasonFromFailure(undefined), 'unknown')
})
