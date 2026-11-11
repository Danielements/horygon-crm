from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
root=Path(__file__).resolve().parents[1]
with ZipFile(root/"artifacts/Merlino-press-Server-0.9.0-linux-source.zip","w",ZIP_DEFLATED) as archive:
 for name in ["Horygon.Core","Horygon.Data","Horygon.Email","Horygon.AI","Horygon.Server","config","deploy","Directory.Build.props",".dockerignore","SERVER_SETUP.md"]:
  path=root/name
  for item in ([path] if path.is_file() else path.rglob("*")):
   if item.is_file() and not set(item.relative_to(root).parts)&{"bin","obj",".env","__pycache__","data"}:
    archive.write(item,item.relative_to(root))
print("Pacchetto Linux: artifacts/Merlino-press-Server-0.9.0-linux-source.zip")
