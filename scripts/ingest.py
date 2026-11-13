"""Generate a public, limited-universe EOD snapshot. Never reads browser portfolio data."""
import datetime as dt
import json
import math
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

# The owner authorized publication of these stock codes; no positions or cost basis.
UNIVERSE = json.loads((Path(__file__).parent / 'public-universe.json').read_text())
SOURCE = 'Eastmoney daily OHLCV (前复权)'
SOURCE_URL = 'https://www.eastmoney.com/'

def completed_date(now, dates):
    today = now.date()
    eligible = [d for d in dates if d < today or (d == today and now.time() >= dt.time(16, 45))]
    if not eligible:
        raise ValueError('No completed session in calendar')
    return max(eligible)

def fetch_json(url):
    last = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0 KateStock/2.0'}), timeout=8) as response:
                return json.load(response)
        except Exception as exc:
            last = exc
            if attempt < 1: time.sleep(1)
    raise RuntimeError('source request failed') from last

def parse_bars(payload, expected):
    if payload.get('rc') != 0 or not (payload.get('data') or {}).get('klines'):
        raise ValueError('no source candles')
    bars = []
    for line in payload['data']['klines']:
        fields = line.split(',')
        if len(fields) < 11: raise ValueError('incomplete candle')
        date = dt.date.fromisoformat(fields[0])
        if date > expected: continue
        values = [float(fields[i]) for i in (1, 2, 3, 4, 5, 6, 8, 10)]
        o, c, h, l, vol, amount, change, turnover = values
        if not all(math.isfinite(v) for v in values) or min(o,c,h,l) <= 0 or min(vol,amount) < 0 or h < max(o,c,l) or l > min(o,c): raise ValueError('invalid OHLCV')
        if bars and date.isoformat() <= bars[-1]['date']: raise ValueError('duplicate or unordered dates')
        bars.append(dict(date=date.isoformat(),open=o,close=c,high=h,low=l,volume=vol,amount=amount,changePct=change,turnoverPct=turnover))
    if len(bars) < 21 or bars[-1]['date'] != expected.isoformat(): raise ValueError('incomplete or stale bars')
    return bars[-160:]

def main():
    import akshare as ak
    now = dt.datetime.now(ZoneInfo('Asia/Shanghai'))
    calendar = ak.tool_trade_date_hist_sina()['trade_date'].tolist()
    dates = [dt.date.fromisoformat(str(x)[:10]) for x in calendar]
    if max(dates) < now.date(): raise RuntimeError('Trading calendar is out of date; refusing publication')
    expected = completed_date(now, dates)
    generated = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')
    def fetch_one(code):
        try:
            secid = ('1.' if code.startswith(('5','6','9')) else '0.') + code
            params = urlencode({'secid':secid,'fields1':'f1,f2,f3,f4,f5,f6','fields2':'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61','klt':'101','fqt':'1','beg':(expected-dt.timedelta(days=260)).strftime('%Y%m%d'),'end':expected.strftime('%Y%m%d')})
            provider = 'Eastmoney'
            try:
                bars = parse_bars(fetch_json('https://push2his.eastmoney.com/api/qt/stock/kline/get?' + params), expected)
            except Exception:
                # Sina's stock qfq history has amount/volume; fund adjustment semantics
                # differ, so leave ETFs as failed instead of mixing unverified series.
                if code.startswith(('5','159')): raise
                symbol = ('sh' if code.startswith('6') else 'sz') + code
                frame = ak.stock_zh_a_daily(symbol=symbol, start_date=(expected-dt.timedelta(days=260)).strftime('%Y%m%d'), end_date=expected.strftime('%Y%m%d'), adjust='qfq')
                bars = []
                previous = None
                for row in frame.to_dict('records'):
                    date = dt.date.fromisoformat(str(row['date'])[:10])
                    if date > expected: continue
                    values = [float(row[key]) for key in ('open','close','high','low','volume','amount')]
                    o,c,h,l,volume,amount = values
                    if not all(math.isfinite(v) for v in values) or min(o,c,h,l) <= 0 or min(volume,amount) < 0 or h < max(o,c,l) or l > min(o,c): raise ValueError('invalid Sina bar')
                    if bars and date.isoformat() <= bars[-1]['date']: raise ValueError('duplicate Sina date')
                    if previous is not None: bars.append(dict(date=date.isoformat(),open=o,close=c,high=h,low=l,volume=volume,amount=amount,changePct=(c / previous - 1)*100))
                    previous = c
                if len(bars) < 21 or bars[-1]['date'] != expected.isoformat(): raise ValueError('incomplete or stale Sina bars')
                bars = bars[-160:]
                provider = 'Sina Finance via AKShare'
            b = bars[-1]
            quote = dict(code=code,price=b['close'],prevClose=bars[-2]['close'],changePct=b['changePct'],open=b['open'],high=b['high'],low=b['low'],volume=b['volume'],amount=b['amount'],tradeDate=b['date'],fetchedAt=generated,source='auto',provider=provider,adjustment='前复权',bars=bars)
            return code, quote, None
        except Exception as exc:
            return code, None, f'{code}: {type(exc).__name__}'
    quotes, failures = {}, []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for code, quote, error in pool.map(fetch_one, UNIVERSE):
            if quote is not None: quotes[code] = quote
            if error is not None: failures.append(error)
    if not quotes: raise RuntimeError('No valid current quotes; last-good snapshot must remain untouched')
    providers = {q['provider'] for q in quotes.values()}
    source = ' / '.join(sorted(providers)) + ' (前复权)'
    source_url = 'https://finance.sina.com.cn/' if 'Sina Finance via AKShare' in providers else SOURCE_URL
    report = dict(schemaVersion=1,generatedAt=generated,tradeDate=expected.isoformat(),source=source,sourceUrl=source_url,partial=bool(failures),failures=failures,coverage=f'公开清单（{len(UNIVERSE)}只），非全市场',quotes=quotes)
    out = Path(os.environ.get('SNAPSHOT_OUTPUT','public/data/latest.json'))
    out.parent.mkdir(parents=True,exist_ok=True)
    temp = out.with_suffix('.tmp')
    temp.write_text(json.dumps(report,ensure_ascii=False,allow_nan=False,separators=(',',':')),encoding='utf-8')
    os.replace(temp,out)
    print(f"date={expected}, valid={len(quotes)}, failed={len(failures)}")

if __name__ == '__main__': main()
