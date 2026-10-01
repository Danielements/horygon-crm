// Modulo MUSA: logica gestionale sopra il client Stripe. Separato da Horygon.
// Importi verso l'UI in EURO (decimali); Stripe lavora in centesimi interi, la
// conversione avviene qui. Nessun dato fiscale: Stripe e' incassi + documenti
// commerciali, non la fattura elettronica italiana (vedi avviso).

const stripe = require('./stripe-client');

function toCents(euro) { return Math.round((Number(euro) || 0) * 100); }
function toEuro(cents) { return Math.round((Number(cents) || 0)) / 100; }

// --- mapper (Stripe -> UI) -------------------------------------------------
function mapPayment(pi) {
  return {
    id: pi.id,
    importo: toEuro(pi.amount_received != null ? pi.amount_received : pi.amount),
    valuta: (pi.currency || 'eur').toUpperCase(),
    stato: pi.status,
    descrizione: pi.description || null,
    cliente: pi.customer || null,
    data: pi.created ? new Date(pi.created * 1000).toISOString().slice(0, 10) : null,
    rimborsato: !!pi.charges && pi.charges.data && pi.charges.data.some((c) => c.refunded)
  };
}

const INVOICE_STATO = { draft: 'Bozza', open: 'Da pagare', paid: 'Pagata', uncollectible: 'Inesigibile', void: 'Annullata' };
function mapInvoice(inv) {
  return {
    id: inv.id,
    numero: inv.number || null,
    stato: inv.status,
    stato_label: INVOICE_STATO[inv.status] || inv.status,
    totale: toEuro(inv.total),
    dovuto: toEuro(inv.amount_due),
    pagato: toEuro(inv.amount_paid),
    valuta: (inv.currency || 'eur').toUpperCase(),
    cliente_nome: (inv.customer_name || (inv.customer && inv.customer.name)) || null,
    cliente_email: inv.customer_email || null,
    data: inv.created ? new Date(inv.created * 1000).toISOString().slice(0, 10) : null,
    scadenza: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : null,
    hosted_url: inv.hosted_invoice_url || null,
    pdf_url: inv.invoice_pdf || null
  };
}

function mapCustomer(c) {
  return { id: c.id, nome: c.name || null, email: c.email || null, piva: (c.metadata && c.metadata.piva) || null, creato: c.created ? new Date(c.created * 1000).toISOString().slice(0, 10) : null };
}

// --- dashboard -------------------------------------------------------------
async function dashboard() {
  const [bal, invoices, payments, customers] = await Promise.all([
    stripe.getBalance().catch(() => null),
    stripe.listInvoices(100).catch(() => ({ data: [] })),
    stripe.listPaymentIntents(10).catch(() => ({ data: [] })),
    stripe.listCustomers(100).catch(() => ({ data: [] }))
  ]);
  const sum = (arr) => (arr || []).reduce((s, b) => s + (b.amount || 0), 0);
  const perStato = {};
  (invoices.data || []).forEach((i) => { perStato[i.status] = (perStato[i.status] || 0) + 1; });
  const daIncassare = toEuro((invoices.data || []).filter((i) => i.status === 'open').reduce((s, i) => s + (i.amount_due || 0), 0));
  return {
    mode: stripe.mode(),
    saldo: {
      disponibile: bal ? toEuro(sum(bal.available)) : null,
      in_arrivo: bal ? toEuro(sum(bal.pending)) : null,
      valuta: bal && bal.available && bal.available[0] ? bal.available[0].currency.toUpperCase() : 'EUR'
    },
    fatture: { per_stato: perStato, da_incassare: daIncassare, totali: (invoices.data || []).length },
    clienti: (customers.data || []).length,
    ultimi_pagamenti: (payments.data || []).map(mapPayment)
  };
}

async function listInvoices() { return (await stripe.listInvoices(100)).data.map(mapInvoice); }
async function listPayments() { return (await stripe.listPaymentIntents(50)).data.map(mapPayment); }
async function listCustomers() { return (await stripe.listCustomers(100)).data.map(mapCustomer); }

// --- creazione cliente -----------------------------------------------------
async function createCustomer({ nome, email, piva, note }) {
  if (!nome && !email) throw new Error('Nome o email obbligatori');
  const data = { name: nome || undefined, email: email || undefined };
  if (piva) data.metadata = { piva };
  if (note) data.description = note;
  return mapCustomer(await stripe.createCustomer(data));
}

// --- creazione fattura multi-riga -----------------------------------------
// input: { customer_id? | cliente:{nome,email,piva}, righe:[{descrizione,importo,quantita}],
//          valuta='eur', giorni_scadenza=30, invia=false }
async function createInvoice(input) {
  const valuta = (input.valuta || 'eur').toLowerCase();
  const righe = (input.righe || []).filter((r) => Number(r.importo) > 0);
  if (!righe.length) throw new Error('Serve almeno una riga con importo > 0');

  let customerId = input.customer_id;
  if (!customerId) {
    if (!input.cliente || (!input.cliente.nome && !input.cliente.email)) throw new Error('Indica un cliente');
    const c = await stripe.createCustomer({
      name: input.cliente.nome || undefined,
      email: input.cliente.email || undefined,
      metadata: input.cliente.piva ? { piva: input.cliente.piva } : undefined
    });
    customerId = c.id;
  }

  // Voci pendenti sul cliente, poi raccolte nella fattura.
  for (const r of righe) {
    await stripe.createInvoiceItem({
      customer: customerId,
      currency: valuta,
      unit_amount: toCents(r.importo),
      quantity: Number(r.quantita) > 0 ? Number(r.quantita) : 1,
      description: r.descrizione || 'Voce'
    });
  }
  const inv = await stripe.createInvoice({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: Number(input.giorni_scadenza) > 0 ? Number(input.giorni_scadenza) : 30,
    pending_invoice_items_behavior: 'include',
    auto_advance: false
  });

  let finale = inv;
  if (input.invia) {
    await stripe.finalizeInvoice(inv.id);
    finale = await stripe.sendInvoice(inv.id);
  }
  return mapInvoice(finale);
}

async function finalizeAndSend(id) { await stripe.finalizeInvoice(id); return mapInvoice(await stripe.sendInvoice(id)); }
async function payInvoice(id) { return mapInvoice(await stripe.payInvoice(id, { paid_out_of_band: true })); }
async function voidInvoice(id) { return mapInvoice(await stripe.voidInvoice(id)); }

// --- payment link rapido (crea prezzo al volo) -----------------------------
async function createPaymentLink({ descrizione, importo, valuta = 'eur', quantita = 1 }) {
  if (!(Number(importo) > 0)) throw new Error('Importo non valido');
  const price = await stripe.request('POST', '/prices', {
    unit_amount: toCents(importo),
    currency: String(valuta).toLowerCase(),
    product_data: { name: descrizione || 'Pagamento MUSA' }
  });
  const link = await stripe.createPaymentLink({ line_items: [{ price: price.id, quantity: Number(quantita) > 0 ? Number(quantita) : 1 }] });
  return { id: link.id, url: link.url, importo: toEuro(price.unit_amount), valuta: price.currency.toUpperCase() };
}

// --- rimborso --------------------------------------------------------------
async function refund({ payment_intent, charge, importo }) {
  if (!payment_intent && !charge) throw new Error('Indica il pagamento da rimborsare');
  const data = {};
  if (payment_intent) data.payment_intent = payment_intent;
  if (charge) data.charge = charge;
  if (importo != null && importo !== '') data.amount = toCents(importo); // parziale
  const idem = `refund_${payment_intent || charge}_${data.amount || 'full'}`;
  const r = await stripe.createRefund(data, idem);
  return { id: r.id, stato: r.status, importo: toEuro(r.amount), valuta: (r.currency || 'eur').toUpperCase() };
}

module.exports = {
  toCents, toEuro, mapPayment, mapInvoice, mapCustomer,
  dashboard, listInvoices, listPayments, listCustomers,
  createCustomer, createInvoice, finalizeAndSend, payInvoice, voidInvoice, createPaymentLink, refund
};
