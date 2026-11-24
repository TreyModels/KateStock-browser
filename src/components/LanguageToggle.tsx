import { LANGS, useI18n } from '@/lib/i18n'

/** 语言切换分段按钮（中文 | English），44px 触控，即时生效并持久化。 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n()
  return (
    <div className={`lang-toggle${className ? ` ${className}` : ''}`} role="group" aria-label={t('lang.switch')}>
      {LANGS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={lang === item.id ? 'active' : ''}
          aria-pressed={lang === item.id}
          onClick={() => setLang(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
