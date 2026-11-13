import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotSchema, mergeSnapshotQuotes } from '../src/lib/snapshot.ts'
const bars = [1, 2].map(day => ({date:`2026-11-0${day}`,open:10,high:11,low:9,close:10,volume:100,amount:1000,changePct:0,turnoverPct:0}))
const quote = {code:'600000',price:10,prevClose:10,changePct:0,open:10,high:11,low:9,volume:100,amount:1000,tradeDate:'2026-11-02',fetchedAt:'2026-11-02T09:00:00Z',source:'auto',bars}
const snapshot = {schemaVersion:1,generatedAt:'2026-11-02T09:00:00Z',tradeDate:'2026-11-02',source:'example',sourceUrl:'https://example.com',partial:false,failures:[],coverage:'fixture',quotes:{'600000':quote}}
test('accepts a valid public report', () => assert.equal(snapshotSchema.safeParse(snapshot).success, true))
test('rejects inconsistent or invalid quotes', () => { assert.equal(snapshotSchema.safeParse({...snapshot,quotes:{'600000':{...quote,price:0}}}).success,false); assert.equal(snapshotSchema.safeParse({...snapshot,quotes:{'600000':{...quote,bars:[bars[1],bars[0]]}}}).success,false) })
test('retains manual and newer local quotes', () => { const manual={...quote,source:'manual'}; assert.equal(mergeSnapshotQuotes({'600000':manual},snapshot)['600000'],manual); const newer={...quote,tradeDate:'2026-11-03'}; assert.equal(mergeSnapshotQuotes({'600000':newer},snapshot)['600000'],newer) })
