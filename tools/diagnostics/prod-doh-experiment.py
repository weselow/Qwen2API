#!/usr/bin/env python3
"""Run ONLY on the explicitly authorized diagnostic host. Never prints credentials.
A separate DNS sidecar forwards Qwen DNS wire messages over verified HTTPS.
The application executable is the exact existing production image, unmodified.
"""
import base64, concurrent.futures, hashlib, http.client, json, os, pathlib
import secrets, socket, struct, subprocess, sys, time, urllib.request

ROOT = pathlib.Path('/root/qwen-prod-doh-diagnostic-20261120')
PROD = 'e7198260faec'
NETWORK = 'm04skwsg8kck8ckwkc04ssss'
NAMES = {'resolver': 'qwen2api-prod-doh-resolver-20261120',
         'control': 'qwen2api-prod-dns-baseline-20261120',
         'doh': 'qwen2api-prod-doh-diagnostic-20261120'}
PORTS = {'control': 23213, 'doh': 23214}
DNS_IP = '172.23.254.53'
HELPER = 'sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e'
RESOLVER = r'''
import concurrent.futures, http.client, json, socket, socketserver, ssl, struct, threading, time

def label(buf,pos):
 out=[];end=None;seen=set()
 while True:
  if pos in seen:raise ValueError('DNS pointer loop')
  seen.add(pos);n=buf[pos]
  if n&192==192:
   if end is None:end=pos+2
   pos=((n&63)<<8)|buf[pos+1];continue
  pos+=1
  if not n:return '.'.join(out),end or pos
  out.append(buf[pos:pos+n].decode('ascii'));pos+=n

def describe(buf):
 qname,p=label(buf,12);qt=struct.unpack_from('!H',buf,p)[0];p+=4
 qd,an=struct.unpack_from('!HH',buf,4)
 for _ in range(qd-1):_,p=label(buf,p);p+=4
 answers=[]
 for _ in range(an):
  _,p=label(buf,p);typ,cl,ttl,n=struct.unpack_from('!HHIH',buf,p);p+=10
  if typ==1 and n==4:answers.append({'ip':socket.inet_ntop(socket.AF_INET,buf[p:p+n]),'ttl':ttl})
  p+=n
 return qname,qt,answers

def exchange(query):
 try:
  name,p=label(query,12);qtype=struct.unpack_from('!H',query,p)[0]
  via_doh=name=='qwen.ai' or name.endswith('.qwen.ai') or name=='aliyunga0019.com' or name.endswith('.aliyunga0019.com')
  if via_doh:
   # Bootstrap uses the sidecar's ordinary Docker resolver, never this server.
   conn=http.client.HTTPSConnection('cloudflare-dns.com',timeout=6,context=ssl.create_default_context())
   try:
    conn.request('POST','/dns-query',body=query,headers={'Content-Type':'application/dns-message','Accept':'application/dns-message'})
    response=conn.getresponse();data=response.read(65536)
    if response.status!=200 or response.getheader('Content-Type','').split(';')[0]!='application/dns-message':raise ValueError('DoH response')
   finally:conn.close()
   if len(data)<12 or data[:2]!=query[:2]:raise ValueError('DNS response ID')
   _,_,answers=describe(data)
   print(json.dumps({'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'qname':name,'qtype':qtype,'transport':'verified-https','rcode':data[3]&15,'answers':answers}),flush=True)
   return data
  with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
   s.settimeout(3);s.connect(('10.20.0.151',53));s.send(query);return s.recv(65535)
 except Exception as exc:
  print(json.dumps({'resolver_error':type(exc).__name__}),flush=True)
  return query[:2]+struct.pack('!HHHHH',0x8182,1,0,0,0)+query[12:]

class UDP(socketserver.BaseRequestHandler):
 def handle(self):
  query,sock=self.request;sock.sendto(exchange(query),self.client_address)
class TCP(socketserver.BaseRequestHandler):
 def recv(self,n):
  data=b''
  while len(data)<n:
   part=self.request.recv(n-len(data))
   if not part:raise EOFError()
   data+=part
  return data
 def handle(self):
  self.request.settimeout(8)
  try:
   for _ in range(4):
    n=struct.unpack('!H',self.recv(2))[0];answer=exchange(self.recv(n));self.request.sendall(struct.pack('!H',len(answer))+answer)
  except (EOFError,TimeoutError):pass
class UDPServer(socketserver.ThreadingUDPServer):daemon_threads=True
class TCPServer(socketserver.ThreadingTCPServer):daemon_threads=True;allow_reuse_address=True
udp=UDPServer(('0.0.0.0',53),UDP);tcp=TCPServer(('0.0.0.0',53),TCP)
threading.Thread(target=udp.serve_forever,daemon=True).start()
print(json.dumps({'ready':True,'cache':'none; authoritative TTL retained','qwen_route':'DoH only; no plain-DNS fallback'}),flush=True)
tcp.serve_forever()
'''

def docker(*args):
 r=subprocess.run(['docker',*args],text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError('docker operation failed: '+str(args[:2]))
 return r.stdout.strip()
def inspect(name):return json.loads(docker('inspect',name))[0]
def identity(x):return {k:v for k,v in {'Id':x['Id'],'Image':x['Image'],'StartedAt':x['State']['StartedAt'],'RestartCount':x['RestartCount'],'ExtraHosts':x['HostConfig'].get('ExtraHosts'),'Dns':x['HostConfig'].get('Dns')}.items()}
def save(name,value):
 p=ROOT/name;p.write_text(json.dumps(value,indent=2),encoding='utf-8');p.chmod(0o600)
def emit(value):print(json.dumps(value),flush=True)
def keys():return json.loads((ROOT/'private-keys.json').read_text())
def local(mode,path,body=None,timeout=15):
 req=urllib.request.Request('http://127.0.0.1:'+str(PORTS[mode])+path,
   data=json.dumps(body).encode() if body is not None else None,
   headers={'Authorization':'Bearer '+keys()[mode],'Content-Type':'application/json'})
 return urllib.request.urlopen(req,timeout=timeout)
def ready(mode):
 for _ in range(30):
  try:
   with local(mode,'/api/setAutoRefresh',{'autoRefresh':False},timeout=1) as r:
    assert r.status==200;return
  except Exception:time.sleep(.2)
 raise RuntimeError('diagnostic readiness timeout')
def stop():
 for mode in ['control','doh','resolver']:
  r=subprocess.run(['docker','stop','--time','2',NAMES[mode]],text=True,capture_output=True,timeout=15)
  emit({'stop':mode,'exit':r.returncode})
def setup():
 if ROOT.exists():raise RuntimeError('diagnostic directory already exists; inspect before reuse')
 baseline=inspect(PROD)
 for name in NAMES.values():
  if subprocess.run(['docker','container','inspect',name],capture_output=True).returncode==0:raise RuntimeError('diagnostic name already exists')
 ROOT.mkdir(mode=0o700)
 save('production-baseline.json',identity(baseline))
 (ROOT/'resolver.py').write_text(RESOLVER,encoding='utf-8');(ROOT/'resolver.py').chmod(0o644)
 source=json.loads(pathlib.Path('/data/coolify/applications/m04skwsg8kck8ckwkc04ssss/data/data.json').read_text())
 candidates=[]
 for account in source['accounts']:
  try:
   p=account['token'].split('.')[1];claims=json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4)))
   if claims['exp']>time.time()+600:candidates.append((claims['exp'],account))
  except Exception:pass
 if not candidates:raise RuntimeError('no existing session valid for at least ten minutes')
 exp,original=max(candidates,key=lambda item:item[0])
 account={k:original[k] for k in ['email','token','fingerprint'] if k in original}
 account.update({'password':'','proxy':'','expires':exp})
 k={mode:secrets.token_urlsafe(36) for mode in PORTS};save('private-keys.json',k)
 for mode,port in PORTS.items():
  p=ROOT/mode;p.mkdir(mode=0o700);data=p/'data';data.mkdir(mode=0o700)
  os.chown(data,1000,1000)
  f=data/'data.json';f.write_text(json.dumps({'accounts':[account],'settings':{'chatRetryCount':0,'chatRetryBackoffMs':0}}));f.chmod(0o600);os.chown(f,1000,1000)
  env=p/'diagnostic.env'
  env.write_text('\n'.join(['API_KEY='+k[mode],'DATA_SAVE_MODE=file','SERVICE_PORT=3000','LISTEN_ADDRESS=0.0.0.0','ENABLE_CLI=false','ENABLE_FILE_LOG=false','LOG_LEVEL=ERROR','MODELS_CACHE_TTL=1'])+'\n');env.chmod(0o600)
 docker('run','-d','--name',NAMES['resolver'],'--label','qwen-diagnostic=prod-doh-20261120','--network',NETWORK,'--ip',DNS_IP,'--restart','no','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--user','65534:65534','--memory','96m','--cpus','0.5','--pids-limit','80','--tmpfs','/tmp:rw,noexec,nosuid,size=8m','-v',str(ROOT/'resolver.py')+':/resolver.py:ro',HELPER,'python','-u','/resolver.py')
 for mode,port in PORTS.items():
  args=['run','-d','--name',NAMES[mode],'--label','qwen-diagnostic=prod-doh-20261120','--network',NETWORK,'--restart','no','--read-only','--cap-drop','ALL','--user','1000:1000','--memory','256m','--cpus','1','--pids-limit','128','--log-driver','none','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--tmpfs','/app/logs:rw,noexec,nosuid,uid=1000,gid=1000,size=8m','--tmpfs','/app/caches:rw,noexec,nosuid,uid=1000,gid=1000,size=16m','--env-file',str(ROOT/mode/'diagnostic.env'),'-v',str(ROOT/mode/'data')+':/app/data','-p','127.0.0.1:'+str(port)+':3000']
  if mode=='doh':args+=['--dns',DNS_IP]
  args+=[baseline['Image']];docker(*args);ready(mode)
  x=inspect(NAMES[mode]);emit({'started':mode,'image':x['Image'],'dns':x['HostConfig'].get('Dns'),'ExtraHosts':x['HostConfig'].get('ExtraHosts'),'port':port})
 emit({'selected_session_count':1,'password_copied':False,'proxy_copied':False,'session_remaining_seconds':round(exp-time.time()),'application_image_modified':False})
 save('setup-summary.json',{'production':identity(baseline),'helper':HELPER,'session_count':1,'password_copied':False,'proxy_copied':False,'session_exp':exp})

def catalog(mode):
 t=time.monotonic();result={'mode':mode,'operation':'catalog','utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
 try:
  with local(mode,'/v1/models',timeout=16) as r:
   z=json.loads(r.read(2000000));a=z.get('data',[])
   result.update({'http':r.status,'model_count':len(a),'has_qwen3_7_plus':any(q.get('id')=='qwen3.7-plus' for q in a)})
 except Exception as e:result['error']=type(e).__name__
 result['seconds']=round(time.monotonic()-t,3);save(mode+'-catalog.json',result);emit(result)
 return result

def preflight():
 x=inspect(NAMES['doh']);pid=str(x['State']['Pid'])
 for transport in ['udp','tcp']:
  a=['nsenter','-t',pid,'-n','dig','@'+DNS_IP,'chat.qwen.ai','A','+time=3','+tries=1','+noall','+answer']
  if transport=='tcp':a+=['+tcp']
  r=subprocess.run(a,text=True,capture_output=True,timeout=10);emit({'dns_probe':transport,'exit':r.returncode,'answer':r.stdout.strip()})
 for mode in PORTS:
  emit({'binary':mode,'sha256':docker('exec',NAMES[mode],'sha256sum','/usr/local/bin/qwen2api').split()[0]})
 emit({'production_unchanged':identity(inspect(PROD))==json.loads((ROOT/'production-baseline.json').read_text())})

def catalogs():
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  list(pool.map(catalog,PORTS))
 docker('stop','--time','2',NAMES['control'])
 print('control stopped to cancel its outstanding upstream request',flush=True)

def chat():
 prior=json.loads((ROOT/'doh-catalog.json').read_text())
 if not prior.get('model_count'):emit({'generation_skipped':'no upstream models'});return
 # Choose an actual advertised text model without guessing an obsolete model ID.
 with local('doh','/v1/models') as r:models=json.load(r)['data']
 ids={q.get('id') for q in models};model=next((v for v in ['qwen3.7-plus','qwen3.8-plus','qwen3.6-plus'] if v in ids),None)
 if not model:emit({'generation_skipped':'preferred text model not advertised'});return
 t=time.monotonic();out={'operation':'non_stream','model':model}
 try:
  with local('doh','/v1/chat/completions',{'model':model,'stream':False,'messages':[{'role':'user','content':'Reply with exactly OK'}],'max_tokens':16},timeout=35) as r:
   z=json.loads(r.read(200000));choices=z.get('choices',[]);content=choices[0].get('message',{}).get('content') if choices else None
   out.update({'http':r.status,'text_is_OK':isinstance(content,str) and content.strip()=='OK','content_length':len(content) if isinstance(content,str) else None})
 except urllib.error.HTTPError as e:
  b=e.read(200000)
  # Never print upstream error messages or response bodies.
  try:
   z=json.loads(b);err=z.get('error',{});out['error_code']=err.get('code') if isinstance(err,dict) else None
   text=json.dumps(err).lower();out['error_indicates_waf']=any(v in text for v in ['captcha','challenge','aliyun_waf']);out['error_indicates_auth']=any(v in text for v in ['unauthorized','invalid token','expired token'])
  except:pass
  out.update({'http':e.code,'error':'HTTPError'})
 except Exception as e:out['error']=type(e).__name__
 out['seconds']=round(time.monotonic()-t,3);save('non-stream.json',out);emit(out)
 if not out.get('text_is_OK'):emit({'stream_skipped':'non-stream did not pass; no retries or WAF workaround'});return
 t=time.monotonic();out={'operation':'stream','model':model,'done':False,'sse_error':False};chunks=[]
 try:
  with local('doh','/v1/chat/completions',{'model':model,'stream':True,'messages':[{'role':'user','content':'Reply with exactly OK'}],'max_tokens':16},timeout=35) as r:
   out['http']=r.status
   for raw in r:
    if not raw.startswith(b'data:'):continue
    data=raw[5:].strip()
    if data==b'[DONE]':out['done']=True;break
    try:
     z=json.loads(data)
     if 'error' in z:out['sse_error']=True
     for choice in z.get('choices',[]):
      content=choice.get('delta',{}).get('content')
      if isinstance(content,str):chunks.append(content)
    except json.JSONDecodeError:pass
   content=''.join(chunks);out.update({'text_is_OK':content.strip()=='OK','content_length':len(content),'content_chunks':len(chunks)})
 except Exception as e:out['error']=type(e).__name__
 out['seconds']=round(time.monotonic()-t,3);save('stream.json',out);emit(out)

def final():
 emit({'production_unchanged':identity(inspect(PROD))==json.loads((ROOT/'production-baseline.json').read_text())})
 for mode,name in NAMES.items():
  x=inspect(name);emit({'container':mode,'state':x['State']['Status'],'image':x['Image'],'Dns':x['HostConfig'].get('Dns'),'ExtraHosts':x['HostConfig'].get('ExtraHosts')})
 logs=docker('logs',NAMES['resolver'])
 # The resolver emits only explicitly designed DNS metadata; application logs are disabled.
 (ROOT/'resolver-safe.jsonl').write_text(logs,encoding='utf-8')
 emit({'resolver_events':[json.loads(l) for l in logs.splitlines() if l.startswith('{')]})

if __name__=='__main__':
 try:
  {'setup':setup,'preflight':preflight,'catalogs':catalogs,'chat':chat,'stop':stop,'final':final}[sys.argv[1]]()
 except Exception as e:
  emit({'fatal_type':type(e).__name__,'phase':sys.argv[1]})
  if sys.argv[1]=='setup':stop()
  sys.exit(1)
