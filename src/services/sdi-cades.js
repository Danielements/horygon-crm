const crypto = require('crypto');

// Encoder CAdES-BES (CMS SignedData, RFC 5652 + RFC 5035) per la firma delle
// fatture elettroniche destinate alla PA.
//
// Specifiche tecniche SdI 1.8.4 par. 2.1: la fattura destinata a pubblica
// amministrazione deve essere firmata con certificato di firma elettronica
// qualificata in formato CAdES Baseline B, con riferimento temporale
// valorizzato nell'attributo firmato "signing time". Il file assume estensione
// .xml.p7m.
//
// L'output e' un CMS SignedData in DER con contenuto incapsulato (non detached),
// contenente gli attributi firmati obbligatori per il profilo BES:
//   - contentType
//   - signingTime
//   - messageDigest
//   - signing-certificate-v2 (ESS, RFC 5035)

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  attrContentType: '1.2.840.113549.1.9.3',
  attrMessageDigest: '1.2.840.113549.1.9.4',
  attrSigningTime: '1.2.840.113549.1.9.5',
  attrSigningCertificateV2: '1.2.840.113549.1.9.16.2.47'
};

const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utcTime: 0x17,
  sequence: 0x30,
  set: 0x31
};

function signCadesBes({ content, certificatePem, privateKeyPem, passphrase = '', chainPem = [], signingTime = new Date() }) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (!data.length) throw new Error('Contenuto da firmare vuoto');

  const signerDer = certificateDer(certificatePem);
  const chainDer = (Array.isArray(chainPem) ? chainPem : [chainPem])
    .filter(Boolean)
    .map(certificateDer)
    .filter((der) => !der.equals(signerDer));

  const privateKey = crypto.createPrivateKey(
    passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem
  );
  assertKeyMatchesCertificate(privateKey, signerDer);

  const signerFields = readCertificateFields(signerDer);
  const messageDigest = sha256(data);
  const certHash = sha256(signerDer);

  const signedAttributes = [
    attribute(OID.attrContentType, tlv(TAG.set, oid(OID.data))),
    attribute(OID.attrSigningTime, tlv(TAG.set, utcTime(signingTime))),
    attribute(OID.attrMessageDigest, tlv(TAG.set, tlv(TAG.octetString, messageDigest))),
    attribute(OID.attrSigningCertificateV2, tlv(TAG.set, signingCertificateV2(certHash, signerFields)))
  ];

  // Il valore firmato e' la codifica DER del SET OF attributi (tag 0x31),
  // non la forma [0] IMPLICIT usata dentro SignerInfo (RFC 5652 par. 5.4).
  const signedAttrsForSigning = derSetOf(signedAttributes);
  const signedAttrsImplicit = Buffer.concat([Buffer.from([0xa0]), signedAttrsForSigning.subarray(1)]);

  const signatureAlgorithm = signatureAlgorithmFor(privateKey);
  const signature = crypto.sign('sha256', signedAttrsForSigning, privateKey);

  const signerInfo = tlv(TAG.sequence, Buffer.concat([
    integer(1),
    tlv(TAG.sequence, Buffer.concat([signerFields.issuer, signerFields.serialNumber])),
    algorithmIdentifier(OID.sha256),
    signedAttrsImplicit,
    signatureAlgorithm,
    tlv(TAG.octetString, signature)
  ]));

  const encapContentInfo = tlv(TAG.sequence, Buffer.concat([
    oid(OID.data),
    contextExplicit(0, tlv(TAG.octetString, data))
  ]));

  const certificates = contextImplicitConstructed(0, Buffer.concat([signerDer, ...chainDer]));

  const signedData = tlv(TAG.sequence, Buffer.concat([
    integer(1),
    derSetOf([algorithmIdentifier(OID.sha256)]),
    encapContentInfo,
    certificates,
    derSetOf([signerInfo])
  ]));

  return tlv(TAG.sequence, Buffer.concat([
    oid(OID.signedData),
    contextExplicit(0, signedData)
  ]));
}

function signingCertificateV2(certHash, signerFields) {
  // ESSCertIDv2: hashAlgorithm ha come DEFAULT sha256 e in DER un valore di
  // default va omesso (RFC 5035 par. 4).
  const issuerSerial = tlv(TAG.sequence, Buffer.concat([
    tlv(TAG.sequence, contextExplicit(4, signerFields.issuer)),
    signerFields.serialNumber
  ]));
  const essCertIdV2 = tlv(TAG.sequence, Buffer.concat([
    tlv(TAG.octetString, certHash),
    issuerSerial
  ]));
  return tlv(TAG.sequence, tlv(TAG.sequence, essCertIdV2));
}

function attribute(attrOid, valuesSet) {
  return tlv(TAG.sequence, Buffer.concat([oid(attrOid), valuesSet]));
}

function algorithmIdentifier(algorithmOid, includeNullParams = false) {
  // RFC 5754: per gli algoritmi di digest SHA-2 i parametri vanno omessi.
  const params = includeNullParams ? tlv(TAG.null, Buffer.alloc(0)) : Buffer.alloc(0);
  return tlv(TAG.sequence, Buffer.concat([oid(algorithmOid), params]));
}

function signatureAlgorithmFor(privateKey) {
  const type = privateKey.asymmetricKeyType;
  if (type === 'rsa' || type === 'rsa-pss') return algorithmIdentifier(OID.rsaEncryption, true);
  if (type === 'ec') return algorithmIdentifier(OID.ecdsaWithSha256);
  throw new Error(`Tipo di chiave non supportato per la firma SdI: ${type || 'sconosciuto'}`);
}

function assertKeyMatchesCertificate(privateKey, certificateDerBuffer) {
  const certificate = new crypto.X509Certificate(certificateDerBuffer);
  const fromCert = certificate.publicKey.export({ type: 'spki', format: 'pem' });
  const fromKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (fromCert !== fromKey) {
    throw new Error('La chiave privata di firma non corrisponde al certificato di firma');
  }
}

// --- lettura certificato ------------------------------------------------

function certificateDer(source) {
  const raw = Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''), 'utf8');
  const text = raw.toString('utf8');
  const pemMatch = text.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (pemMatch) return Buffer.from(pemMatch[1].replace(/\s+/g, ''), 'base64');
  const compact = text.replace(/\s+/g, '');
  if (compact && /^[A-Za-z0-9+/=]+$/.test(compact)) return Buffer.from(compact, 'base64');
  return raw;
}

function readCertificateFields(der) {
  const certificate = readTlv(der, 0);
  if (certificate.tag !== TAG.sequence) throw new Error('Certificato di firma non in formato DER valido');
  const tbs = readTlv(der, certificate.contentStart);
  if (tbs.tag !== TAG.sequence) throw new Error('TBSCertificate non trovato nel certificato di firma');

  let offset = tbs.contentStart;
  const end = tbs.contentStart + tbs.length;
  let current = readTlv(der, offset);
  if (current.tag === 0xa0) {
    offset += current.totalLength;
    current = readTlv(der, offset);
  }
  const serialNumber = der.subarray(offset, offset + current.totalLength);
  offset += current.totalLength;

  const signatureAlgorithm = readTlv(der, offset);
  offset += signatureAlgorithm.totalLength;
  if (offset >= end) throw new Error('Issuer non trovato nel certificato di firma');

  const issuerTlv = readTlv(der, offset);
  const issuer = der.subarray(offset, offset + issuerTlv.totalLength);

  return { serialNumber: Buffer.from(serialNumber), issuer: Buffer.from(issuer) };
}

// Estrae il contenuto incapsulato da un CMS SignedData (file .p7m).
//
// Percorso: ContentInfo -> [0] -> SignedData -> encapContentInfo -> [0] ->
// OCTET STRING. L'OCTET STRING puo' essere primitivo (0x04) oppure costruito
// (0x24) e spezzato in segmenti, che vanno riuniti.
//
// L'originale firmato non va mai sostituito da quello estratto: questa
// funzione serve a leggere il contenuto, non a rimpiazzare il file fiscale.
function extractCmsContent(der) {
  const buffer = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const contentInfo = readTlv(buffer, 0);
  if (contentInfo.tag !== TAG.sequence) throw new Error('File P7M non valido: ContentInfo assente');

  let offset = contentInfo.contentStart;
  const contentType = readTlv(buffer, offset);
  if (contentType.tag !== TAG.oid) throw new Error('File P7M non valido: contentType assente');
  offset += contentType.totalLength;

  const explicit = readTlv(buffer, offset);
  if (explicit.tag !== 0xa0) throw new Error('File P7M non valido: contenuto SignedData assente');

  const signedData = readTlv(buffer, explicit.contentStart);
  if (signedData.tag !== TAG.sequence) throw new Error('File P7M non valido: SignedData assente');

  let inner = signedData.contentStart;
  const end = signedData.contentStart + signedData.length;
  const version = readTlv(buffer, inner);
  inner += version.totalLength;
  const digestAlgorithms = readTlv(buffer, inner);
  inner += digestAlgorithms.totalLength;
  if (inner >= end) throw new Error('File P7M non valido: encapContentInfo assente');

  const encap = readTlv(buffer, inner);
  if (encap.tag !== TAG.sequence) throw new Error('File P7M non valido: encapContentInfo malformato');

  let encapOffset = encap.contentStart;
  const eContentType = readTlv(buffer, encapOffset);
  encapOffset += eContentType.totalLength;
  if (encapOffset >= encap.contentStart + encap.length) {
    throw new Error('File P7M senza contenuto incapsulato (firma detached)');
  }

  const eContentWrapper = readTlv(buffer, encapOffset);
  if (eContentWrapper.tag !== 0xa0) throw new Error('File P7M non valido: eContent assente');
  return readOctetString(buffer, eContentWrapper.contentStart);
}

// Estrae i certificati inclusi nel CMS: servono per mostrare chi ha firmato e
// per verificare scadenza e emittente senza dipendere da servizi esterni.
function extractCmsCertificates(der) {
  const buffer = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const contentInfo = readTlv(buffer, 0);
  let offset = contentInfo.contentStart;
  offset += readTlv(buffer, offset).totalLength; // contentType
  const explicit = readTlv(buffer, offset);
  const signedData = readTlv(buffer, explicit.contentStart);

  let inner = signedData.contentStart;
  const end = signedData.contentStart + signedData.length;
  inner += readTlv(buffer, inner).totalLength; // version
  inner += readTlv(buffer, inner).totalLength; // digestAlgorithms
  inner += readTlv(buffer, inner).totalLength; // encapContentInfo
  if (inner >= end) return [];

  const candidate = readTlv(buffer, inner);
  // I certificati sono in [0] IMPLICIT, opzionale.
  if (candidate.tag !== 0xa0) return [];

  const certificates = [];
  let cursor = candidate.contentStart;
  const limit = candidate.contentStart + candidate.length;
  while (cursor < limit) {
    const cert = readTlv(buffer, cursor);
    if (cert.tag === TAG.sequence) {
      certificates.push(Buffer.from(buffer.subarray(cursor, cursor + cert.totalLength)));
    }
    cursor += cert.totalLength;
  }
  return certificates;
}

function readOctetString(buffer, offset) {
  const node = readTlv(buffer, offset);
  if (node.tag === TAG.octetString) {
    return Buffer.from(buffer.subarray(node.contentStart, node.contentStart + node.length));
  }
  // OCTET STRING costruito: concatena i segmenti primitivi contenuti.
  if (node.tag === (TAG.octetString | 0x20)) {
    const parts = [];
    let cursor = node.contentStart;
    const limit = node.contentStart + node.length;
    while (cursor < limit) {
      const segment = readTlv(buffer, cursor);
      parts.push(buffer.subarray(segment.contentStart, segment.contentStart + segment.length));
      cursor += segment.totalLength;
    }
    return Buffer.concat(parts);
  }
  throw new Error('File P7M non valido: contenuto incapsulato non e una OCTET STRING');
}

function readTlv(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('Struttura DER troncata');
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let length;
  let headerLength;
  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;
    // count = 0 e' la forma indefinita del BER: il contenuto non dichiara la
    // propria lunghezza e finisce a un end-of-contents (00 00). Molti
    // dispositivi di firma la usano, e rifiutarla rendeva illeggibili p7m
    // perfettamente validi. Per sapere dove finisce bisogna percorrere i figli,
    // che a loro volta possono essere indefiniti.
    if (count === 0) {
      let cursor = offset + 2;
      while (cursor + 1 < buffer.length) {
        if (buffer[cursor] === 0x00 && buffer[cursor + 1] === 0x00) {
          return {
            tag,
            length: cursor - (offset + 2),
            headerLength: 2,
            contentStart: offset + 2,
            totalLength: (cursor + 2) - offset,
            indefinite: true
          };
        }
        const figlio = readTlv(buffer, cursor);
        if (figlio.totalLength <= 0) throw new Error('Struttura DER incoerente');
        cursor += figlio.totalLength;
      }
      throw new Error('Struttura DER troncata: end-of-contents mancante');
    }
    if (count > 4) throw new Error('Lunghezza DER non supportata');
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | buffer[offset + 2 + i];
    headerLength = 2 + count;
  }
  return { tag, length, headerLength, contentStart: offset + headerLength, totalLength: headerLength + length };
}

// --- primitive DER ------------------------------------------------------

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function integer(value) {
  const bytes = [];
  let remaining = Math.trunc(value);
  do {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  } while (remaining > 0);
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return tlv(TAG.integer, Buffer.from(bytes));
}

function oid(dotted) {
  const parts = String(dotted).split('.').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`OID non valido: ${dotted}`);
  }
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    const chunk = [];
    let value = parts[i];
    do {
      chunk.unshift(value & 0x7f);
      value = Math.floor(value / 128);
    } while (value > 0);
    for (let j = 0; j < chunk.length - 1; j += 1) chunk[j] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(TAG.oid, Buffer.from(bytes));
}

function utcTime(date) {
  const value = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const text = [
    pad(value.getUTCFullYear() % 100),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds())
  ].join('') + 'Z';
  return tlv(TAG.utcTime, Buffer.from(text, 'ascii'));
}

function contextExplicit(number, content) {
  return tlv(0xa0 | number, content);
}

function contextImplicitConstructed(number, content) {
  return tlv(0xa0 | number, content);
}

// In DER gli elementi di un SET OF vanno ordinati per codifica binaria
// (X.690 par. 11.6).
function derSetOf(elements) {
  const sorted = [...elements].sort(Buffer.compare);
  return tlv(TAG.set, Buffer.concat(sorted));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

module.exports = {
  OID,
  certificateDer,
  extractCmsCertificates,
  extractCmsContent,
  readCertificateFields,
  signCadesBes
};
