"""Single-household deployment: bind behind HTTPS; AUTH_TOKEN and KEY_ENCRYPTION_KEY required."""
import os,json,sqlite3,threading,time,datetime,urllib.request,urllib.error,secrets
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from cryptography.fernet import Fernet
DB=os.getenv('DB_PATH','/data/research.sqlite')
os.makedirs(os.path.dirname(DB),exist_ok=True)
AUTH=os.environ['AUTH_TOKEN']; cipher=Fernet(os.environ['KEY_ENCRYPTION_KEY'].encode())
lock=threading.Lock()
def db():
 c=sqlite3.connect(DB);c.execute('CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, secret BLOB, enabled INTEGER DEFAULT 0, daily_cap INTEGER DEFAULT 1)');c.execute('INSERT OR IGNORE INTO settings(id) VALUES(1)');c.execute('CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, created TEXT, status TEXT, output TEXT)');c.execute('CREATE TABLE IF NOT EXISTS chat_usage(day TEXT PRIMARY KEY, count INTEGER NOT NULL)');c.commit();return c
with db():pass
def research():
 if not lock.acquire(False): return
 try:
  with db() as c:
   secret,enabled,cap=c.execute('SELECT secret,enabled,daily_cap FROM settings WHERE id=1').fetchone()
   day=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
   count=c.execute('SELECT COUNT(*) FROM jobs WHERE created LIKE ?',(day+'%',)).fetchone()[0]
   if not secret or count>=cap:return
   created=datetime.datetime.now(datetime.timezone.utc).isoformat()
   cur=c.execute('INSERT INTO jobs(created,status,output) VALUES(?,?,?)',(created,'running',''));job=cur.lastrowid;c.commit()
  # Model is explicitly denied live-data claims. Actual market-data integration remains separate.
  payload={'model':'deepseek-flash','max_tokens':1800,'messages':[{'role':'system','content':'You prepare long-term A-share research checklists in Chinese. You have NO current prices, filings or web access. Never invent current financial facts, citations, price targets or buy/sell recommendations. Clearly state that this is a general research checklist, not an updated market report.'},{'role':'user','content':'Prepare a concise checklist for comparing China Mobile 600941, China Yangtze Power 600900, China Merchants Bank 600036, Midea 000333, Haier 600690, Yili 600887. Explain which current filings and valuation inputs are needed before a purchase range can be calculated.'}]}
  try:
   req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+cipher.decrypt(secret).decode()})
   with urllib.request.urlopen(req,timeout=120) as response:r=json.load(response)
   output=json.dumps({'text':r['choices'][0]['message']['content'],'usage':r.get('usage',{})},ensure_ascii=False);status='completed'
  except Exception:output=json.dumps({'text':'Research request failed. Check the API key, credit balance and server connection. No automatic retry was made.'});status='failed'
  with db() as c:c.execute('UPDATE jobs SET status=?,output=? WHERE id=?',(status,output,job))
 finally:lock.release()
def scheduler():
 while True:
  with db() as c:enabled=c.execute('SELECT enabled FROM settings WHERE id=1').fetchone()[0]
  if enabled:research()
  time.sleep(300)
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory='dist',**kw)
 def log_message(self,*args):pass
 def authorized(self):return secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+AUTH)
 def send_json(self,value,status=200):
  data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if not self.path.startswith('/api/'):return super().do_GET()
  if not self.authorized():return self.send_json({'error':'Sign in with the household access token'},401)
  with db() as c:
   if self.path=='/api/research':
    rows=c.execute('SELECT id,created,status,output FROM jobs ORDER BY id DESC LIMIT 10').fetchall();return self.send_json({'jobs':[dict(zip(['id','created','status','output'],r)) for r in rows]})
   row=c.execute('SELECT secret,enabled,daily_cap FROM settings WHERE id=1').fetchone();return self.send_json({'keyConfigured':bool(row[0]),'enabled':bool(row[1]),'dailyCap':row[2]})
 def do_POST(self):
  if not self.authorized():return self.send_json({'error':'Unauthorized'},401)
  try:
   length=int(self.headers.get('Content-Length','0'))
   if length>12000:return self.send_json({'error':'Request too large'},413)
   body=json.loads(self.rfile.read(length) or b'{}')
   if self.path=='/api/settings':
    with db() as c:
     if body.get('key'):c.execute('UPDATE settings SET secret=? WHERE id=1',(cipher.encrypt(body['key'].encode()),))
     if body.get('deleteKey'):c.execute('UPDATE settings SET secret=NULL,enabled=0 WHERE id=1')
     if 'enabled' in body:c.execute('UPDATE settings SET enabled=? WHERE id=1',(int(bool(body['enabled'])),))
    return self.send_json({'ok':True})
   if self.path=='/api/chat':
    prompt=body.get('message')
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>1500:return self.send_json({'error':'Message must be 1–1500 characters'},400)
    day=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    with lock:
     with db() as c:
      secret=c.execute('SELECT secret FROM settings WHERE id=1').fetchone()[0]
      key=os.environ.get('DEEPSEEK_API_KEY') or (cipher.decrypt(secret).decode() if secret else '')
      if not key:return self.send_json({'error':'DeepSeek is not configured'},503)
      cap=max(1,min(int(os.environ.get('CHAT_DAILY_CAP','20')),100))
      row=c.execute('SELECT count FROM chat_usage WHERE day=?',(day,)).fetchone()
      if row and row[0]>=cap:return self.send_json({'error':'Daily research limit reached'},429)
      c.execute('INSERT INTO chat_usage(day,count) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1',(day,));c.commit()
    payload={'model':'deepseek-flash','thinking':{'type':'disabled'},'max_tokens':500,'messages':[{'role':'system','content':'用简体中文提供简洁的金融研究说明。你没有实时行情、用户持仓或网络检索。不得编造实时价格、新闻或引用，不给具体交易指令或收益承诺。明确说明未知信息。'}, {'role':'user','content':prompt.strip()}]}
    try:
     req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
     with urllib.request.urlopen(req,timeout=45) as response:result=json.load(response)
     answer=result['choices'][0]['message']['content']
     if not isinstance(answer,str) or not answer.strip() or len(answer)>6000:raise ValueError('Invalid response')
     return self.send_json({'text':answer.strip(),'disclaimer':'AI 研究说明，不含实时行情，不构成投资建议。'})
    except Exception:return self.send_json({'error':'DeepSeek unavailable; try again later'},502)
   if self.path=='/api/research':threading.Thread(target=research,daemon=True).start();return self.send_json({'ok':True},202)
   return self.send_json({'error':'Unknown endpoint'},404)
  except Exception:return self.send_json({'error':'Invalid request'},400)
threading.Thread(target=scheduler,daemon=True).start()
ThreadingHTTPServer((os.getenv('BIND_ADDRESS','0.0.0.0'),int(os.getenv('PORT','8080'))),Handler).serve_forever()
