import { useEffect, useRef, useState } from 'react'

type SpeechResult = { transcript: string }
type SpeechResultEvent = Event & { results: ArrayLike<ArrayLike<SpeechResult>> }
type Recognition = { lang: string; interimResults: boolean; onresult: ((event: SpeechResultEvent) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }

export function ResearchSettings() {
  const [token, setToken] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  useEffect(() => () => { recognition.current?.stop(); window.speechSynthesis?.cancel() }, [])
  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) { setError('此浏览器不支持语音播放，请阅读文字回答。'); return }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.speak(utterance)
  }
  const listen = () => {
    if (listening) { recognition.current?.stop(); return }
    const Constructor = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition
    if (!Constructor) { setError('浏览器不支持网页语音识别。请使用键盘上的听写按钮输入。'); return }
    try {
      const instance = new Constructor()
      recognition.current = instance
      instance.lang = 'zh-CN'; instance.interimResults = false
      instance.onresult = event => { setQuestion(event.results[0]?.[0]?.transcript || ''); setError('') }
      instance.onerror = () => { setError('无法识别语音，请检查麦克风权限，或使用键盘听写。'); setListening(false) }
      instance.onend = () => setListening(false)
      instance.start(); setListening(true); setError('')
    } catch { setListening(false); setError('无法启动麦克风，请使用键盘听写。') }
  }
  const ask = async () => {
    if (!question.trim() || !token.trim()) { setError('请输入问题和家庭访问口令。'); return }
    setBusy(true); setError(''); setAnswer('')
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/chat`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({message:question.trim()}) })
      if (!response.ok) throw new Error('研究服务未连接、口令错误或暂不可用。')
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') throw new Error('研究服务返回无效回答。')
      setAnswer(data.text); speak(data.text)
    } catch (err) { setError(err instanceof Error ? err.message : '无法连接研究服务。') } finally { setBusy(false) }
  }
  return <section className="voice-research" aria-labelledby="voice-title">
    <div className="voice-heading"><span>DEEPSEEK RESEARCH</span><h2 id="voice-title">说出问题，阅读回答</h2><p>语音或文字提问，回答会显示在这里，也可以播放。</p></div>
    <div className="voice-grid">
      <div className="voice-input">
        <label className="form-field">家庭访问口令（仅本次会话）<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" /></label>
        <label className="form-field">你的问题<textarea rows={4} maxLength={1500} value={question} onChange={event => setQuestion(event.target.value)} placeholder="按语音输入，或在这里输入问题" /></label>
        <div className="data-actions"><button type="button" className="button-secondary" onClick={listen}>{listening ? '停止听写' : '🎙 语音输入'}</button><button type="button" className="button-primary" disabled={busy} onClick={() => void ask()}>{busy ? '正在回答…' : '发送问题'}</button></div>
        {error && <p className="voice-error" role="alert">{error}</p>}
      </div>
      <div className="voice-answer" aria-live="polite" aria-label="DeepSeek 文字回答">
        <div className="voice-answer-heading"><h3>DeepSeek 文字回答</h3><span>AI 研究参考</span></div>
        <p className={answer ? 'voice-answer-text' : 'voice-answer-placeholder'}>{answer || (busy ? '正在准备回答…' : '回答会显示在这里。')}</p>
        {answer && <div className="data-actions"><button type="button" className="button-secondary" onClick={() => speak(answer)}>播放回答</button><button type="button" className="button-secondary" onClick={() => window.speechSynthesis?.cancel()}>停止播放</button></div>}
      </div>
    </div>
    <p className="voice-footnote">需要已部署并启用的家庭研究服务。语音可能由浏览器提供商处理；发送的问题会传给 DeepSeek，不会自动发送持仓或成本。回答不含实时行情，不构成投资建议。</p>
  </section>
}
