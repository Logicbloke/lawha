import { describe, expect, it } from 'vitest'
import { DICTS, en, translate, type TKey } from '../src/ui/i18n'
import { LANGS } from '../src/state/store'

describe('i18n', () => {
  it('every language covers every key, with the same plural shape', () => {
    for (const lang of LANGS) {
      const dict = DICTS[lang]
      for (const key of Object.keys(en) as TKey[]) {
        expect(dict[key], `${lang}.${key}`).toBeDefined()
        expect(typeof dict[key] === 'string', `${lang}.${key} plural shape`).toBe(typeof en[key] === 'string')
      }
      expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort())
    }
  })

  it('keeps {placeholders} intact in translations', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const lang of LANGS) {
      for (const key of Object.keys(en) as TKey[]) {
        const src = en[key]
        const dst = DICTS[lang][key]
        const a = typeof src === 'string' ? src : src.other
        const b = typeof dst === 'string' ? dst : dst.other
        expect(vars(b), `${lang}.${key}`).toEqual(vars(a))
      }
    }
  })

  it('picks plural forms per language', () => {
    expect(translate('en', 'nCards', { n: 1 })).toBe('1 card')
    expect(translate('en', 'nCards', { n: 3 })).toBe('3 cards')
    expect(translate('ar', 'nCards', { n: 2 })).toBe('بطاقتان')
    expect(translate('ar', 'nCards', { n: 5 })).toContain('بطاقات')
    expect(translate('ar', 'nCards', { n: 11 })).toContain('بطاقة')
    expect(translate('fr', 'nMembers', { n: 2 })).toBe('2 membres')
  })
})
