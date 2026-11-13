import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strToU8, zipSync } from 'fflate'
import { parseStocksText, parseStocksJson, readPortfolioFile, portfolioMarkdown, mergeImportedStocks } from '../src/lib/stockImport.ts'
const stock = { id:'stock-600000', code:'600000', name:'测试股份', status:'holding', shares:100, cost:12.5, createdAt:'2026-01-01T00:00:00Z' }
const portfolio = { stocks:[stock], quotes:{}, settings:{capital:100000,riskPct:1,maxPositionPct:10,refreshOnOpen:false}, goldValueCny:60000 }
test('Markdown exports and reimports stocks and gold without keys', () => { const md=portfolioMarkdown(portfolio); const parsed=parseStocksText(md); assert.equal(parsed.stocks[0].shares,100); assert.equal(parsed.goldValueCny,60000); assert.ok(!md.includes('sk-')) })
test('ZIP reads only stocks.md and skips key file', async () => { const zip=zipSync({'stocks.md':strToU8(portfolioMarkdown(portfolio)), 'key.txt':strToU8('secret')}); const result=await readPortfolioFile(new File([zip], 'data.zip')); assert.equal(result.stocks.length,1); assert.equal(result.goldValueCny,60000); assert.equal(JSON.stringify(result).includes('secret'),false) })
test('keeps existing records and rejects duplicate imported codes', () => { assert.equal(mergeImportedStocks([stock],[{...stock,shares:200}])[0].shares,100); assert.throws(()=>parseStocksJson([stock,stock])); })
test('supports comma-separated text', () => assert.equal(parseStocksText('600000,测试股份,watch').stocks[0].code,'600000'))
