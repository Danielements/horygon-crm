# Codici Endpoint SDI Horygon

Ultimo aggiornamento: 2026-08-07

Endpoint associato:

- `https://sdi.horygon.it/api/sdi/ws/inbound`

Verificato sul VPS il 2026-08-07: `sdi.horygon.it` espone il certificato server
emesso dall'Agenzia delle Entrate (`CN = SDI-03365990591`, issuer `CA Agenzia
delle Entrate`) ed e' l'unico vhost instradato su `/api/sdi/ws/inbound`.
`crm.horygon.it` presenta un certificato Let's Encrypt e non e' il canale
accreditato: una precedente versione di questo documento lo indicava per errore.

## Codici destinatario PA

- `ESOJKL`
- `VRRMFL`
- `ESOWLS`

## Codici destinatario B2B

- `UMZGLCP`
- `TLYFKZO`
- `SKXEJYN`

## Note

- Tutti i codici sopra risultano associati allo stesso endpoint di ricezione `WS`.
- Questi codici vanno conservati come riferimento operativo per test di interoperabilita', configurazioni IPA/PA e successiva attivazione in produzione.
- Un solo endpoint serve sia `TrasmissioneFatture` sia `RicezioneFatture`: i due
  contratti vengono distinti dal dispatcher per namespace, SOAPAction e operation
  (necessario perche' `NotificaDecorrenzaTermini` esiste in entrambi con lo stesso
  localName). Non vanno separati.
