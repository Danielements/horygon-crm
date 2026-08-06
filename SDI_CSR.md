# CSR SDI per Horygon CRM

Questo progetto importa gia le fatture da XML SDI e da CSV/XLS/XLSX. Per uno step successivo di import automatico dal Sistema di Interscambio, serve preparare la coppia chiave/CSR richiesta dal canale SDI.

## Requisiti CSR

- Il `Common Name` deve contenere il codice del sottoscrittore preceduto da `SDI-`.
- Esempio: `SDI-01234567891`
- Formati CSR accettati da SDI: `.der`, `.pem`, `.arm`

## Script incluso

Nel repository e disponibile lo script [generate-sdi-csr.ps1](/C:/Users/lelef/Documents/HORYGON/CRM/scripts/generate-sdi-csr.ps1) che genera:

- chiave RSA 2048 bit
- CSR in formato PEM
- CSR in formato DER opzionale
- file di configurazione OpenSSL usato per la richiesta

## Esempio d'uso

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-sdi-csr.ps1 `
  -SubjectCode 01234567891 `
  -Organization "Nome Azienda" `
  -Province "Roma" `
  -Locality "Roma" `
  -Der
```

Se `SubjectCode` non inizia gia con `SDI-`, lo script lo aggiunge automaticamente.

## Output generato

Per default i file vengono scritti in `.\tmp\sdi-csr`:

- `sdi.key`
- `sdi.csr.pem`
- `sdi.csr.der` se richiesto con `-Der`
- `sdi-openssl.cnf`

## Equivalente OpenSSL manuale

```powershell
openssl genrsa -out mykey.key 2048
openssl req -new -key mykey.key -out mycsr.csr
```

Campi principali da usare:

- `C = IT`
- `ST = Provincia`
- `O = Nome Azienda`
- `CN = SDI-<codice>`

## Nota operativa

Per la CSR client, la documentazione SDI richiede:

- nel campo paese dell'identificativo fiscale il paese del sottoscrittore
- nel `Common Name` il valore del codice preceduto da `SDI-`

Per la CSR server, in alternativa al codice `SDI-*`, si puo usare l'hostname del server che espone il servizio.
