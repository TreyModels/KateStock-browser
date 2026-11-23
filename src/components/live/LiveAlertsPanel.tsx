import { BellOff, BellRing, CheckCheck, X } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { phaseLabel } from '@/lib/live'
import type { AlertEvent, MarketPhase } from '@/types'
import { alertKindLabel, formatBeijingClock, isLivePricePhase } from './quote-utils'

export interface LiveAlertsPanelProps {
  alerts: AlertEvent[]
  dismiss: (id: string) => void
  clear: () => void
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => Promise<void>
  soundEnabled: boolean
  toggleSound: () => void
  phase: MarketPhase
  /** 个人清单已生成的策略数；为 0 时提醒不可能有内容，需要在空状态里说明 */
  strategyCount: number
  /** 各策略是否持仓（与 evaluateLive 同源）；用于在提醒上标注持仓语义 */
  holdingByCode?: Record<string, boolean>
}

const price = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : '—')

/**
 * 盘中提醒面板：命中提醒列表 + 单条忽略 + 全部清空 + 浏览器通知权限 + 提示音开关。
 * 空状态按当前时段给出解释，避免用户误以为「没有提醒 = 功能坏了」。
 */
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
  const liveNow = isLivePricePhase(phase)
  const hasStrategies = strategyCount > 0
  const permissionText = permission === 'granted'
    ? '通知已开启'
    : permission === 'denied'
      ? '通知被浏览器拒绝'
      : permission === 'unsupported'
        ? '浏览器不支持通知'
        : '开启浏览器通知'
  const canRequest = permission === 'default'

  return (
    <section className="live-alerts-panel" aria-labelledby="live-alerts-title">
      <div className="live-alerts-heading">
        <div>
          <span className="section-kicker">INTRADAY ALERTS</span>
          <h2 id="live-alerts-title">盘中提醒{alerts.length > 0 && <span className="alert-count">{alerts.length}</span>}</h2>
        </div>
        <BellRing size={20} aria-hidden="true" />
      </div>

      <div className="live-alerts-tools">
        <button
          type="button"
          className="button-secondary alert-permission"
          onClick={() => void requestPermission()}
          disabled={!canRequest}
          title={permission === 'denied' ? '请在浏览器站点权限中重新允许通知' : undefined}
        >
          <BellRing size={15} aria-hidden="true" />
          {permissionText}
        </button>
        <label className="live-switch">
          <Switch className="live-switch-control" checked={soundEnabled} onCheckedChange={() => toggleSound()} aria-label="提醒提示音" />
          <span>{soundEnabled ? '提示音已开' : '提示音已关'}</span>
        </label>
      </div>
      {permission === 'denied' && (
        <p className="live-alerts-hint">浏览器已拒绝通知，可在站点权限设置中重新允许；页面内提醒不受影响。</p>
      )}

      {alerts.length > 0 ? (
        <>
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className={`alert-item alert-${alert.kind}`}>
                <div className="alert-item-main">
                  <div className="alert-item-top">
                    <span className="alert-kind">{alertKindLabel[alert.kind]}</span>
                    {holdingByCode[alert.code] && <span className="alert-holding">持仓</span>}
                    <strong>{alert.name || alert.code}</strong>
                    <span className="code-label">{alert.code}</span>
                    <time dateTime={alert.at}>{formatBeijingClock(alert.at)}</time>
                  </div>
                  <p className="alert-item-message">{alert.message}</p>
                  <div className="alert-item-levels">
                    <span>价位 <b>{price(alert.level)}</b></span>
                    <span>现价 <b>{price(alert.price)}</b></span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button subtle alert-dismiss"
                  onClick={() => dismiss(alert.id)}
                  aria-label={`忽略${alert.name || alert.code}的${alertKindLabel[alert.kind]}提醒`}
                >
                  <X size={17} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="text-button alert-clear" onClick={clear}>
            <CheckCheck size={15} aria-hidden="true" />全部清空
          </button>
        </>
      ) : (
        <div className="live-alerts-empty">
          <BellOff size={24} aria-hidden="true" />
          <p>
            {!hasStrategies
              ? '提醒只针对个人清单：请先在「股票」页添加自选或持仓，生成策略价位后才会提醒。公开清单只有收盘信号、没有触发/保护/目标价位，不会产生提醒。'
              : liveNow
                ? '暂无盘中提醒。价格触及触发价、保护位或目标位时会自动记录在这里。'
                : `当前为${phaseLabel(phase)}时段，盘中提醒暂停；交易时段内价格触及规则价位才会提醒。`}
          </p>
        </div>
      )}

      <p className="live-alerts-foot">提醒语义：持仓策略只提醒保护位/目标位，非持仓策略只提醒买入触发，观望策略不提醒。提醒基于公开行情与规则价位，可能延迟或误报；同一天同一类提醒只记录一次，不构成投资建议。</p>
    </section>
  )
}
