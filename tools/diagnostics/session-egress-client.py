#!/usr/bin/env python3
"""Isolated helper: credentials enter via stdin only; stdout is an allowlist summary."""
import base64,concurrent.futures,gzip,http.client,json,socket,ssl,sys,time,zlib
payload=json.load(sys.stdin)
token=payload['token'];headers={k.lower():str(v) for k,v in payload['headers'].items()}
assert headers.get('authorization')=='Bearer '+token
same_cookie=any(v.strip()=='token='+token for v in headers.get('cookie','').split(';'))
assert same_cookie
headers.update({'host':'chat.qwen.ai','accept':'application/json','connection':'close','accept-encoding':'gzip'})
headers.pop('content-length',None);headers.pop('transfer-encoding',None)
from urllib.parse import urlsplit,unquote
proxy=urlsplit(payload['proxy']);assert proxy.scheme=='http'
claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'='*(-len(token.split('.')[1])%4)))

def classify(body,encoding):
 if encoding=='gzip':body=gzip.decompress(body)
 elif encoding=='deflate':body=zlib.decompress(body)
 elif encoding not in ['', 'identity']:return {'classification_unavailable_encoding':True}
 text=body.decode('utf-8','replace');result={'html_body':text.lstrip().lower().startswith(('<!doctype html','<html')),'waf_marker':any(s in text.lower() for s in ['aliyun_waf_','aliyuncaptcha','_waf_is_mobile','fail_sys_user_validate','rgv587'])}
 try:
  z=json.loads(text);result['json_body']=True
  uid=z.get('id') or (z.get('data') or {}).get('id') if isinstance(z,dict) else None
  result['user_identity_present']=bool(uid);result['user_identity_matches_session']=uid==claims.get('id') and bool(uid)
 except Exception:result['json_body']=False
 return result

def probe(route,pin=None,control=False):
 t=time.monotonic();out={'route':route,'bearer_matches_session':not control,'cookie_matches_session':same_cookie if not control else False};sock=None;stage='tcp'
 try:
  if route=='direct_doh':
   sock=socket.create_connection(('chat.qwen.ai',443),timeout=7);out['dynamic_target_ip']=sock.getpeername()[0]
  else:
   sock=socket.create_connection((proxy.hostname,proxy.port or 80),timeout=7);sock.settimeout(7);stage='proxy_connect'
   target=(pin or 'chat.qwen.ai')+':443';wire='CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\n'
   if proxy.username or proxy.password:wire+='Proxy-Authorization: Basic '+base64.b64encode((unquote(proxy.username or '')+':'+unquote(proxy.password or '')).encode()).decode()+'\r\n'
   sock.sendall((wire+'\r\n').encode());head=b''
   while b'\r\n\r\n' not in head and len(head)<32768:
    part=sock.recv(1)
    if not part:break
    head+=part
   out['proxy_connect_status']=int(head.split(b'\r\n',1)[0].split()[1])
   if out['proxy_connect_status']!=200:return out
   if pin:out['dynamic_target_ip']=pin
  stage='tls_handshake'
  with ssl.create_default_context().wrap_socket(sock,server_hostname='chat.qwen.ai') as secure:
   sock=secure;secure.settimeout(30);out.update({'tls_verified':True,'tls':secure.version()})
   sent_headers=headers if not control else {'host':'chat.qwen.ai','accept':'application/json','accept-encoding':'gzip','connection':'close','user-agent':headers.get('user-agent','')}
   path='/api/models' if control else '/api/v1/auths/'
   wire='GET '+path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in sent_headers.items())+'\r\n';stage='send_request';secure.sendall(wire.encode());out['request_bytes']=len(wire.encode())
   stage='http_headers';response=http.client.HTTPResponse(secure);response.begin()
   typ=response.getheader('content-type','').split(';')[0].lower();out.update({'http':response.status,'content_type':typ if typ in ['application/json','text/html'] else 'other'})
   stage='http_body';body=response.read(512*1024);out['body_bytes']=len(body)
   out.update(classify(body,response.getheader('content-encoding','').lower()))
 except Exception as e:out.update({'transport_error_type':type(e).__name__,'stage':stage})
 finally:
  if sock:
   try:sock.close()
   except Exception:pass
  out['seconds']=round(time.monotonic()-t,3)
 return out

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 direct,proxied=list(pool.map(probe,['direct_doh','original_http_proxy']))
results=[direct,proxied]
print(json.dumps({'client':'python-stdlib-same-tls-profile-both-routes','same_session':True,'same_header_profile':True,'generation_requests':0,'results':results}),flush=True)
