# Struttura certificati SDI

Questa cartella contiene i file SDI usati dal CRM per:

- test diagnostici locali;
- preparazione del canale WS;
- collaudo con kit di test;
- configurazione futura di ricezione e trasmissione.

## Struttura

- `production/`
  - `client.crt`: certificato client HORYGON
  - `client.key`: chiave privata che al momento combacia con il certificato client
  - `server.crt`: certificato server HORYGON
  - `ca.crt`: CA produzione
  - `sdi-prod-server.crt`: certificato server esposto da SdI in produzione
  - `sdi-prod-client-public.crt`: certificato client pubblico usato da SdI in produzione
- `test/`
  - `ca-test.crt`: CA test
  - `sdi-test-server.crt`: certificato server esposto da SdI in test
  - `sdi-test-client-public.crt`: certificato client pubblico usato da SdI in test
  - `piano_test_interoperabilita_SDICoop.pdf`
- `csr/`
  - `client.csr`
  - `server.csr`
  - guida operativa scaricata dal Sistema di Accreditamento

## Nota importante

Il certificato `server.crt` richiede una chiave privata dedicata distinta da `client.key`.
Fino a quando la chiave server non viene aggiunta e configurata, il test CRM segnalerà la situazione come `warning`.
