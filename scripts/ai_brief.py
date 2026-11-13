"""Optional bounded daily commentary; never changes prices, signals, or private holdings."""
import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

PATH = Path('public/data/latest.json')
MAX_CHARS = 500

def validate_commentary(value):
    if not isinstance(value, str): return None
    value = value.strip()
    if not value or len(value) > MAX_CHARS: return None
    # No numeric claims, tickers, external URLs, orders, or key-like strings.
    if re.search(r'\d|https?://|sk-|买入|卖出|止损价|目标价|收益率|保证收益', value, re.I): return None
    return value

def main():
    report = json.loads(PATH.read_text())
    key = os.environ.get('DEEPSEEK_API_KEY', '')
    report['ai'] = {'status': 'unavailable', 'text': '', 'model': 'deepseek-flash'}
    if key:
        facts = [{'code': code, 'changePct': quote['changePct']} for code, quote in report['quotes'].items()]
        data = {'model':'deepseek-flash','thinking':{'type':'disabled'},'max_tokens':300,'messages':[
            {'role':'system','content':'你是中文市场研究助手。仅基于提供的公开日线涨跌方向写一到两句谨慎的整体观察。不要写数字、股票代码、价格、引用、网址、原因、预测、建议或交易指令。不要声称实时。不要输出任何其他内容。'},
            {'role':'user','content':json.dumps({'tradeDate':report['tradeDate'],'data':facts},ensure_ascii=False)}]}
        request = Request('https://api.deepseek.com/chat/completions', data=json.dumps(data,ensure_ascii=False).encode(), headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        try:
            with urlopen(request, timeout=45) as response: result = json.load(response)
            text = validate_commentary(result['choices'][0]['message']['content'])
            if text: report['ai'] = {'status':'available','text':text,'model':'deepseek-flash'}
        except Exception:
            print('Optional AI commentary unavailable; deterministic report retained')
    PATH.write_text(json.dumps(report,ensure_ascii=False,allow_nan=False,separators=(',',':')),encoding='utf-8')
    print('AI commentary:', report['ai']['status'])

if __name__ == '__main__': main()
