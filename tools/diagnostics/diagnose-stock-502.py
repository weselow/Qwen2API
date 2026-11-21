#!/usr/bin/env python3
"""Authorized diagnostic only; never prints raw app output, headers or response bodies."""
import base64,json,os,pathlib,secrets,subprocess,time,urllib.request,urllib.error
ROOT=pathlib.Path('/root/qwen-prod-doh-502-verified-20261120')
PREVIOUS=pathlib.Path('/root/qwen-prod-doh-diagnostic-20261120')
PROD='e7198260faec'
APP='qwen2api-prod-doh-observed-verified-20261120'
RESOLVER='qwen2api-prod-doh-resolver-20261120'
IMAGE='sha256:ba61eb69855445944896f43627ac467456a08e1f0303658785578f7b41cf6794'
PORT=23216

def run(*args):
 r=subprocess.run(['docker',*args],text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError('docker failure')
 return r.stdout.strip()
def inspect(name):return json.loads(run('inspect',name))[0]
def identity(x):return {'Id':x['Id'],'Image':x['Image'],'StartedAt':x['State']['StartedAt'],'RestartCount':x['RestartCount'],'Dns':x['HostConfig'].get('Dns'),'ExtraHosts':x['HostConfig'].get('ExtraHosts')}
def emit(v):print(json.dumps(v),flush=True)
def save(name,v):
 p=ROOT/name;p.write_text(json.dumps(v,indent=2));p.chmod(0o600)
def request(key,path,body=None,timeout=15):
 a=urllib.request.Request('http://127.0.0.1:'+str(PORT)+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 return urllib.request.urlopen(a,timeout=timeout)
def execute():
 if ROOT.exists():raise RuntimeError('existing observation directory; inspect before repeating')
 ROOT.mkdir(mode=0o700);baseline=identity(inspect(PROD));save('production-baseline.json',baseline)
 if baseline['Image']!=IMAGE:raise RuntimeError('production image drift')
 source=json.loads((PREVIOUS/'doh/data/data.json').read_text())['accounts'][0]
 token=source['token'];p=token.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4)))
 if claims.get('exp',0)<time.time()+300:raise RuntimeError('diagnostic token expired')
 a={k:source[k] for k in ['email','token','fingerprint'] if k in source};a.update({'password':'','proxy':'','expires':claims['exp']})
 data=ROOT/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
 f=data/'data.json';f.write_text(json.dumps({'accounts':[a],'settings':{'chatRetryCount':0,'chatRetryBackoffMs':0}}));f.chmod(0o600);os.chown(f,1000,1000)
 key=secrets.token_urlsafe(36)
 env=ROOT/'diagnostic.env';env.write_text('\n'.join(['API_KEY='+key,'DATA_SAVE_MODE=file','LISTEN_ADDRESS=0.0.0.0','SERVICE_PORT=3000','ENABLE_CLI=false','ENABLE_FILE_LOG=false','LOG_LEVEL=ERROR','MODELS_CACHE_TTL=1','BUN_OPTIONS=--preload=/observer.cjs'])+'\n');env.chmod(0o600)
 save('session-metadata.json',{'future_exp':True,'remaining_seconds':round(claims['exp']-time.time()),'has_iat':'iat' in claims,'password_copied':False,'proxy_copied':False})
 try:
  run('start',RESOLVER)
  run('run','-d','--name',APP,'--label','qwen-diagnostic=prod-doh-502-20261120','--network','m04skwsg8kck8ckwkc04ssss','--dns','172.23.254.53','--restart','no','--read-only','--cap-drop','ALL','--user','1000:1000','--memory','256m','--cpus','1','--pids-limit','128','--log-driver','none','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--tmpfs','/app/logs:rw,noexec,nosuid,uid=1000,gid=1000,size=8m','--tmpfs','/app/caches:rw,noexec,nosuid,uid=1000,gid=1000,size=16m','--env-file',str(env),'-v',str(data)+':/app/data','-v',str(PREVIOUS/'upstream-safe-observer.cjs')+':/observer.cjs:ro','-p','127.0.0.1:'+str(PORT)+':3000',IMAGE)
  for _ in range(40):
   try:
    with request(key,'/api/setAutoRefresh',{'autoRefresh':False},timeout=1) as r:assert r.status==200
    break
   except Exception:time.sleep(.2)
  else:raise RuntimeError('observed diagnostic not ready')
  emit({'image':inspect(APP)['Image'],'binary_sha256':run('exec',APP,'sha256sum','/usr/local/bin/qwen2api').split()[0],'preload_observer':True})
  t=time.monotonic()
  with request(key,'/v1/models') as r:models=json.load(r)['data'];result={'operation':'catalog','http':r.status,'models':len(models),'seconds':round(time.monotonic()-t,3)}
  save('catalog.json',result);emit(result)
  ids={q.get('id') for q in models};model='qwen3.7-plus'
  if model not in ids:raise RuntimeError('expected model not advertised')
  t=time.monotonic();result={'operation':'non_stream','model':model}
  try:
   with request(key,'/v1/chat/completions',{'model':model,'stream':False,'messages':[{'role':'user','content':'Reply with exactly OK'}],'max_tokens':16},timeout=35) as r:
    z=json.load(r);content=z.get('choices',[{}])[0].get('message',{}).get('content');result.update({'http':r.status,'text_is_OK':isinstance(content,str) and content.strip()=='OK'})
  except urllib.error.HTTPError as e:
   result['http']=e.code
   try:
    z=json.loads(e.read(200000));err=z.get('error',{});msg=err.get('message','') if isinstance(err,dict) else ''
    result.update({'upstream_error_code':err.get('code')=='upstream_error' if isinstance(err,dict) else False,'session_creation_failure_message':'无法创建或续接 Qwen 会话' in msg})
   except Exception:result['json_error_unreadable']=True
  except Exception as e:result['transport_error_type']=type(e).__name__
  result['seconds']=round(time.monotonic()-t,3);save('non-stream.json',result);emit(result)
  # Only wait for the single read-only identity probe already scheduled by the observer.
  trace=data/'upstream-safe.jsonl'
  for _ in range(60):
   events=[json.loads(l) for l in trace.read_text().splitlines()] if trace.exists() else []
   if any(q.get('kind')=='identity_probe' for q in events):break
   time.sleep(.2)
  save('safe-observer-summary.json',events);emit({'safe_observer_events':events})
 finally:
  for name in [APP,RESOLVER]:
   r=subprocess.run(['docker','stop','--time','2',name],capture_output=True,text=True,timeout=15);emit({'stopped':name,'command_exit':r.returncode})
  emit({'production_unchanged':identity(inspect(PROD))==baseline})

if __name__=='__main__':
 try:execute()
 except Exception as e:emit({'fatal_type':type(e).__name__});raise SystemExit(1)
