import { ERP } from './erp.js';
import { calculate, validateInvoice, makePayload, pieceQuantity, itemPacking } from './core.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const config = await fetch(new URL('../config.json', import.meta.url)).then(r => { if (!r.ok) throw new Error('Cannot load widget configuration'); return r.json(); });
if (window.RAJADHANI_PREVIEW_CONFIG) Object.assign(config, window.RAJADHANI_PREVIEW_CONFIG);
const api = new ERP(config, window.ZFAPPS);
const state = { customer: null, lines: [], taxes: [], currency: 'INR', busy: false, saved: false, allowClose: false, uncertain: false, customerVersion: 0, pendingOperations: 0, pendingSO: { item: null, rows: [], loading: false, error: '' } };
let approvedPayload = null;
function pending(delta) { state.pendingOperations += delta; $('saveButton').disabled = state.pendingOperations > 0 || state.saved || state.uncertain; }
const money = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: state.currency }).format(Number.isFinite(n) ? n : 0);
function notice(message, kind = '') { $('noticeText').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
function error(err) { notice(err.message || String(err), 'error'); }
$('noticeClose').addEventListener('click', () => notice(''));
function hasUnsavedWork() {
  if (state.saved || state.allowClose) return false;
  if (state.customer || state.lines.length) return true;
  const ids = ['customerSearch','itemSearch','placeOfSupply','shippingGst','shippingAddress','notes','discount'];
  if (ids.some(id => String($(id)?.value || '').trim() && String($(id)?.value || '').trim() !== '0')) return true;
  return Object.keys(config.customFields).some(k => String($(`cf_${k}`)?.value || '').trim());
}
function invoiceListUrl() {
  const orgId = encodeURIComponent(config.organizationId || api.organization?.organization_id || '');
  return orgId ? `https://erp.zoho.in/app/${orgId}#/invoices?filter_by=Status.All&per_page=25&sort_column=created_time&sort_order=D` : 'https://erp.zoho.in/app';
}
async function exitAfterSave() {
  await new Promise(resolve => setTimeout(resolve, 900));
  try {
    if (window.ZFAPPS?.closeModal) {
      await window.ZFAPPS.closeModal();
      return;
    }
  } catch { /* Continue with browser/webtab fallbacks. */ }
  try {
    window.open('', '_self');
    window.close();
  } catch { /* Some browsers block closing tabs not opened by script. */ }
  setTimeout(() => {
    if (document.visibilityState === 'hidden') return;
    const url = invoiceListUrl();
    try { window.top.location.href = url; return; } catch { /* Cross-origin webtabs can block top navigation. */ }
    try { window.parent.location.href = url; return; } catch { /* Fall through to iframe/current-page navigation. */ }
    window.location.href = url;
  }, 700);
}
function fieldMarkup(key) {
  const f = config.customFields[key];
  const type = /phone|mobile|whatsapp/i.test(key) ? 'tel' : 'text';
  const fixedOptions = key === 'billType' ? ['Cash','Credit','Credit-Account'] : null;
  const input = fixedOptions ? `<select id="cf_${key}" ${f.required ? 'required' : ''}><option value="">Select ${esc(f.label.toLowerCase())}</option>${fixedOptions.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>` : config.lookupSources[key] ? `<select id="cf_${key}" ${f.required ? 'required' : ''}><option value="">Select ${esc(f.label.toLowerCase())}</option></select>` : `<input id="cf_${key}" type="${type}" ${f.required ? 'required' : ''} placeholder="${key === 'billCreatedBy' ? 'Current ERP user' : esc(f.label)}">`;
  return `<div class="field"><label for="cf_${key}">${esc(f.label)} ${f.required && f.id ? '<em>*</em>' : ''}</label>${input}${!f.id ? '<small class="mappinghint">Not sent to ERP yet</small>' : ''}</div>`;
}
$('billingFields').innerHTML = ['billType','billCreatedBy','mobile','whatsapp','shippingPhone'].map(fieldMarkup).join('');
$('dispatchFields').innerHTML = ['transport','agent','vehicle'].map(fieldMarkup).join('');
$('invoiceDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,10);
function getValues() {
  return { date: $('invoiceDate').value, place_of_supply: $('placeOfSupply').value.trim().toUpperCase(), salesperson_id: $('salesperson').value, location_id: $('location').value,
    shipping_gst_no: $('shippingGst').value.trim(), shipping_address: $('shippingAddress').value.trim(), notes: $('notes').value.trim(), sameAsBilling: $('sameAsBilling').checked,
    discount: Number($('discount').value), discountType: $('discountType').value, rounded: true,
    custom: Object.fromEntries(Object.keys(config.customFields).map(k => [k, $(`cf_${k}`)?.value?.trim?.() ?? ''])) };
}
function totals() {
  const v = getValues(); const t = calculate(state.lines, v.discount, v.discountType, v.rounded);
  for (const [id, key] of Object.entries({subtotal:'subtotal',discountAmount:'discount',taxTotal:'tax',roundValue:'adjustment',grandTotal:'total'})) $(id).textContent = `${id === 'discountAmount' ? '− ' : ''}${money(t[key])}`;
  const intraState = v.place_of_supply === 'KL';
  const halfTax = Math.round((t.tax / 2 + Number.EPSILON) * 100) / 100;
  $('taxBreakdown').innerHTML = intraState
    ? `<div class="summaryrow"><span>CGST</span><span>${esc(money(halfTax))}</span></div><div class="summaryrow"><span>SGST</span><span>${esc(money(t.tax - halfTax))}</span></div>`
    : `<div class="summaryrow"><span>IGST</span><span>${esc(money(t.tax))}</span></div>`;
  $('totalDetail').textContent = `${state.lines.length} item${state.lines.length === 1 ? '' : 's'} in this invoice`;
  $('lineCount').textContent = state.lines.length;
  $('qtySummary').textContent = `${state.lines.length} items · ${Math.round(state.lines.reduce((s,l)=>s+l.quantity,0)*1000)/1000} order qty · ${Math.round(state.lines.reduce((s,l)=>s+(l.pieces ? pieceQuantity(l) : 0),0)*1000)/1000} pieces`;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notice('Item ERP response copied. Paste it here and I will map M Unit and Ratio exactly.', 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    notice(copied ? 'Item ERP response copied. Paste it here and I will map M Unit and Ratio exactly.' : 'Could not copy automatically. Open the browser console and copy the Rajadhani item debug output.', copied ? 'success' : 'error');
  }
}
const qty = n => Math.round(Number(n || 0) * 1000) / 1000;
function renderPendingSO() {
  if (!$('pendingSoItem')) return;
  const panel = state.pendingSO;
  $('pendingSoItem').textContent = panel.item?.name ? panel.item.name : 'Select or scan an item';
  $('pendingSoTotal').textContent = `Total pending: ${qty(panel.rows.reduce((s,r)=>s+r.pendingNos,0))} Nos`;
  if (panel.loading) {
    $('pendingSoHelp').textContent = 'Loading pending SO quantities for this item…';
    $('pendingSoRows').innerHTML = '<tr class="mutedrow"><td colspan="5">Checking ERP sales orders…</td></tr>';
    return;
  }
  if (panel.error) {
    $('pendingSoHelp').textContent = 'Sales-order lookup did not complete. You can still continue the invoice.';
    $('pendingSoRows').innerHTML = `<tr class="mutedrow"><td colspan="5">${esc(panel.error)}</td></tr>`;
    return;
  }
  $('pendingSoHelp').textContent = panel.item ? 'These pending SO quantities are reserved against stock for the selected item.' : 'Pending SO quantities are shown for the current item.';
  if (!panel.item) {
    $('pendingSoRows').innerHTML = '<tr class="mutedrow"><td colspan="5">No item selected.</td></tr>';
    return;
  }
  if (!panel.rows.length) {
    $('pendingSoRows').innerHTML = '<tr class="mutedrow"><td colspan="5">No pending sales orders for this item.</td></tr>';
    return;
  }
  $('pendingSoRows').innerHTML = panel.rows.map(r => `<tr><td>${esc(r.number)}</td><td>${esc(r.customer)}</td><td>${esc(r.date || '—')}</td><td>${esc(qty(r.pendingNos))}</td><td>${esc(qty(r.pendingBoxes))}</td></tr>`).join('');
}
function pendingSalesOrderLine(order, invoiceLine) {
  const match = (order.line_items || []).find(l => String(l.item_id) === String(invoiceLine.item_id));
  if (!match) return null;
  const ordered = Number(match.quantity || 0);
  const invoiced = Number(match.quantity_invoiced || match.quantity_invoiced_cancelled || 0);
  const cancelled = Number(match.quantity_cancelled || match.cancelled_quantity || 0);
  const pendingBoxes = Math.max(0, ordered - invoiced - cancelled);
  if (!pendingBoxes) return null;
  return {
    number: order.salesorder_number || order.reference_number || order.salesorder_id || 'Sales order',
    customer: order.customer_name || order.customer?.contact_name || order.customer_id || 'Customer',
    date: order.date || order.order_date || order.created_time?.slice?.(0,10) || '',
    pendingBoxes,
    pendingNos: pendingBoxes * Number(invoiceLine.pieces || 1)
  };
}
async function loadPendingSO(line) {
  state.pendingSO = { item: null, rows: [], loading: false, error: '' };
}

function focusInvoiceItems(focusIndex = null) {
  requestAnimationFrame(() => {
    $('invoiceItemsCard')?.scrollIntoView({block:'start', behavior:'smooth'});
    if (focusIndex != null) $('lineItems').children[focusIndex]?.scrollIntoView({block:'nearest'});
  });
}
function renderLines(focusIndex = null, focusItems = false) {
  $('emptyItems').hidden = !!state.lines.length;
  $('lineItems').innerHTML = state.lines.map((l,i) => {
    const taxLabel = l.loading ? 'Loading…' : l.tax ? `${l.tax.name} (${l.tax.percentage}%)` : l.tax_exemption_id ? 'ERP exempt' : (taxMode() === 'inter' ? 'IGST not configured' : 'GST not configured');
    return l.notFound ? `<tr data-line="${i}" class="notfoundline"><td>${i+1}</td><td colspan="8"><strong>Item not found</strong><small>Scanned value: ${esc(l.scanText || l.sku || '')}. Check the barcode/item code in ERP.</small></td><td><button class="remove" type="button" data-remove="${i}" aria-label="Remove item not found warning">×</button></td></tr>` : `<tr data-line="${i}" class="${l.loading ? 'loadingline' : ''}"><td>${i+1}</td><td class="itemname"><strong>${esc(l.name)}</strong><small>${esc(l.sku || 'No SKU')} · HSN ${esc(l.hsn_or_sac || '—')}</small>${l.loading ? '<small class="loadingnote">Loading ERP item details…</small>' : ''}${l.packingError ? `<small class="packingerror">${esc(l.packingError)}</small>${l.itemDebug ? `<button class="debugcopy" type="button" data-debug="${i}">Copy item response</button>` : ''}` : ''}</td><td>${esc(l.stock ?? '—')}<small>${esc(l.mu || l.unit || 'units')}</small></td><td>${l.loading ? '…' : esc(l.pieces || '—')}</td><td><input type="number" min="0.001" step="any" value="${l.quantity}" data-row="${i}" data-field="quantity" aria-label="Quantity for ${esc(l.name)}" required></td><td data-piece="${i}">${l.loading ? '…' : l.pieces ? l.pieces*l.quantity : '—'}</td><td><input type="number" min="0" step="0.01" value="${l.rate}" data-row="${i}" data-field="rate" aria-label="Rate for ${esc(l.name)}" required></td><td><select class="taxreadonly" data-row="${i}" data-field="tax" aria-label="Tax for ${esc(l.name)}" disabled><option value="${esc(l.tax?.id || '')}">${esc(taxLabel)}</option></select></td><td class="right" data-amount="${i}">${l.loading ? '…' : esc(money(pieceQuantity(l)*l.rate))}</td><td><button class="remove" type="button" data-remove="${i}" aria-label="Remove ${esc(l.name)}">×</button></td></tr>`;
  }).join('');
  totals();
  if (!state.lines.length) loadPendingSO(null);
  if (focusIndex != null || focusItems) focusInvoiceItems(focusIndex);
}
$('lineItems').addEventListener('input', e => {
  const {row,field} = e.target.dataset; if (row == null || !field) return;
  const l=state.lines[Number(row)]; if (!l || l.notFound || field === 'tax') return; l[field] = Number(e.target.value);
  document.querySelector(`[data-amount="${row}"]`).textContent = money(pieceQuantity(l)*l.rate);
  document.querySelector(`[data-piece="${row}"]`).textContent = l.pieces ? Math.round(l.pieces*l.quantity*1000)/1000 : '—'; totals();
});
$('lineItems').addEventListener('click', e => {
  const debug=e.target.closest('[data-debug]');
  if (debug) {
    const line=state.lines[Number(debug.dataset.debug)];
    if (line?.itemDebug) copyText(JSON.stringify(line.itemDebug, null, 2));
    return;
  }
  const b=e.target.closest('[data-remove]'); if (b) { state.lines.splice(Number(b.dataset.remove),1);renderLines(); return; }
  const row=e.target.closest('tr[data-line]');
  if (row && !e.target.closest('input,select,button')) { const line=state.lines[Number(row.dataset.line)]; if(!line?.notFound) loadPendingSO(line); }
});
['discount','discountType'].forEach(id=>$(id).addEventListener('input',totals));
function address(a) { return a ? [a.attention,a.address,a.street2,[a.city,a.state,a.zip].filter(Boolean).join(', '),a.country].filter(Boolean).join('\n') || 'No address recorded in ERP.' : 'No address recorded in ERP.'; }
function addresses() {
  $('billingAddress').textContent=address(state.customer?.billing_address);
  $('shippingAddress').value=$('sameAsBilling').checked && state.customer ? address(state.customer.billing_address) : '';
}
$('sameAsBilling').addEventListener('change', addresses);
function selectOptions(id, records, idKey, nameKey, placeholder) { const current=$(id).value;$(id).replaceChildren(new Option(placeholder,''),...records.filter(r=>r.status!=='inactive'&&r.is_active!==false).map(r=>new Option(r[nameKey] || r.name || String(r[idKey]),String(r[idKey]))));if(records.some(r=>String(r[idKey])===current))$(id).value=current; }
async function chooseCustomer(record) {
  const version=++state.customerVersion;
  state.customer=null; $('salesOrder').disabled=true;$('salesOrder').replaceChildren(new Option('Loading sales orders…',''));
  $('customerSearch').value=record.contact_name; $('customerHint').textContent='Loading customer details…';
  pending(1);
  try {
    const c=await api.customer(record.contact_id); if(version!==state.customerVersion)return;
    if(!c)throw new Error('ERP did not return the selected customer.');
    if(c.status==='inactive')throw new Error('This customer is inactive. Choose an active customer.');
    if(c.currency_code && api.organization?.currency_code && c.currency_code!==api.organization.currency_code)throw new Error('This customer uses another currency. Use the native ERP editor to apply exchange rates and price lists.');
    state.customer=c;state.currency=c.currency_code || api.organization?.currency_code || 'INR';$('currencyLabel').textContent=state.currency;
    $('customerSearch').value=c.contact_name; $('customerHint').textContent=[c.company_name,c.email].filter(Boolean).join(' · ') || 'Customer loaded from ERP';
    $('gstNumber').value=c.gst_no || ''; $('shippingGst').value=c.shipping_gst_no || '';
    $('placeOfSupply').value=c.place_of_contact || c.place_of_supply || '';
    $('cf_mobile').value=c.mobile || c.contact_persons?.find(p=>p.is_primary_contact)?.mobile || c.phone || '';
    $('cf_shippingPhone').value=c.shipping_address?.phone || '';
    for(const [k,m] of Object.entries(config.customFields)) { const source=(c.custom_fields||[]).find(f=>m.customerApiName && f.api_name===m.customerApiName); if(source && $(`cf_${k}`))$(`cf_${k}`).value=source.value ?? ''; }
    addresses();applyPlaceOfSupplyTaxes();renderLines();
    const orders=await api.all('/salesorders','salesorders',{customer_id:c.contact_id}); if(version!==state.customerVersion)return;
    selectOptions('salesOrder',orders.filter(o=>['open','confirmed','partially_invoiced'].includes(o.status)),'salesorder_id','salesorder_number','No sales order');$('salesOrder').disabled=false;
    requestAnimationFrame(() => $('itemSearch').focus());
  }catch(e){if(version===state.customerVersion){error(e);$('customerHint').textContent=state.customer?'Customer loaded; sales order lookup failed.':'Could not load customer. Search again.';$('salesOrder').replaceChildren(new Option('Sales orders unavailable',''));}}finally{pending(-1);}
}
const normalized = value => String(value || '').trim().toLocaleLowerCase();
const scannerMatch = (records, text) => {
  const needle = normalized(text);
  const exact = records.find(r => [r.sku, r.item_code, r.item_code_formatted, r.barcode, r.ean, r.upc, r.name].some(v => normalized(v) === needle));
  return exact || records[0] || null;
};
function searchable(inputId, resultsId, search, key, describe, choose, options = {}) {
  const input=$(inputId), box=$(resultsId); let timer, sequence=0, page=1, query='';
  const close=()=>{box.hidden=true;input.setAttribute('aria-expanded','false');};
  async function run(append=false, autoChoose=false) {
    clearTimeout(timer);
    const token=++sequence; if(!append){page=1;query=input.value.trim();if(!query){box.replaceChildren();close();return;}box.innerHTML='<p>Searching ERP…</p>';}
    box.hidden=false;input.setAttribute('aria-expanded','true');
    try { const r=await search(query,page);if(token!==sequence)return;const records=(r[key]||[]).filter(x=>x.status!=='inactive' && x.is_active!==false);
      if (autoChoose) {
        const record = scannerMatch(records, query);
        if (record) { box.replaceChildren(); close(); await choose(record, {fast:true}); return; }
      }
      if(!append)box.replaceChildren();else box.querySelector('[data-more]')?.remove();
      if(!records.length&&!append)box.innerHTML='<p>No matching records. Try a different search.</p>';
      records.forEach(record=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','option');const [name,detail]=describe(record);b.innerHTML=`${esc(name)}<span>${esc(detail)}</span>`;b.onclick=async()=>{close();try{await choose(record);}catch(e){error(e);}};box.append(b);});
      const ctx=Array.isArray(r.page_context)?r.page_context[0]:r.page_context;if(ctx?.has_more_page){const b=document.createElement('button');b.type='button';b.dataset.more='true';b.textContent='Load more results →';b.onclick=()=>{page++;run(true);};box.append(b);}
    }catch(e){if(token===sequence)box.innerHTML=`<p>${esc(e.message)}</p>`;}
  }
  input.addEventListener('input',()=>{sequence++;clearTimeout(timer);box.replaceChildren();close();if(!input.value.trim())return;timer=setTimeout(()=>run(),280);});
  input.addEventListener('keydown',async e=>{if(e.key==='Escape')close();if(e.key==='ArrowDown'){e.preventDefault();if(input.value.trim()){if(box.hidden)run();else box.querySelector('button')?.focus();}}if(e.key==='Enter'||(e.key==='Tab'&&options.scanOnEnter&&input.value.trim())){e.preventDefault();const text=input.value.trim();if(options.scanImmediate){sequence++;clearTimeout(timer);box.replaceChildren();close();await options.scanImmediate(text);return;}const choices=box.querySelectorAll('button[role=option]');if(choices.length===1&&!box.hidden)choices[0].click();else await run(false, !!options.scanOnEnter);}});
  box.addEventListener('keydown',e=>{const buttons=[...box.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){close();input.focus();}});
  document.addEventListener('click',e=>{if(!box.contains(e.target)&&e.target!==input)close();});
  return run;
}
searchable('customerSearch','customerResults',(q,p)=>api.searchCustomers(q,p),'contacts',c=>[c.contact_name,[c.company_name,c.mobile || c.email].filter(Boolean).join(' · ')],chooseCustomer);
$('customerSearch').addEventListener('input',()=>{state.customerVersion++;state.customer=null;$('salesOrder').disabled=true;$('salesOrder').replaceChildren(new Option('Select a customer first',''));$('gstNumber').value='';$('shippingGst').value='';$('placeOfSupply').value='';['mobile','whatsapp','shippingPhone'].forEach(k=>$(`cf_${k}`).value='');$('customerHint').textContent='Choose a matching ERP customer';addresses();applyPlaceOfSupplyTaxes();renderLines();});
$('placeOfSupply').addEventListener('input',()=>{applyPlaceOfSupplyTaxes();renderLines();});
function normalizeTax(t){return {id:String(t.tax_id || t.tax_group_id || t.id || ''),name:t.tax_name || t.tax_group_name || t.name || t.tax_name_formatted || t.text,percentage:Number(t.tax_percentage ?? t.tax_group_percentage ?? t.percentage ?? 0),specification:String(t.tax_specification || t.tax_specific_type || t.tax_type || '').toLowerCase()};}
function taxMode() { return $('placeOfSupply').value.trim().toUpperCase() === 'KL' ? 'intra' : 'inter'; }
function taxLooksInter(t) { return /inter|igst/i.test(`${t.specification || ''} ${t.name || ''}`); }
function taxLooksIntra(t) { return /intra/i.test(`${t.specification || ''} ${t.name || ''}`) || (/gst/i.test(t.name || '') && !taxLooksInter(t)); }
function preferenceForMode(source, mode) {
  const preferences = source.item_tax_preferences || source.taxPreferences || [];
  return preferences.find(t => mode === 'inter' ? taxLooksInter(normalizeTax(t)) : taxLooksIntra(normalizeTax(t))) || null;
}
function matchingConfiguredTax(candidate, mode) {
  const id = candidate.tax_id || candidate.tax_group_id || candidate.id;
  const exact = id ? state.taxes.find(t => String(t.id) === String(id)) : null;
  if (exact && (mode === 'inter' ? taxLooksInter(exact) : taxLooksIntra(exact))) return exact;
  const percentage = Number(candidate.tax_percentage ?? candidate.tax_group_percentage ?? candidate.percentage ?? 0);
  return state.taxes.find(t => Number(t.percentage) === percentage && (mode === 'inter' ? taxLooksInter(t) : taxLooksIntra(t))) || null;
}
function itemTax(source, mode = taxMode()) {
  const preferences = source.item_tax_preferences || source.taxPreferences || [];
  const preferred = preferenceForMode(source, mode);
  const fallback = preferred || preferences[0] || source;
  const configured = matchingConfiguredTax(fallback, mode);
  if (configured) return configured;
  if (!preferred && mode === 'inter') return null;
  const id = fallback.tax_id || fallback.tax_group_id || source.tax_id;
  if (!id) return null;
  const tax = normalizeTax({...fallback, tax_id: id});
  if (tax.id && tax.name && Number.isFinite(tax.percentage)) {
    const existing = state.taxes.find(t => String(t.id) === String(tax.id));
    if (existing) return existing;
    state.taxes.push(tax);
    return tax;
  }
  return null;
}
function applyPlaceOfSupplyTaxes() {
  const mode = taxMode();
  for (const line of state.lines) {
    if (line.notFound || line.loading || line.tax_exemption_id) continue;
    line.tax = itemTax(line, mode);
  }
}
function debugSnapshot(selectedRecord, itemResponse, masterId, masterResponse, mergedItem, masterError) {
  const clean = value => JSON.parse(JSON.stringify(value, (key, data) => key === '__rajadhaniDebug' ? undefined : data));
  return {
    selectedRecord: clean(selectedRecord),
    itemResponse: clean(itemResponse),
    masterId: masterId ?? null,
    masterResponse: masterResponse ? clean(masterResponse) : null,
    mergedItem: clean(mergedItem),
    ...(masterError ? {masterError} : {})
  };
}
async function fullItem(record) {
  const item = await api.item(record.item_id);
  if (!item) throw new Error('ERP did not return item details.');
  const masterId = item.item_master_id || record.item_master_id || item.group_id || record.group_id;
  if (!masterId) {
    item.__rajadhaniDebug = debugSnapshot(record, item, null, null, item);
    console.info('Rajadhani item debug', item.__rajadhaniDebug);
    return item;
  }
  try {
    const master = await api.itemMaster(masterId);
    if (!master) {
      item.__rajadhaniDebug = debugSnapshot(record, item, masterId, null, item);
      console.info('Rajadhani item debug', item.__rajadhaniDebug);
      return item;
    }
    const merged = {
      ...master,
      ...item,
      custom_fields: [...(master.custom_fields || []), ...(item.custom_fields || [])],
      custom_field_hash: {...(master.custom_field_hash || master.customfield_hash || {}), ...(item.custom_field_hash || item.customfield_hash || {})}
    };
    merged.__rajadhaniDebug = debugSnapshot(record, item, masterId, master, merged);
    console.info('Rajadhani item debug', merged.__rajadhaniDebug);
    return merged;
  } catch (err) {
    notice(`Item master custom fields could not be loaded for ${item.name || record.name}. Check ERP.items.READ/settings access or map the item custom-field IDs in app/config.json. ${err.message}`, 'error');
    item.__rajadhaniDebug = debugSnapshot(record, item, masterId, null, item, err.message);
    console.info('Rajadhani item debug', item.__rajadhaniDebug);
    return item;
  }
}
async function lineFromItem(item, extra={}) {
  const tax = itemTax(item);
  const packing = itemPacking(item, config.itemFields);
  return {item_id:String(item.item_id),name:item.name,sku:item.sku,hsn_or_sac:item.hsn_or_sac,stock:item.available_stock ?? item.stock_on_hand,unit:item.unit,rate:Number(item.rate||0),quantity:1,tax,taxPreferences:item.item_tax_preferences || [],tax_exemption_id:item.tax_exemption_id,...packing,itemDebug:item.__rajadhaniDebug,tracked:!!(item.is_serial_number_tracking_enabled||item.is_batch_tracking_enabled||item.is_storage_location_enabled),...extra};
}
function quickLineFromRecord(record) {
  return {item_id:String(record.item_id),name:record.name || record.item_name || record.sku || 'Scanned item',sku:record.sku || record.item_code,hsn_or_sac:record.hsn_or_sac,stock:record.available_stock ?? record.stock_on_hand,unit:record.unit,rate:Number(record.rate||0),quantity:1,tax:null,tax_exemption_id:record.tax_exemption_id,mu:record.unit || '',pieces:null,loading:true};
}
function quickLineFromScan(text) {
  return {item_id:`scan:${Date.now()}:${text}`,name:`Scanning ${text}`,sku:text,scanText:text,hsn_or_sac:'',stock:'—',unit:'',rate:0,quantity:1,tax:null,tax_exemption_id:null,mu:'',pieces:null,loading:true,scanPlaceholder:true};
}
async function addItem(record, options={}) {
  if(!state.customer)throw new Error('Select a customer before adding items.');
  let placeholder=options.placeholder || null;
  const existingIndex=state.lines.findIndex(l=>String(l.item_id)===String(record.item_id)&&!l.salesorder_item_id&&!l.loading);
  if(existingIndex>=0){if(placeholder){const index=state.lines.indexOf(placeholder);if(index>=0)state.lines.splice(index,1);}state.lines[existingIndex].quantity++;$('itemSearch').value='';renderLines(existingIndex,true);loadPendingSO(state.lines[existingIndex]);$('itemSearch').focus();return;}
  const version=state.customerVersion;
  if(placeholder){const index=state.lines.indexOf(placeholder);if(index>=0){state.lines[index]={...quickLineFromRecord(record),quantity:placeholder.quantity || 1};placeholder=state.lines[index];renderLines(index,true);$('itemSearch').focus();}}
  else if(options.fast){placeholder=quickLineFromRecord(record);state.lines.push(placeholder);$('itemSearch').value='';renderLines(state.lines.length-1,true);$('itemSearch').focus();}
  pending(1);
  try{const item=await fullItem(record);if(version!==state.customerVersion)return;
    const line=await lineFromItem(item);if(line.tracked)throw new Error('This item requires batch, serial or storage allocation. Please use the native ERP invoice editor.');
    const loadingIndex=placeholder ? state.lines.indexOf(placeholder) : -1;
    const duplicateIndex=state.lines.findIndex((l,i)=>i!==loadingIndex&&String(l.item_id)===line.item_id&&!l.salesorder_item_id&&!l.loading);
    if(duplicateIndex>=0){state.lines[duplicateIndex].quantity += placeholder?.quantity || 1;if(loadingIndex>=0)state.lines.splice(loadingIndex,1);renderLines(duplicateIndex,true);loadPendingSO(state.lines[duplicateIndex]);}
    else if(loadingIndex>=0){state.lines[loadingIndex]={...line,quantity:placeholder.quantity};renderLines(loadingIndex,true);loadPendingSO(state.lines[loadingIndex]);}
    else {state.lines.push(line);const targetIndex=state.lines.length-1;$('itemSearch').value='';renderLines(targetIndex,true);loadPendingSO(state.lines[targetIndex]);$('itemSearch').focus();}
  }catch(e){if(placeholder){const index=state.lines.indexOf(placeholder);if(index>=0){state.lines.splice(index,1);renderLines();}}throw e;}finally{pending(-1);}
}
async function scanItemText(text) {
  if(!state.customer)throw new Error('Select a customer before adding items.');
  const placeholder=quickLineFromScan(text);
  state.lines.push(placeholder);$('itemSearch').value='';renderLines(state.lines.length-1);$('itemSearch').focus();pending(1);
  try{
    const r=await api.searchItems(text,1);
    const records=(r.items||[]).filter(x=>x.status!=='inactive' && x.is_active!==false);
    const record=scannerMatch(records,text);
    if(!record)throw new Error(`No ERP item found for ${text}.`);
    await addItem(record,{placeholder,fast:true});
  }catch(e){const index=state.lines.indexOf(placeholder);if(index>=0){state.lines[index]={...placeholder,name:'Item not found',loading:false,notFound:true,error:e.message};renderLines(index,true);}$('itemSearch').focus();throw e;}
  finally{pending(-1);}
}
const browse=searchable('itemSearch','itemResults',(q,p)=>api.searchItems(q,p),'items',i=>[i.name,`${i.sku || 'No SKU'} · ${money(Number(i.rate||0))} · Stock ${i.available_stock ?? i.stock_on_hand ?? '—'}`],addItem,{scanOnEnter:true,scanImmediate:async text=>{try{await scanItemText(text);}catch(e){error(e);}}});
$('browseItems').onclick=()=>{$('itemSearch').focus();if($('itemSearch').value.trim())browse();};
$('salesOrder').addEventListener('change',async()=>{
  if(!$('salesOrder').value)return;
  if(!window.RAJADHANI_PREVIEW_CONFIG){notice('Sales-order import needs confirmation of whether ERP order quantities represent sets or pieces. Add items directly for now.');$('salesOrder').value='';return;}
  if(state.lines.length){notice('Remove the current invoice items before importing a sales order.');$('salesOrder').value='';return;}
  const version=state.customerVersion;pending(1);$('salesOrder').disabled=true;
  try{const order=await api.salesOrder($('salesOrder').value);if(version!==state.customerVersion)return;if(String(order.customer_id)!==String(state.customer?.contact_id))throw new Error('Sales order belongs to a different customer.');
    const lines=[];for(const l of order.line_items||[]){const remaining=Number(l.quantity)-Number(l.quantity_invoiced||0);if(remaining<=0)continue;const item=await fullItem(l);lines.push(await lineFromItem({...item,...l,custom_fields:item.custom_fields,custom_field_hash:item.custom_field_hash},{quantity:remaining,salesorder_item_id:l.line_item_id}));}
    if(version!==state.customerVersion)return;state.lines=lines;if(order.salesperson_id)$('salesperson').value=String(order.salesperson_id);renderLines(null,true);if(state.lines[0])loadPendingSO(state.lines[0]);notice('Unbilled sales order items imported. Review quantities, rates and taxes.');
  }catch(e){error(e);}finally{pending(-1);if(version===state.customerVersion)$('salesOrder').disabled=false;}
});
async function loadLookups() {
  const jobs=[
    {name:'customers',run:()=>api.searchCustomers('',1)},
    {name:'items',run:()=>api.searchItems('',1)},
    {name:'taxes',run:async()=>{state.taxes=(await api.all('/settings/taxes','taxes')).filter(t=>t.is_active!==false).map(normalizeTax);applyPlaceOfSupplyTaxes();renderLines();}},
    {name:'salespersons',run:async()=>{const source=config.lookupSources.salesperson;if(source)selectOptions('salesperson',await api.all(source.path,source.key,source.query),source.idKey,source.labelKey,'Select salesperson');else selectOptions('salesperson',await api.salespersons(),'salesperson_id','salesperson_name','Select salesperson');}},
    {name:'locations',run:async()=>{selectOptions('location',await api.all('/locations','locations'),'location_id','location_name','Organization default');}},
    ...Object.entries(config.lookupSources).filter(([key])=>key!=='salesperson'&&key!=='billType').map(([key,source])=>({name:config.customFields[key]?.label||key,run:async()=>{if(!$(`cf_${key}`))return;selectOptions(`cf_${key}`,await api.all(source.path,source.key,source.query),source.idKey,source.labelKey,`Select ${config.customFields[key].label.toLowerCase()}`);}}))
  ];
  const results=await Promise.allSettled(jobs.map(j=>j.run()));const failures=results.flatMap((r,i)=>r.status==='rejected'?[`${jobs[i].name}: ${r.reason.message}`]:[]);
  if(failures.length)notice(`Some ERP lists could not load. ${failures.join(' • ')}`,'error');
  else notice('');
  return failures;
}
async function connect() {
  try{if(!api.ready)await Promise.race([api.init(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('ERP did not respond. Open the installed widget in your organization and retry.')),12000))]);
    $('orgId').value=config.organizationId;$('connectionName').value=config.connectionLinkName;
    if(!config.connectionLinkName)throw new Error('Connection setup required. Add your ERP connection in settings and map the business fields in app/config.json.');
    const failures=await loadLookups();$('connectionStatus').textContent=window.RAJADHANI_PREVIEW_CONFIG?'Preview · sample data':failures.length?'ERP access incomplete':'ERP connected';$('connectionStatus').className=`status ${window.RAJADHANI_PREVIEW_CONFIG||failures.length?'offline':''}`;
    $('footerStatus').textContent=api.organization?.name || 'Zoho ERP';
    try{const user=await api.sdk.get('user');const u=user.user||user;$('cf_billCreatedBy').value=u.name||'';$('avatar').textContent=(u.name||'R').slice(0,1);}catch{/* User name can be entered manually. */}
  }catch(e){$('connectionStatus').textContent='Setup required';$('connectionStatus').className='status offline';notice(e.message);}
}
$('settingsButton').onclick=()=>{$('connectionName').value=config.connectionLinkName;$('orgId').value=config.organizationId;$('settingsDialog').showModal();};
$('connectButton').onclick=async()=>{if(state.lines.length||state.customer){notice('Start over before changing the ERP connection.');$('settingsDialog').close();return;}config.connectionLinkName=$('connectionName').value.trim();config.organizationId=$('orgId').value.trim();$('settingsDialog').close();await connect();};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('resetButton').onclick=()=>$('resetDialog').showModal();$('confirmReset').onclick=()=>{state.allowClose=true;location.reload();};
$('invoiceForm').addEventListener('submit',e=>{
  e.preventDefault();if(state.saved||state.busy||state.uncertain)return;
  if(state.pendingOperations){notice('Wait for ERP records to finish loading before reviewing.');return;}
  const v=getValues(),errors=validateInvoice(state,v,config);if(errors.length){notice(errors.join(' '),'error');return;}
  approvedPayload=makePayload(state,v,config);const t=calculate(state.lines,v.discount,v.discountType,v.rounded);
  $('reviewContent').innerHTML=`<div class="summaryrow"><span>Customer</span><strong>${esc(state.customer.contact_name)}</strong></div><div class="summaryrow"><span>Invoice date</span><strong>${esc(v.date)}</strong></div>${state.lines.map(l=>`<div class="summaryrow"><span>${esc(l.name)} · ${l.quantity} × ${l.pieces ?? "?"} = ${l.pieces ? pieceQuantity(l) : "?"} pieces</span><strong>${esc(money(pieceQuantity(l)*l.rate))}</strong></div>`).join('')}<div class="grandtotal"><span>Estimated invoice total</span><strong>${esc(money(t.total))}</strong></div><p>This creates a draft invoice. It does not email the customer. ERP will calculate the final total.</p>`;
  $('saveStatus').textContent='';$('confirmSave').disabled=!!window.RAJADHANI_PREVIEW_CONFIG;if(window.RAJADHANI_PREVIEW_CONFIG)$('saveStatus').textContent='Preview only. No records will be created.';$('reviewDialog').showModal();
});
$('confirmSave').onclick=async()=>{
  if(state.busy||state.saved||state.uncertain||!approvedPayload||window.RAJADHANI_PREVIEW_CONFIG)return;
  state.busy=true;$('confirmSave').disabled=true;$('saveStatus').textContent='Saving invoice to ERP…';
  try{const result=await api.createInvoice(approvedPayload);if(!result.invoice?.invoice_id)throw new Error('ERP did not return an invoice ID.');
    state.saved=true;$('reviewDialog').close();$('invoiceNumber').value=result.invoice.invoice_number || result.invoice.invoice_id;$('saveButton').disabled=true;$('saveButton').textContent='Saved to ERP ✓';
    notice(`Invoice ${result.invoice.invoice_number || result.invoice.invoice_id} saved in ERP (${result.invoice.status || 'created'}). Final total: ${money(Number(result.invoice.total))}.`,'success');
    $('invoiceForm').querySelectorAll('input,select,textarea,button').forEach(e=>e.disabled=true);
    await api.refreshInvoices();
    state.allowClose=true;
    exitAfterSave();
  }catch(e){if(e.apiRejected){$('saveStatus').textContent=e.message;$('confirmSave').disabled=false;}else{state.uncertain=true;$('saveButton').disabled=true;$('saveStatus').textContent='Could not confirm the result. Check the ERP invoice list before starting again to avoid a duplicate. '+e.message;}}finally{state.busy=false;}
};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('customerSearch').focus();}});
window.addEventListener('beforeunload',e=>{if(hasUnsavedWork()){e.preventDefault();e.returnValue='';}});
renderLines();await connect();
