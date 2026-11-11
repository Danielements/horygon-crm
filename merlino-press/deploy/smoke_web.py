import os,sys,time,json,subprocess,urllib.request,urllib.error,http.cookiejar,secrets,base64
from pathlib import Path
root=Path(__file__).resolve().parents[1]
data=root/"artifacts"/("server-smoke-"+str(int(time.time())));data.mkdir()
port=int(sys.argv[1]) if len(sys.argv)>1 else 5087
url="http://127.0.0.1:"+str(port)
env=os.environ.copy();env.update(HORYGON_DEMO="1",HORYGON_DATA=str(data),HORYGON_URLS=url,HORYGON_PUBLIC_ORIGIN="",HORYGON_ADMIN_KEY="synthetic-operator-code-090-only",HORYGON_VIEWER_KEY="synthetic-viewer-code-090-only",HORYGON_DATA_KEY=base64.b64encode(secrets.token_bytes(32)).decode())
log=(data/"server.log").open("w",encoding="utf-8")
def start():
 p=subprocess.Popen([str(root/".dotnet/dotnet.exe"),str(root/"artifacts/Horygon-Server-0.9.0-portable/Horygon.Server.dll")],env=env,stdout=log,stderr=log,creationflags=0x08000000)
 for _ in range(80):
  try:urllib.request.urlopen(url+"/health",timeout=1);return p
  except Exception:
   if p.poll() is not None:raise RuntimeError("Server failed to start; see "+str(data/"server.log"))
   time.sleep(.2)
 p.terminate();raise RuntimeError("Server startup timeout")
def client():return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(c,path,payload=None,expected=200,csrf=True,extra_headers=None):
 headers={"Content-Type":"application/json"}
 if csrf:headers["X-Horygon"]="1"
 if extra_headers:headers.update(extra_headers)
 req=urllib.request.Request(url+path,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
 try:r=c.open(req);status=r.status;body=r.read()
 except urllib.error.HTTPError as e:status=e.code;body=e.read()
 assert status==expected,(path,status,body[:250])
 return json.loads(body) if body else None
p=start()
try:
 guest=client();call(guest,"/api/board",expected=401)
 call(guest,"/api/login",{"code":"wrong"},expected=401)
 admin=client();call(admin,"/api/login",{"code":env["HORYGON_ADMIN_KEY"]})
 for i,area in enumerate(["Ordini","Attività","Alert","Contabilità","Logistica"]):
  call(admin,"/api/record",{"id":"manual:"+str(i),"area":area,"title":["Ordine 2487 · materiali","Call conferma consegna","Ritardo da verificare","Fattura ordine 2487","Spedizione ordine 2487"][i],"orderNumber":"2487","status":"In corso","owner":"Team test","problem":"Verificare ritardo" if area=="Alert" else "","nextAction":"Confermare con il referente","tracking":"TEST12345678" if area=="Logistica" else "","carrier":"DHL" if area=="Logistica" else "","revision":0,"emailIds":[]})
 board=call(admin,"/api/board");assert len(board["records"])==5
 row=board["records"][0];call(admin,"/api/record",row,expected=403,csrf=False)
 call(admin,"/api/record",row);call(admin,"/api/record",row,expected=409)
 view=client();call(view,"/api/login",{"code":env["HORYGON_VIEWER_KEY"]});call(view,"/api/board");call(view,"/api/record",row,expected=403);call(view,"/api/settings",expected=403)
 call(guest,"/api/status",expected=401)
 call(view,"/api/status-settings",expected=403)
 call(view,"/api/status-settings",{"ordersPerPage":3},expected=403)
 config=call(admin,"/api/status-settings");status_key=config["statusPath"].split("#")[1]
 status_headers={"X-Horygon-Status":status_key}
 call(admin,"/api/status-settings",{"ordersPerPage":0},expected=400)
 call(admin,"/api/status-settings",{"ordersPerPage":31},expected=400)
 call(admin,"/api/status-settings",{"ordersPerPage":3})
 status=call(guest,"/api/status",extra_headers=status_headers)
 assert status["ordersPerPage"]==3 and len(status["records"])==1
 assert set(status["records"][0])=={"number","name","description","status","printer","production"}
 call(view,"/api/printers",{"id":"printer:test","name":"Test"},expected=403)
 call(admin,"/api/printers",{"id":"printer:test","name":"Stampante prova","services":"RIP, stampa","endpoint":"127.0.0.1","ports":[port],"brand":"Ricoh","revision":0})
 call(view,"/api/printers/printer:test/test",{},expected=403)
 probe=call(admin,"/api/printers/printer:test/test",{})
 assert probe["results"][0]["reachable"]
 call(admin,"/api/printers",{"id":"printer:remove","name":"Da rimuovere","revision":0})
 call(admin,"/api/printers/printer:remove/delete",{"revision":1})
 assert len(call(admin,"/api/board")["printers"])==1
 call(admin,"/api/printers/printer:remove/test",{},expected=404)
 printer=call(admin,"/api/board")["printers"][0]
 printer["model"]="Controller di prova";call(admin,"/api/printers",printer)
 call(admin,"/api/printers",printer,expected=409)
 assert call(admin,"/api/board")["printers"][0]["model"]=="Controller di prova"
 call(admin,"/api/printers",{"id":"printer:bad","name":"Bad","endpoint":"http://user:password@example.com"},expected=400)
 order=next(x for x in call(admin,"/api/board")["records"] if x["area"]=="Ordini")
 order.update(printerId="printer:missing",productionState="In lavorazione")
 call(admin,"/api/record",order,expected=400)
 order["printerId"]="printer:test";call(admin,"/api/record",order)
 call(admin,"/api/printers/printer:test/delete",{"revision":2},expected=409)
 second={**order,"id":"manual:conflict","revision":0};call(admin,"/api/record",second,expected=409)
 status=call(guest,"/api/status",extra_headers=status_headers)
 assert status["records"][0]["printer"]=="Stampante prova" and status["records"][0]["production"]=="In lavorazione"
 call(guest,"/api/board",expected=401,extra_headers=status_headers)
 call(guest,"/api/status",expected=401,extra_headers={"X-Horygon-Status":"wrong"})
 call(admin,"/api/work/sync",{},expected=202)
 for _ in range(40):
  state=call(admin,"/api/board")["work"]
  if not state["busy"]:break
  time.sleep(.2)
 assert "account" in state["status"].lower(),state
 p.terminate();p.wait(timeout=10);p=start()
 call(admin,"/api/board",expected=401)
 status=call(guest,"/api/status",extra_headers=status_headers)
 assert status["ordersPerPage"]==3 and len(status["records"])==1
 assert status["records"][0]["printer"]=="Stampante prova"
 assert b"STATUS ORDINI" in urllib.request.urlopen(url+"/status.html").read()
 admin=client();call(admin,"/api/login",{"code":env["HORYGON_ADMIN_KEY"]});assert len(call(admin,"/api/board")["records"])==5
 page=urllib.request.urlopen(url).read();assert b"Operativit" in page
 result={"api_tests":"passed","records_persisted":5,"url":url,"pid":p.pid,"data":str(data)}
 (root/"artifacts/server-smoke-result.json").write_text(json.dumps(result),encoding="utf-8")
 print(json.dumps(result))
except Exception:
 p.terminate();p.wait(timeout=10);raise
