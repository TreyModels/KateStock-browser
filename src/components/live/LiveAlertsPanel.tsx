import { BellOff, BellRing, CheckCheck, X } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/lib/i18n'
import type { AlertEvent, MarketPhase } from '@/types'
import { formatBeijingClock, isLivePricePhase } from './quote-utils'

export interface LiveAlertsPanelProps {
  alerts: AlertEvent[]
  dismiss: (id: string) => void
  clear: () => void
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => Promise<void>
  soundEnabled: boolean
  toggleSound: () => void
  phase: MarketPhase
  strategyCount: number
  holdingByCode?: Record<string, boolean>
}

const price = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : '—')

export function LiveAlertsPanel({
  alerts,
  dismiss,
  clear,
  permission,
  requestPermission,
  soundEnabled,
  toggleSound,
  phase,
  strategyCount,
  holdingByCode = {},
}: LiveAlertsPanelProps) {
  const { t } = useI18n()
  const liveNow = isLivePricePhase(phase)
  const hasStrategies = strategyCount > 0
  const permissionText = permission === 'granted'
    ? t('alerts.notifyOn')
    : permission === 'denied'
      ? t('alerts.notifyDenied')
      : permission === 'unsupported'
        ? t('alerts.notifyUnsupported')
        : t('alerts.notifyEnable')
  const canRequest = permission === 'default'
  const kindLabel = (kind: AlertEvent['kind']) => t(`alerts.kind.${kind}`)

  return (
    <section className="live-alerts-panel" aria-labelledby="live-alerts-title">
      <div className="live-alerts-heading">
        <div>
          <span className="section-kicker">{t('alerts.kicker')}</span>
          <h2 id="live-alerts-title">{t('alerts.title')}{alerts.length > 0 && <span className="alert-count">{alerts.length}</span>}</h2>
        </div>
        <BellRing size={20} aria-hidden="true" />
      </div>

      <div className="live-alerts-tools">
        <button
          type="button"
          className="button-secondary alert-permission"
          onClick={() => void requestPermission()}
          disabled={!canRequest}
          title={permission === 'denied' ? t('alerts.notifyHint') : undefined}
        >
          <BellRing size={15} aria-hidden="true" />
          {permissionText}
        </button>
        <label className="live-switch">
          <Switch className="live-switch-control" checked={soundEnabled} onCheckedChange={() => toggleSound()} aria-label={t('alerts.soundOn')} />
          <span>{soundEnabled ? t('alerts.soundOn') : t('alerts.soundOff')}</span>
        </label>
      </div>
      {permission === 'denied' && <p className="live-alerts-hint">{t('alerts.notifyHint')}</p>}

      {alerts.length > 0 ? (
        <>
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className={`alert-item alert-${alert.kind}`}>
                <div className="alert-item-main">
                  <div className="alert-item-top">
                    <span className="alert-kind">{kindLabel(alert.kind)}</span>
                    {holdingByCode[alert.code] && <span className="alert-holding">{t('alerts.holding')}</span>}
                    <strong>{alert.name || alert.code}</strong>
                    <span className="code-label">{alert.code}</span>
                    <time dateTime={alert.at}>{formatBeijingClock(alert.at)}</time>
                  </div>
                  <p className="alert-item-message">{alert.message}</p>
                  <div className="alert-item-levels">
                    <span>{t('alerts.level')} <b>{price(alert.level)}</b></span>
                    <span>{t('alerts.price')} <b>{price(alert.price)}</b></span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button subtle alert-dismiss"
                  onClick={() => dismiss(alert.id)}
                  aria-label={`${t('common.dismiss')} ${alert.name || alert.code} ${kindLabel(alert.kind)}`}
                >
                  <X size={17} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="text-button alert-clear" onClick={clear}>
            <CheckCheck size={15} aria-hidden="true" />{t('alerts.clearAll')}
          </button>
        </>
      ) : (
        <div className="live-alerts-empty">
          <BellOff size={24} aria-hidden="true" />
          <p>
            {!hasStrategies
              ? t('alerts.emptyNoList')
              : liveNow
                ? t('alerts.emptyLive')
                : t('alerts.emptyPaused', { phase: t(`phase.${phase}`) })}
          </p>
        </div>
      )}

      <p className="live-alerts-foot">{t('alerts.foot')}</p>
    </section>
  )
}
