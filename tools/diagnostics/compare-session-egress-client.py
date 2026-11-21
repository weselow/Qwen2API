#!/usr/bin/env python3
"""Run only on the authorized host; one copied session, identity requests only."""
import base64,json,os,pathlib,secrets,subprocess,time,urllib.request,urllib.parse
ROOT=pathlib.Path('/root/qwen-session-egress-longwait-20261121')
PREVIOUS=pathlib.Path('/root/qwen-prod-doh-diagnostic-20261120')
PROD='e7198260faec'
APP='qwen2api-session-profile-longwait-20261121'
RESOLVER='qwen2api-prod-doh-resolver-20261120'
IMAGE='sha256:ba61eb69855445944896f43627ac467456a08e1f0303658785578f7b41cf6794'
PORT=23221

def docker(*args):
 r=subprocess.run(['docker',*args],text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError('docker failure')
 return r.stdout.strip()
def inspect(name):return json.loads(docker('inspect',name))[0]
def identity(x):return {'Id':x['Id'],'Image':x['Image'],'StartedAt':x['State']['StartedAt'],'RestartCount':x['RestartCount'],'Dns':x['HostConfig'].get('Dns'),'ExtraHosts':x['HostConfig'].get('ExtraHosts')}
def emit(v):print(json.dumps(v),flush=True)
def save(name,v):
 p=ROOT/name;p.write_text(json.dumps(v,indent=2));p.chmod(0o600)
def request(key,path,body=None,timeout=15):
 r=urllib.request.Request('http://127.0.0.1:'+str(PORT)+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 return urllib.request.urlopen(r,timeout=timeout)
def main():
 if ROOT.exists():raise RuntimeError('existing diagnostic directory')
 baseline=identity(inspect(PROD))
 if baseline['Image']!=IMAGE:raise RuntimeError('production image drift')
 source=json.loads((PREVIOUS/'doh/data/data.json').read_text())['accounts'][0]
 original=json.loads(pathlib.Path('/data/coolify/applications/m04skwsg8kck8ckwkc04ssss/data/data.json').read_text())
 matched=[a for a in original['accounts'] if a.get('email')==source.get('email') and a.get('token')==source.get('token')]
 if len(matched)!=1:raise RuntimeError('original account no longer uniquely matches session')
 proxy=matched[0].get('proxy') or ''
 if urllib.parse.urlsplit(proxy).scheme!='http':raise RuntimeError('original proxy is not HTTP')
 part=source['token'].split('.')[1];claims=json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))
 if claims.get('exp',0)<time.time()+300:raise RuntimeError('copied diagnostic session expired')
 ROOT.mkdir(mode=0o700);save('production-baseline.json',baseline)
 data=ROOT/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
 account={k:source[k] for k in ['email','token','fingerprint'] if k in source};account.update({'password':'','proxy':'','expires':claims['exp']})
 for name,value in [('data.json',{'accounts':[account],'settings':{'chatRetryCount':0,'chatRetryBackoffMs':0}}),('proxy-control.json',{'proxy':proxy})]:
  p=data/name;p.write_text(json.dumps(value));p.chmod(0o600);os.chown(p,1000,1000)
 key=secrets.token_urlsafe(36)
 env=ROOT/'diagnostic.env';env.write_text('\n'.join(['API_KEY='+key,'DATA_SAVE_MODE=file','LISTEN_ADDRESS=0.0.0.0','SERVICE_PORT=3000','ENABLE_CLI=false','ENABLE_FILE_LOG=false','LOG_LEVEL=ERROR','MODELS_CACHE_TTL=3600','BUN_OPTIONS=--preload=/observer.cjs'])+'\n');env.chmod(0o600)
 summary={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'same_session_as_previous_diagnostic':True,'original_account_uniquely_matched':True,'original_proxy_scheme':'http','password_copied':False,'generation_requests':0,'remaining_session_seconds':round(claims['exp']-time.time())};save('setup-safe.json',summary);emit(summary)
 try:
  docker('start',RESOLVER)
  docker('run','-d','--name',APP,'--label','qwen-diagnostic=session-egress-20261121','--network','m04skwsg8kck8ckwkc04ssss','--dns','172.23.254.53','--restart','no','--read-only','--cap-drop','ALL','--user','1000:1000','--memory','256m','--cpus','1','--pids-limit','128','--log-driver','none','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--tmpfs','/app/logs:rw,noexec,nosuid,uid=1000,gid=1000,size=8m','--tmpfs','/app/caches:rw,noexec,nosuid,uid=1000,gid=1000,size=16m','--env-file',str(env),'-v',str(data)+':/app/data','-v',str(PREVIOUS/'session-profile-once.cjs')+':/observer.cjs:ro','-p','127.0.0.1:'+str(PORT)+':3000',IMAGE)
  for _ in range(40):
   try:
    with request(key,'/api/setAutoRefresh',{'autoRefresh':False},timeout=1) as r:assert r.status==200
    break
   except Exception:time.sleep(.2)
  else:raise RuntimeError('diagnostic readiness')
  emit({'image':inspect(APP)['Image'],'binary_sha256':docker('exec',APP,'sha256sum','/usr/local/bin/qwen2api').split()[0]})
  t=time.monotonic()
  with request(key,'/v1/models') as r:models=json.load(r)['data'];emit({'catalog_http':r.status,'catalog_models':len(models),'seconds':round(time.monotonic()-t,3)})
  # The one-time endpoint is authenticated, loopback-only and never logged.
  with request(key,'/__diagnostic_profile_once',timeout=3) as r:profile=json.load(r)
  normalized={k.lower():v for k,v in profile.items()}
  if normalized.get('authorization')!='Bearer '+source['token']:raise RuntimeError('stock profile does not match diagnostic token')
  helper='sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e'
  payload={'headers':profile,'proxy':proxy,'token':source['token']}
  command=['docker','run','--rm','-i','--name','qwen2api-session-egress-client-20261121','--network','m04skwsg8kck8ckwkc04ssss','--dns','172.23.254.53','--read-only','--cap-drop','ALL','--user','65534:65534','--memory','96m','--cpus','0.5','--pids-limit','64','--log-driver','none','-v',str(PREVIOUS/'session-egress-client.py')+':/probe.py:ro',helper,'python','/probe.py']
  # Credentials travel only through local stdin into the isolated helper process.
  result=subprocess.run(command,input=json.dumps(payload),text=True,capture_output=True,timeout=50)
  if result.returncode:raise RuntimeError('independent diagnostic client failed')
  summary=json.loads(result.stdout);save('safe-client-results.json',summary);emit(summary)
  trace=data/'profile-safe.jsonl'
  events=[json.loads(l) for l in trace.read_text().splitlines()] if trace.exists() else []
  save('safe-stock-profile-summary.json',events);emit({'stock_profile_summary':events})
 finally:
  for name in ['qwen2api-session-egress-client-20261121',APP,RESOLVER]:
   r=subprocess.run(['docker','stop','--time','2',name],text=True,capture_output=True,timeout=15);emit({'stopped':name,'command_exit':r.returncode})
  emit({'production_unchanged':identity(inspect(PROD))==baseline})

if __name__=='__main__':
 try:main()
 except Exception as e:emit({'fatal_type':type(e).__name__});raise SystemExit(1)
