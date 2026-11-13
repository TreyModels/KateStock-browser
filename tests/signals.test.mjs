import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateStrategy } from '../src/lib/strategy.ts'

test('scheduled signals use the same strategy engine and omit personal sizing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'katestock-'))
  try {
    const bars = Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,open:10+i*.1,high:10.2+i*.1,low:9.8+i*.1,close:10+i*.1,volume:100,amount:1000,changePct:0,turnoverPct:0}))
    const quote={code:'600000',price:12.9,prevClose:12.8,changePct:0,open:12.9,high:13.1,low:12.7,volume:100,amount:1000,tradeDate:bars.at(-1).date,fetchedAt:'2026-10-30T09:00:00Z',source:'auto',bars}
    const file=join(dir,'report.json');writeFileSync(file,JSON.stringify({generatedAt:'2026-10-30T09:00:00Z',quotes:{'600000':quote}}))
    execFileSync(process.execPath,['--experimental-strip-types','scripts/generate_signals.mjs'],{env:{...process.env,SNAPSHOT_OUTPUT:file}})
    const out=JSON.parse(readFileSync(file,'utf8'))
    const expected=generateStrategy({id:'public-600000',code:'600000',name:'600000',status:'watch',createdAt:'2026-10-30T09:00:00Z'},quote,{capital:100000,riskPct:1,maxPositionPct:10,refreshOnOpen:false})
    assert.equal(out.signals['600000'].score,expected.score)
    assert.equal(out.signals['600000'].action,expected.action)
    assert.equal('suggestedShares' in out.signals['600000'],false)
    assert.equal('capital' in out.signals['600000'],false)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
