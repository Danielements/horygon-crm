function buildOrdinaryInvoiceXml(payload) {
  const customerHasVat = Boolean(payload.customer.vat?.code);
  const customerHasFiscalCode = Boolean(payload.customer.fiscalCode);
  const transmissionContacts = renderOptionalBlock('ContattiTrasmittente', [
    renderOptionalTag('Telefono', payload.transmitter?.phone),
    renderOptionalTag('Email', payload.transmitter?.email)
  ]);
  const cedenteContatti = renderOptionalBlock('Contatti', [
    renderOptionalTag('Telefono', payload.company.phone),
    renderOptionalTag('Fax', payload.company.fax),
    renderOptionalTag('Email', payload.company.pec || payload.company.email)
  ]);
  const pagamenti = renderPaymentBlocks(payload.payment);
  const bodyLines = payload.lines.map((line) => `
        <DettaglioLinee>
          <NumeroLinea>${line.numeroLinea}</NumeroLinea>
          <Descrizione>${xmlEscape(line.descrizione)}</Descrizione>
          ${line.quantita != null ? `<Quantita>${formatDecimal(line.quantita, 8)}</Quantita>` : ''}
          ${line.unitaMisura ? `<UnitaMisura>${xmlEscape(line.unitaMisura)}</UnitaMisura>` : ''}
          <PrezzoUnitario>${formatDecimal(line.prezzoUnitario, 8)}</PrezzoUnitario>
          ${renderScontoMaggiorazione(line.scontoMaggiorazione)}
          <PrezzoTotale>${formatDecimal(line.totaleRiga, 8)}</PrezzoTotale>
          <AliquotaIVA>${formatDecimal(line.aliquotaIva, 2)}</AliquotaIVA>
          ${line.naturaIva ? `<Natura>${xmlEscape(line.naturaIva)}</Natura>` : ''}
        </DettaglioLinee>`).join('\n');
  const bodySummary = payload.riepilogo.map((row) => `
        <DatiRiepilogo>
          <AliquotaIVA>${formatDecimal(row.aliquotaIva, 2)}</AliquotaIVA>
          ${row.naturaIva ? `<Natura>${xmlEscape(row.naturaIva)}</Natura>` : ''}
          <ImponibileImporto>${formatDecimal(row.imponibile, 2)}</ImponibileImporto>
          <Imposta>${formatDecimal(row.imposta, 2)}</Imposta>
          ${row.esigibilitaIva ? `<EsigibilitaIVA>${xmlEscape(row.esigibilitaIva)}</EsigibilitaIVA>` : ''}
          ${row.riferimentoNormativo ? `<RiferimentoNormativo>${xmlEscape(row.riferimentoNormativo)}</RiferimentoNormativo>` : ''}
        </DatiRiepilogo>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="${payload.formatoTrasmissione}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="${xmlEscape(payload.namespace)}">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
        <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${xmlEscape(payload.fileProgressivo)}</ProgressivoInvio>
      <FormatoTrasmissione>${payload.formatoTrasmissione}</FormatoTrasmissione>
      <CodiceDestinatario>${xmlEscape(payload.destinationCode || '0000000')}</CodiceDestinatario>
      ${transmissionContacts}
      ${shouldRenderPecDestinatario(payload) ? `<PECDestinatario>${xmlEscape(payload.pecDestinatario)}</PECDestinatario>` : ''}
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA>
          <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
          <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
        </IdFiscaleIVA>
        <CodiceFiscale>${xmlEscape(payload.company.fiscalCode)}</CodiceFiscale>
        <Anagrafica>
          <Denominazione>${xmlEscape(payload.company.denomination)}</Denominazione>
        </Anagrafica>
        <RegimeFiscale>${xmlEscape(payload.company.regimeFiscale)}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(payload.company.address)}</Indirizzo>
        ${renderOptionalTag('NumeroCivico', payload.company.streetNumber)}
        <CAP>${xmlEscape(payload.company.cap)}</CAP>
        <Comune>${xmlEscape(payload.company.city)}</Comune>
        <Provincia>${xmlEscape(payload.company.province)}</Provincia>
        <Nazione>${xmlEscape(payload.company.country)}</Nazione>
      </Sede>
      ${payload.company.reaOffice && payload.company.reaNumber ? `
      <IscrizioneREA>
        <Ufficio>${xmlEscape(payload.company.reaOffice)}</Ufficio>
        <NumeroREA>${xmlEscape(payload.company.reaNumber)}</NumeroREA>
        ${payload.company.shareCapital != null ? `<CapitaleSociale>${formatDecimal(payload.company.shareCapital, 2)}</CapitaleSociale>` : ''}
        ${payload.company.soleShareholder ? `<SocioUnico>${xmlEscape(payload.company.soleShareholder)}</SocioUnico>` : ''}
        <StatoLiquidazione>${xmlEscape(payload.company.liquidationState || 'LN')}</StatoLiquidazione>
      </IscrizioneREA>` : ''}
      ${cedenteContatti}
      ${payload.company.referenceAdministration ? `<RiferimentoAmministrazione>${xmlEscape(payload.company.referenceAdministration)}</RiferimentoAmministrazione>` : ''}
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        ${customerHasVat ? `
        <IdFiscaleIVA>
          <IdPaese>${xmlEscape(payload.customer.vat.country || payload.customer.country || 'IT')}</IdPaese>
          <IdCodice>${xmlEscape(payload.customer.vat.code)}</IdCodice>
        </IdFiscaleIVA>` : ''}
        ${customerHasFiscalCode ? `<CodiceFiscale>${xmlEscape(payload.customer.fiscalCode)}</CodiceFiscale>` : ''}
        <Anagrafica>
          <Denominazione>${xmlEscape(payload.customer.denomination)}</Denominazione>
        </Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(payload.customer.address)}</Indirizzo>
        ${renderOptionalTag('NumeroCivico', payload.customer.streetNumber)}
        <CAP>${xmlEscape(payload.customer.cap)}</CAP>
        <Comune>${xmlEscape(payload.customer.city)}</Comune>
        ${payload.customer.province ? `<Provincia>${xmlEscape(payload.customer.province)}</Provincia>` : ''}
        <Nazione>${xmlEscape(payload.customer.country || 'IT')}</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${xmlEscape(payload.tipoDocumento)}</TipoDocumento>
        <Divisa>${xmlEscape(payload.divisa || 'EUR')}</Divisa>
        <Data>${payload.data}</Data>
        <Numero>${xmlEscape(payload.numero)}</Numero>
        ${payload.importoTotaleDocumento != null ? `<ImportoTotaleDocumento>${formatDecimal(payload.importoTotaleDocumento, 2)}</ImportoTotaleDocumento>` : ''}
        ${(payload.causali || []).map((causale) => `<Causale>${xmlEscape(causale)}</Causale>`).join('\n        ')}
      </DatiGeneraliDocumento>
      ${renderDatiOrdineAcquisto(payload.datiOrdineAcquisto)}
      ${renderDatiFattureCollegate(payload.datiFattureCollegate)}
    </DatiGenerali>
    <DatiBeniServizi>
${bodyLines}
${bodySummary}
    </DatiBeniServizi>
    ${pagamenti}
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`;
}

function buildSimplifiedInvoiceXml(payload) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronicaSemplificata versione="FSM10" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="${xmlEscape(payload.namespace)}">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
        <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${xmlEscape(payload.fileProgressivo)}</ProgressivoInvio>
      <FormatoTrasmissione>FSM10</FormatoTrasmissione>
      <CodiceDestinatario>${xmlEscape(payload.destinationCode || '0000000')}</CodiceDestinatario>
      ${shouldRenderPecDestinatario(payload) ? `<PECDestinatario>${xmlEscape(payload.pecDestinatario)}</PECDestinatario>` : ''}
    </DatiTrasmissione>
    <CedentePrestatore>
      <IdFiscaleIVA>
        <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
        <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
      </IdFiscaleIVA>
      <CodiceFiscale>${xmlEscape(payload.company.fiscalCode)}</CodiceFiscale>
      <Denominazione>${xmlEscape(payload.company.denomination)}</Denominazione>
      <Sede>
        <Indirizzo>${xmlEscape(payload.company.address)}</Indirizzo>
        ${renderOptionalTag('NumeroCivico', payload.company.streetNumber)}
        <CAP>${xmlEscape(payload.company.cap)}</CAP>
        <Comune>${xmlEscape(payload.company.city)}</Comune>
        ${payload.company.province ? `<Provincia>${xmlEscape(payload.company.province)}</Provincia>` : ''}
        <Nazione>${xmlEscape(payload.company.country)}</Nazione>
      </Sede>
      ${payload.company.reaOffice && payload.company.reaNumber ? `
      <IscrizioneREA>
        <Ufficio>${xmlEscape(payload.company.reaOffice)}</Ufficio>
        <NumeroREA>${xmlEscape(payload.company.reaNumber)}</NumeroREA>
        ${payload.company.shareCapital != null ? `<CapitaleSociale>${formatDecimal(payload.company.shareCapital, 2)}</CapitaleSociale>` : ''}
        <StatoLiquidazione>${xmlEscape(payload.company.liquidationState || 'LN')}</StatoLiquidazione>
      </IscrizioneREA>` : ''}
      <RegimeFiscale>${xmlEscape(payload.company.regimeFiscale)}</RegimeFiscale>
    </CedentePrestatore>
    <CessionarioCommittente>
      <IdentificativiFiscali>
        ${payload.customer.vat?.code ? `
        <IdFiscaleIVA>
          <IdPaese>${xmlEscape(payload.customer.vat.country || payload.customer.country || 'IT')}</IdPaese>
          <IdCodice>${xmlEscape(payload.customer.vat.code)}</IdCodice>
        </IdFiscaleIVA>` : ''}
        ${payload.customer.fiscalCode ? `<CodiceFiscale>${xmlEscape(payload.customer.fiscalCode)}</CodiceFiscale>` : ''}
      </IdentificativiFiscali>
      <AltriDatiIdentificativi>
        <Denominazione>${xmlEscape(payload.customer.denomination)}</Denominazione>
        <Sede>
          <Indirizzo>${xmlEscape(payload.customer.address)}</Indirizzo>
          ${renderOptionalTag('NumeroCivico', payload.customer.streetNumber)}
          <CAP>${xmlEscape(payload.customer.cap)}</CAP>
          <Comune>${xmlEscape(payload.customer.city)}</Comune>
          ${payload.customer.province ? `<Provincia>${xmlEscape(payload.customer.province)}</Provincia>` : ''}
          <Nazione>${xmlEscape(payload.customer.country || 'IT')}</Nazione>
        </Sede>
      </AltriDatiIdentificativi>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${xmlEscape(payload.tipoDocumento)}</TipoDocumento>
        <Divisa>${xmlEscape(payload.divisa || 'EUR')}</Divisa>
        <Data>${payload.data}</Data>
        <Numero>${xmlEscape(payload.numero)}</Numero>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    ${payload.lines.map((line) => `
    <DatiBeniServizi>
      <Descrizione>${xmlEscape(line.descrizione)}</Descrizione>
      <Importo>${formatDecimal(line.totaleRiga, 2)}</Importo>
      <DatiIVA>
        ${line.importoIva != null ? `<Imposta>${formatDecimal(line.importoIva, 2)}</Imposta>` : ''}
        ${line.aliquotaIva != null ? `<Aliquota>${formatDecimal(line.aliquotaIva, 2)}</Aliquota>` : ''}
      </DatiIVA>
      ${line.naturaIva ? `<Natura>${xmlEscape(line.naturaIva)}</Natura>` : ''}
      ${line.riferimentoNormativo ? `<RiferimentoNormativo>${xmlEscape(line.riferimentoNormativo)}</RiferimentoNormativo>` : ''}
    </DatiBeniServizi>`).join('\n')}
  </FatturaElettronicaBody>
</p:FatturaElettronicaSemplificata>
`;
}

// L'esigibilita' vale per l'intero documento: la si passa da fuori perche' con
// la scissione dei pagamenti verso la PA non e' piu' sempre "I".
function summarizeVat(lines, esigibilitaIva = 'I') {
  const grouped = new Map();
  lines.forEach((line) => {
    const key = `${Number(line.aliquotaIva || 0).toFixed(2)}|${line.naturaIva || ''}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        aliquotaIva: Number(line.aliquotaIva || 0),
        naturaIva: line.naturaIva || null,
        imponibile: 0,
        imposta: 0,
        esigibilitaIva: Number(line.aliquotaIva || 0) > 0 ? esigibilitaIva : undefined,
        riferimentoNormativo: line.riferimentoNormativo || null
      });
    }
    const row = grouped.get(key);
    row.imponibile = round2(row.imponibile + Number(line.totaleRiga || 0));
    row.imposta = round2(row.imposta + Number(line.importoIva != null ? line.importoIva : Number(line.totaleRiga || 0) * Number(line.aliquotaIva || 0) / 100));
  });
  return [...grouped.values()];
}

function buildProgressivoInvio(invoiceId) {
  const timePart = Date.now().toString(36).toUpperCase().slice(-7).padStart(7, '0');
  const invoicePart = Math.abs(Number(invoiceId) || 0).toString(36).toUpperCase().slice(-3).padStart(3, '0');
  return `${timePart}${invoicePart}`.slice(0, 10);
}

function mapDocumentType(value) {
  const normalized = String(value || 'fattura').trim().toLowerCase();
  if (normalized.startsWith('td')) return normalized.toUpperCase();
  if (normalized === 'nota_credito') return 'TD04';
  if (normalized === 'nota_debito') return 'TD05';
  if (normalized === 'autofattura') return 'TD16';
  if (normalized === 'integrazione_estero') return 'TD17';
  if (normalized === 'parcella') return 'TD06';
  return 'TD01';
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDecimal(value, scale = 2) {
  return Number(value || 0).toFixed(scale);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function renderOptionalTag(tag, value) {
  return value ? `<${tag}>${xmlEscape(value)}</${tag}>` : '';
}

// Specifiche formato FatturaPA 1.4 par. 1.1: PECDestinatario "viene valorizzato
// nei soli casi di destinatario diverso da Pubblica Amministrazione, qualora il
// destinatario utilizzi il canale PEC per ricevere le fatture. Puo' essere
// valorizzato solo se il valore di CodiceDestinatario e' uguale a 0000000".
function shouldRenderPecDestinatario(payload) {
  if (!payload.pecDestinatario) return false;
  if (payload.formatoTrasmissione === 'FPA12') return false;
  return String(payload.destinationCode || '0000000').trim() === '0000000';
}

function renderOptionalBlock(tag, children) {
  const content = (children || []).filter(Boolean).join('');
  return content ? `<${tag}>${content}</${tag}>` : '';
}

function renderPaymentBlocks(payment) {
  if (!payment?.details?.length) return '';
  // L'ordine degli elementi segue DettaglioPagamentoType: IstitutoFinanziario
  // precede IBAN, che precede BIC.
  return (payment.details || []).map((detail) => `
    <DatiPagamento>
      <CondizioniPagamento>${xmlEscape(payment.condizioniPagamento || 'TP02')}</CondizioniPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>${xmlEscape(detail.modalitaPagamento || 'MP05')}</ModalitaPagamento>
        ${detail.dataScadenzaPagamento ? `<DataScadenzaPagamento>${detail.dataScadenzaPagamento}</DataScadenzaPagamento>` : ''}
        <ImportoPagamento>${formatDecimal(detail.importoPagamento, 2)}</ImportoPagamento>
        ${detail.istitutoFinanziario ? `<IstitutoFinanziario>${xmlEscape(detail.istitutoFinanziario)}</IstitutoFinanziario>` : ''}
        ${detail.iban ? `<IBAN>${xmlEscape(detail.iban)}</IBAN>` : ''}
        ${detail.bic ? `<BIC>${xmlEscape(detail.bic)}</BIC>` : ''}
      </DettaglioPagamento>
    </DatiPagamento>`).join('\n');
}

// DatiOrdineAcquisto sta in DatiGeneraliType subito dopo DatiGeneraliDocumento,
// e i suoi figli seguono DatiDocumentiCorrelatiType: RiferimentoNumeroLinea,
// IdDocumento, Data, NumItem, CodiceCommessaConvenzione, CodiceCUP, CodiceCIG.
// L'ordine e' vincolante, il CUP precede il CIG, e IdDocumento e' l'unico
// obbligatorio.
function renderDatiOrdineAcquisto(order) {
  if (!order || !order.idDocumento) return '';
  return `<DatiOrdineAcquisto>
        <IdDocumento>${xmlEscape(order.idDocumento)}</IdDocumento>
        ${order.data ? `<Data>${order.data}</Data>` : ''}
        ${order.codiceCup ? `<CodiceCUP>${xmlEscape(order.codiceCup)}</CodiceCUP>` : ''}
        ${order.codiceCig ? `<CodiceCIG>${xmlEscape(order.codiceCig)}</CodiceCIG>` : ''}
      </DatiOrdineAcquisto>`;
}

// DatiFattureCollegate: la fattura che una nota di credito rettifica.
//
// Sta in DatiGeneraliType dopo DatiRicezione e prima di DatiSAL, quindi subito
// dopo DatiOrdineAcquisto fra quelli che questo builder emette. Stesso tipo dei
// documenti correlati, quindi stesso ordine di figli e stesso IdDocumento
// obbligatorio: senza numero e data della fattura di origine la nota non dice
// a cosa si riferisce, e chi la riceve non sa cosa storna.
function renderDatiFattureCollegate(riferimento) {
  if (!riferimento || !riferimento.idDocumento) return '';
  return `<DatiFattureCollegate>
        <IdDocumento>${xmlEscape(riferimento.idDocumento)}</IdDocumento>
        ${riferimento.data ? `<Data>${riferimento.data}</Data>` : ''}
      </DatiFattureCollegate>`;
}

// ScontoMaggiorazioneType: Tipo (SC/MG), Percentuale, Importo.
function renderScontoMaggiorazione(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return '';
  return list.map((entry) => {
    const tipo = String(entry.tipo || 'SC').trim().toUpperCase() === 'MG' ? 'MG' : 'SC';
    // Controllo SdI 00437: Percentuale e Importo non possono essere entrambi
    // assenti a fronte di Tipo valorizzato.
    const percentuale = entry.percentuale != null ? `<Percentuale>${formatDecimal(entry.percentuale, 2)}</Percentuale>` : '';
    const importo = entry.importo != null ? `<Importo>${formatDecimal(entry.importo, 8)}</Importo>` : '';
    if (!percentuale && !importo) return '';
    return `
          <ScontoMaggiorazione>
            <Tipo>${tipo}</Tipo>
            ${percentuale}
            ${importo}
          </ScontoMaggiorazione>`;
  }).filter(Boolean).join('');
}

module.exports = {
  buildOrdinaryInvoiceXml,
  buildProgressivoInvio,
  buildSimplifiedInvoiceXml,
  formatDecimal,
  mapDocumentType,
  shouldRenderPecDestinatario,
  summarizeVat,
  xmlEscape
};
