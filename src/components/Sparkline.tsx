import type { Bar } from '@/types'

export function Sparkline({ bars, positive = true, large = false }: { bars: Bar[]; positive?: boolean; large?: boolean }) {
  const points = bars.slice(-30).map((bar) => bar.close)
  if (points.length < 2) {
    return <div className={`sparkline-empty ${large ? 'h-36' : 'h-12'}`}>等待日线数据</div>
  }
  const width = 240
  const height = large ? 144 : 56
  const padding = 3
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const path = points.map((point, index) => {
    const x = padding + index * (width - padding * 2) / (points.length - 1)
    const y = height - padding - (point - min) / range * (height - padding * 2)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const color = positive ? '#d84a40' : '#14805f'
  return (
    <svg className="block h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近30个交易日收盘走势">
      <path d={path} fill="none" stroke={color} strokeWidth={large ? 2.2 : 2} strokeLinecap="round" strokeLinejoin="round" />
      <circle
        cx={width - padding}
        cy={height - padding - (points.at(-1)! - min) / range * (height - padding * 2)}
        r={large ? 3.5 : 2.5}
        fill={color}
      />
    </svg>
  )
}
