import argparse, base64, os, secrets, re
from pathlib import Path
parser=argparse.ArgumentParser(description="Prepara Horygon Server senza avviare servizi")
group=parser.add_mutually_exclusive_group(required=True)
group.add_argument("--domain",help="Dominio HTTPS pubblico, esempio ordini.azienda.it")
group.add_argument("--lan-http",action="store_true",help="Solo prova in rete fidata sulla porta 80; non esporre su Internet")
args=parser.parse_args()
if args.domain and not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?",args.domain):parser.error("Dominio non valido")
path=Path(__file__).resolve().parent/".env"
content="\n".join(["HORYGON_ADMIN_KEY="+secrets.token_hex(32),"HORYGON_VIEWER_KEY="+secrets.token_hex(32),"HORYGON_DATA_KEY="+base64.b64encode(secrets.token_bytes(32)).decode(),"HORYGON_DOMAIN="+(args.domain or ""),"HORYGON_PUBLIC_ORIGIN="+("https://"+args.domain if args.domain else ""),"HORYGON_BIND="+("127.0.0.1:5080" if args.domain else "0.0.0.0:80")])+"\n"
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w",encoding="utf-8") as f:f.write(content)
print("Creato deploy/.env. Conservare una copia protetta: contiene i codici di accesso e la chiave dell'archivio. Nessun servizio avviato.")
