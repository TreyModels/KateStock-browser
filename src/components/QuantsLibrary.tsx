import { useEffect, useRef, useState } from 'react'
type Entry = {id:string; file:string; name:string; description:string}
export function QuantsLibrary(){
 const [entries,setEntries]=useState<Entry[]>([]),[language,setLanguage]=useState('en'),[query,setQuery]=useState(''),[csv,setCsv]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[output,setOutput]=useState<Record<string,string>>({})
 const worker=useRef<Worker|null>(null)
 const en=language==='en'
 useEffect(()=>{fetch('/quants/catalog.json').then(r=>r.json()).then(setEntries);return()=>worker.current?.terminate()},[])
 const run=(entry:Entry)=>{
  if(!worker.current){worker.current=new Worker('/quants/worker.js');worker.current.onmessage=({data})=>{
   if(data.type==='status')setStatus(data.text)
   if(data.type==='result'){setOutput(o=>({...o,[data.id]:data.output || (data.ok?'Completed / 已完成':'Failed / 失败')}));setBusy(false);setStatus(data.ok?'Completed / 已完成':'Calculation failed; see details / 计算失败，请查看详情')}
   if(data.type==='error'){setBusy(false);setStatus(data.text);worker.current?.terminate();worker.current=null}
  }}
  setBusy(true);setStatus(`${en?'Calculating':'正在计算'} ${entry.id}`);worker.current.postMessage({...entry,csv})
 }
 return <section className="standard-page"><div className="page-heading"><div><span className="section-kicker">QUANTS.MD · 50</span><h1>{en?'Strategy library':'策略库'}</h1><p>{en?'Original Python strategies, calculated in your browser.':'原版 Python 策略，在浏览器中计算。'}</p></div><select value={language} onChange={e=>setLanguage(e.target.value)} aria-label="Language"><option value="en">English</option><option value="zh">中文</option></select></div>
 <div className="performance-panel"><h2>{en?'Price history':'价格历史'}</h2><p>{en?'Upload the OHLCV CSV for the strategy’s instruments. Without a file, the original engine runs synthetic demonstration data. Demo results cannot establish whether a strategy works on your stocks.':'上传策略所需证券的 OHLCV CSV。未上传文件时，引擎使用合成演示数据。演示结果不能用于判断策略在您的股票上是否有效。'}</p><input type="file" accept=".csv" onChange={async e=>setCsv(await e.target.files?.[0]?.text() || '')}/><button onClick={()=>setCsv('')} disabled={busy}>{en?'Use demo data':'使用演示数据'}</button><p>{csv?(en?'Uploaded CSV selected':'已选择上传的 CSV'):(en?'SYNTHETIC DEMO DATA':'合成演示数据')}</p><p>{en?'The first run downloads the Python runtime and packages. Internet access is needed; computation runs in a browser worker. Each original strategy retains its universe, bar frequency, order rules and validation workflow. Missing or incompatible data produces an error.':'首次运行需要联网下载 Python 环境和依赖包，计算在浏览器工作线程内进行。每个原版策略保留其证券范围、时间周期、订单规则及验证流程。缺失或不兼容的数据会显示错误。'}</p><input placeholder={en?'Search name or ID':'搜索名称或编号'} value={query} onChange={e=>setQuery(e.target.value)}/><p role="status">{status}</p></div>
 <div style={{display:'grid',gap:16,marginTop:20}}>{entries.filter(e=>(e.id+' '+e.name+' '+e.description).toLowerCase().includes(query.toLowerCase())).map(entry=><article className="performance-panel" key={entry.id}><h2>{entry.id} · {entry.name.replace(/^Example (Orders|Weights) \d+ - /,'')}</h2><details><summary>{en?'Rules and data requirements':'规则与数据要求（原文）'}</summary><pre style={{whiteSpace:'pre-wrap'}}>{entry.description}</pre></details><button className="button-primary" disabled={busy} onClick={()=>run(entry)}>{en?'Calculate in browser':'在浏览器中计算'}</button>{output[entry.id]&&<pre style={{whiteSpace:'pre-wrap',maxHeight:500,overflow:'auto',fontSize:12}}>{output[entry.id]}</pre>}</article>)}</div>
 <p><a href="https://quants.md/" target="_blank" rel="noreferrer">quants.md</a> · QuantJourney · Apache-2.0. <a href="/quants/engine.zip">Original source / 原始代码</a></p></section>
}
