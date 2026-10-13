import { LANGS, setLang, useApp, type Lang } from '../state/store'
import { useT } from './i18n'

/** Each language is named in itself, so anyone can find their own. */
const NATIVE: Record<Lang, string> = {
  en: 'English',
  sv: 'Svenska',
  es: 'Español',
  fr: 'Français',
  ar: 'العربية',
}

export function LangPicker() {
  const lang = useApp((s) => s.lang)
  const t = useT()
  return (
    <select
      className="lang-picker"
      value={lang}
      aria-label={t('language')}
      onChange={(e) => setLang(e.target.value as Lang)}
    >
      {LANGS.map((l) => (
        <option key={l} value={l} lang={l}>
          {NATIVE[l]}
        </option>
      ))}
    </select>
  )
}
