import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AlertEvent, LiveQuote, Strategy } from '@/types'
import {
  canNotify,
  getNotificationScope,
  loadAlertState,
  notificationPermission,
  saveAlertState,
  scanAlerts,
  type AlertState,
  type NotificationAvailability,
  type NotificationConstructor,
  type NotificationScope,
} from '@/lib/alerts'

/**
 * 盘中提醒 hook（signals-alerts 负责人实现）。
 * 输入：策略列表 + 盘中报价；输出：已触发提醒、通知权限、免打扰开关。
 *
 * 要点：
 * - 只在 auction / trading 生效：scanAlerts 用消费时刻的墙钟相位 getMarketPhase(now) 判定，
 *   不信任 quote.phase（请求发起时的快照，跨 11:30 / 15:00 边界可能已过期）。
 * - 提醒语义按策略动作分级：非持仓（breakout/pullback/watch）只提示买入触发；持仓（hold/reduce/stop）
 *   才提示保护位失守/目标到达（见 live-signals.ts 的 action 推断说明）。
 * - 去重键 AlertEvent.id = `${code}:${kind}:${tradeDate}`：同一交易日同一信号只提醒一次（当天一次），
 *   5 分钟 (code,kind) 节流仅作兜底防抖。
 * - 已见集合持久化 localStorage；解析失败静默降级。
 * - React 19 StrictMode 下 effect 会跑两次：用 ref 保存「已消费的状态」，
 *   第二次扫描不会重复产出同一批事件；sonner toast 再用 event.id 兜底去重。
 * - 浏览器 Notification、WebAudio 提示音均「尽力而为」，缺失/失败静默降级。
 */
export interface UseLiveAlertsResult {
  alerts: AlertEvent[]
  dismiss: (id: string) => void
  clear: () => void
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => Promise<void>
  soundEnabled: boolean
  toggleSound: () => void
}

const TOAST_DESCRIPTIONS: Record<AlertEvent['kind'], string> = {
  stop: '保护位失守，按纪律执行',
  target: '目标位到达，考虑分批止盈',
  trigger: '买入条件成立，核对计划再执行',
}

function showToast(event: AlertEvent): void {
  try {
    const description = `${event.code} · ${TOAST_DESCRIPTIONS[event.kind]}`
    if (event.kind === 'stop') {
      toast.error(event.message, { id: event.id, description })
    } else if (event.kind === 'target') {
      toast.success(event.message, { id: event.id, description })
    } else {
      toast(event.message, { id: event.id, description })
    }
  } catch {
    // toast 渲染异常不影响数据层
  }
}

function showNotification(scope: NotificationScope | undefined, event: AlertEvent): void {
  const ctor = scope?.Notification
  if (!ctor) return
  try {
    if (ctor.permission !== 'granted') return
    new ctor(event.message, { tag: event.id, body: `${event.code} 现价 ${event.price.toFixed(2)}` })
  } catch {
    // 部分浏览器在非安全上下文/权限被撤销时抛错：静默
  }
}

/** WebAudio 播放一个短促提示音；环境不支持时静默。 */
function playAlertSound(): void {
  try {
    if (typeof window === 'undefined') return
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return
    const context = new AudioCtor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.22)
    oscillator.onended = () => {
      void context.close().catch(() => undefined)
    }
  } catch {
    // WebAudio 不可用（SSR、自动播放策略、隐私模式）：静默
  }
}

export function useLiveAlerts(
  strategies: Strategy[],
  liveQuotes: Record<string, LiveQuote>,
): UseLiveAlertsResult {
  const [alerts, setAlerts] = useState<AlertEvent[]>([])
  const [permission, setPermission] = useState<NotificationAvailability>(() =>
    notificationPermission(),
  )
  const [soundEnabled, setSoundEnabled] = useState(false)

  // 去重状态跨渲染持有；StrictMode 双跑 effect 时第二个 effect 看到的已是消费后的状态。
  // 惰性初始化只读一次 localStorage，避免把持久化读取放进渲染期的 ref 赋值。
  const [initialState] = useState<AlertState>(loadAlertState)
  const stateRef = useRef<AlertState>(initialState)

  const toggleSound = useCallback(() => setSoundEnabled((value) => !value), [])

  const requestPermission = useCallback(async () => {
    const scope = getNotificationScope()
    const ctor: NotificationConstructor | undefined = scope?.Notification
    if (!ctor || typeof ctor.requestPermission !== 'function') {
      setPermission('unsupported')
      return
    }
    try {
      const result = await ctor.requestPermission()
      setPermission(result)
    } catch {
      setPermission(notificationPermission(scope))
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const { state, events } = scanAlerts(strategies, liveQuotes, stateRef.current, {
      now: new Date(),
    })
    stateRef.current = state
    saveAlertState(state)

    if (!events.length) return

    setAlerts((current) => {
      const known = new Set(current.map((alert) => alert.id))
      return [...events.filter((event) => !known.has(event.id)), ...current]
    })

    const scope = getNotificationScope()
    for (const event of events) {
      showToast(event)
      if (canNotify(permission)) showNotification(scope, event)
      if (soundEnabled) playAlertSound()
    }
  }, [strategies, liveQuotes, permission, soundEnabled])

  const dismiss = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id))
  }, [])

  // 清空展示，但保留去重状态：避免同一条盘中信号被立刻重新弹出
  const clear = useCallback(() => {
    setAlerts([])
  }, [])

  return { alerts, dismiss, clear, permission, requestPermission, soundEnabled, toggleSound }
}
