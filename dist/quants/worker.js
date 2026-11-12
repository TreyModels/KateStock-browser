importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
let runtime;
async function boot(){
 postMessage({type:'status',text:'Loading browser Python and scientific packages / 正在加载计算环境'});
 runtime=await loadPyodide();
 await runtime.loadPackage(['numpy','pandas','scipy','matplotlib','micropip','pydantic']);
 await runtime.runPythonAsync("import micropip\nawait micropip.install('typing-extensions>=4.12', reinstall=True)\nawait micropip.install(['httpx','requests','seaborn','optuna'])");
 const bytes=await (await fetch('/quants/engine.zip')).arrayBuffer();
 runtime.unpackArchive(bytes,'zip');
 await runtime.runPythonAsync(await (await fetch('/quants/runner.py')).text());
 postMessage({type:'ready'});
}
onmessage=async({data})=>{try{
 if(!runtime)await boot();
 if(data.csv)runtime.FS.writeFile('/prices.csv',data.csv);
 else if(runtime.FS.analyzePath('/prices.csv').exists)runtime.FS.unlink('/prices.csv');
 runtime.globals.set('strategy_name',data.file);
 const result=JSON.parse(await runtime.runPythonAsync('await run_browser_strategy(strategy_name)'));
 postMessage({type:'result',id:data.id,...result});
}catch(e){postMessage({type:'error',text:String(e)})}};
