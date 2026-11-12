import os, sys, json, importlib, traceback
os.environ['MPLBACKEND']='Agg'
os.environ['QJ_SAMPLE_DATA']='1'
# Network data retrieval is replaced by uploaded local CSV or explicit demo data.
from backtester import Backtester
_original_init = Backtester.__init__
def browser_init(self,*args,**kwargs):
    for key in ('show_text_reports','save_text_reports','save_portfolio_plots','show_portfolio_plots'):
        kwargs[key]=False
    if os.path.exists('/prices.csv'):
        kwargs['data_csv']='/prices.csv'
        os.environ.pop('QJ_SAMPLE_DATA',None)
    else:
        os.environ['QJ_SAMPLE_DATA']='1'
    _original_init(self,*args,**kwargs)
Backtester.__init__=browser_init
async def run_browser_strategy(name):
    import io, contextlib
    output=io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            module=importlib.import_module('strategies.'+name)
            await module.main()
        return json.dumps({'ok':True,'output':output.getvalue()})
    except Exception:
        return json.dumps({'ok':False,'output':output.getvalue()+'\n'+traceback.format_exc()})
