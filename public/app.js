// ── State ──────────────────────────────────────────────────────────────────

let ynabAccounts = [];
let categoryList = []; // {id, name, groupName}
let splits = [];       // {id, categoryId, categoryName, amount, description}
let nextSplitId = 0;
let providerLabel = 'AI';

fetch('/api/config')
  .then(r => r.json())
  .then(({ provider }) => { providerLabel = provider === 'gemini' ? 'Gemini' : 'Claude'; })
  .catch(() => {});

// Pre-load YNAB categories silently so they're ready before the first scan
preloadYnabData();

// ── View routing ───────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── Autocomplete ───────────────────────────────────────────────────────────

function createAutocomplete(input, getItems) {
  const wrap = input.closest('.ac-wrap');
  let dropdown = null;
  let activeIdx = -1;

  function open(items) {
    close();
    if (!items.length) return;

    dropdown = document.createElement('ul');
    dropdown.className = 'ac-list';

    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'ac-item';
      li.innerHTML = `<span class="ac-name">${esc(item.display)}</span>`
        + (item.sub ? `<span class="ac-sub">${esc(item.sub)}</span>` : '');
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(item); });
      dropdown.appendChild(li);
    });

    wrap.appendChild(dropdown);
    activeIdx = -1;
  }

  function close() {
    dropdown?.remove();
    dropdown = null;
    activeIdx = -1;
  }

  function pick(item) {
    input.value = item.display;
    input.dataset.acId = item.id ?? '';
    close();
    input.dispatchEvent(new CustomEvent('ac:select', { bubbles: true, detail: item }));
  }

  function setActive(n) {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.ac-item');
    items.forEach((li, i) => li.classList.toggle('active', i === n));
    activeIdx = n;
  }

  input.addEventListener('input', () => {
    input.dataset.acId = '';
    open(getItems(input.value));
  });
  input.addEventListener('focus', () => open(getItems(input.value)));
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0) items[activeIdx].dispatchEvent(new MouseEvent('mousedown')); }
    else if (e.key === 'Escape') close();
  });

  return { pick };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Image compression ──────────────────────────────────────────────────────

async function compressImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1600;
      let { width, height } = img;
      if (width > height ? width > MAX : height > MAX) {
        if (width > height) { height = (height * MAX) / width; width = MAX; }
        else { width = (width * MAX) / height; height = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl });
    };
    img.src = url;
  });
}

// ── File handling ──────────────────────────────────────────────────────────

async function handleFile(file) {
  if (!file) return;
  document.querySelector('.processing-text').textContent = `${providerLabel} is reading your receipt…`;
  showView('view-processing');

  try {
    const { base64, mediaType, dataUrl } = await compressImage(file);
    document.getElementById('receipt-img').src = dataUrl;

    // Include real YNAB categories if already loaded (from background preload)
    const categories = categoryList.length
      ? categoryList.map(c => `${c.name} (${c.groupName})`).join('\n')
      : undefined;

    const res = await fetch('/api/parse-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType, categories })
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to parse receipt');

    const { data } = await res.json();

    document.getElementById('payee-name').value = data.merchant_name ?? '';
    document.getElementById('txn-date').value = data.date ?? today();
    document.getElementById('amount').value = data.total_amount != null ? Number(data.total_amount).toFixed(2) : '';
    document.getElementById('memo').value = data.memo ?? '';

    // Build splits from AI response
    splits = [];
    nextSplitId = 0;
    const aiSplits = data.splits?.length
      ? data.splits
      : [{ category: '', amount: data.total_amount ?? 0, description: data.memo ?? '' }];

    aiSplits.forEach(s => splits.push({
      id: nextSplitId++,
      categoryId: null,
      categoryName: s.category ?? '',
      amount: Number(s.amount) || 0,
      description: s.description ?? ''
    }));

    // Reset account
    const accountInput = document.getElementById('account-input');
    accountInput.value = '';
    accountInput.dataset.acId = '';

    await loadYnabData();
    showView('view-review');

  } catch (err) {
    showError(err.message);
  }
}

// ── YNAB loading ───────────────────────────────────────────────────────────

// Fetches accounts + categories into state — no DOM side-effects.
// Called both at startup (preload) and when the review form is shown.
async function fetchBudgetData(budgetId) {
  const [acRes, catRes] = await Promise.all([
    fetch(`/api/ynab/budgets/${budgetId}/accounts`),
    fetch(`/api/ynab/budgets/${budgetId}/categories`)
  ]);

  const { accounts } = await acRes.json();
  const { category_groups } = await catRes.json();

  ynabAccounts = accounts.filter(a => !a.closed && !a.deleted && a.on_budget);

  categoryList = [];
  category_groups
    .filter(g => !g.deleted && !g.hidden)
    .forEach(g => g.categories
      .filter(c => !c.deleted && !c.hidden)
      .forEach(c => categoryList.push({ id: c.id, name: c.name, groupName: g.name }))
    );
}

// Silent background fetch on startup so categories are ready before the first scan.
async function preloadYnabData() {
  try {
    const res = await fetch('/api/ynab/budgets');
    if (!res.ok) return;
    const { budgets } = await res.json();
    if (budgets.length) await fetchBudgetData(budgets[0].id);
  } catch { /* silently ignore — review screen will load data anyway */ }
}

async function loadYnabData() {
  const budgetSel = document.getElementById('budget-select');
  budgetSel.innerHTML = '<option>Loading…</option>';

  try {
    const res = await fetch('/api/ynab/budgets');
    if (!res.ok) throw new Error((await res.json()).error ?? 'YNAB error');
    const { budgets } = await res.json();

    budgetSel.innerHTML = budgets.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    if (budgets.length) await loadBudgetData(budgets[0].id);
  } catch (err) {
    budgetSel.innerHTML = `<option>Error: ${esc(err.message)}</option>`;
    renderSplits();
  }
}

async function loadBudgetData(budgetId) {
  try {
    await fetchBudgetData(budgetId);

    // Reset account selection
    const accountInput = document.getElementById('account-input');
    accountInput.value = '';
    accountInput.dataset.acId = '';

    // Match split category names to real YNAB categories, then render
    splits.forEach(s => {
      if (!s.categoryId && s.categoryName) {
        const match = findCategory(s.categoryName);
        if (match) { s.categoryId = match.id; s.categoryName = match.name; }
      }
    });

    renderSplits();
  } catch (err) {
    console.error('Budget load error:', err);
    renderSplits();
  }
}

// ── Filtering ─────────────────────────────────────────────────────────────

function filterAccounts(q) {
  const lc = q.toLowerCase();
  return (lc
    ? ynabAccounts.filter(a => a.name.toLowerCase().includes(lc))
    : ynabAccounts
  ).map(a => ({ id: a.id, display: a.name }));
}

function filterCategories(q) {
  const lc = q.toLowerCase();
  return (lc
    ? categoryList.filter(c => c.name.toLowerCase().includes(lc) || c.groupName.toLowerCase().includes(lc))
    : categoryList
  ).slice(0, 15).map(c => ({ id: c.id, display: c.name, sub: c.groupName }));
}

function findCategory(suggested) {
  const lc = suggested.toLowerCase();

  // Exact match first
  const exact = categoryList.find(c => c.name.toLowerCase() === lc);
  if (exact) return exact;

  // Keyword fuzzy match
  const kws = {
    'food & dining': ['dining', 'restaurant', 'food', 'cafe', 'coffee', 'pizza', 'takeout'],
    'groceries': ['grocer', 'supermarket', 'market', 'produce'],
    'gas & fuel': ['gas', 'fuel', 'petrol', 'auto'],
    'shopping': ['shopping', 'clothing', 'amazon', 'retail', 'electronics'],
    'entertainment': ['entertainment', 'hobbies', 'streaming', 'movie', 'game'],
    'healthcare': ['health', 'medical', 'pharmacy', 'doctor', 'dental'],
    'transportation': ['transport', 'transit', 'uber', 'lyft', 'taxi', 'travel'],
    'utilities': ['utilities', 'electric', 'water', 'internet', 'phone']
  };

  const words = Object.entries(kws).find(([k]) => lc === k || lc.includes(k))?.[1] ?? [lc];
  return categoryList.find(c => {
    const cn = c.name.toLowerCase(), gn = c.groupName.toLowerCase();
    return words.some(w => cn.includes(w) || gn.includes(w));
  }) ?? null;
}

// ── Splits rendering ───────────────────────────────────────────────────────

function renderSplits() {
  const container = document.getElementById('splits-list');
  container.innerHTML = '';

  splits.forEach(split => {
    const row = document.createElement('div');
    row.className = 'split-row';

    // Category autocomplete
    const catWrap = document.createElement('div');
    catWrap.className = 'ac-wrap';
    const catInput = document.createElement('input');
    catInput.type = 'text';
    catInput.className = 'split-cat';
    catInput.placeholder = 'Category…';
    catInput.autocomplete = 'off';
    catInput.value = split.categoryName;
    if (split.categoryId) catInput.dataset.acId = split.categoryId;
    catWrap.appendChild(catInput);

    // Amount
    const amtInput = document.createElement('input');
    amtInput.type = 'number';
    amtInput.className = 'split-amt';
    amtInput.placeholder = '0.00';
    amtInput.step = '0.01';
    amtInput.inputMode = 'decimal';
    amtInput.min = '0';
    if (split.amount > 0) amtInput.value = split.amount.toFixed(2);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'split-remove';
    removeBtn.textContent = '×';
    removeBtn.disabled = splits.length === 1;

    row.appendChild(catWrap);
    row.appendChild(amtInput);
    row.appendChild(removeBtn);
    container.appendChild(row); // must be in DOM before creating autocomplete

    // Wire up autocomplete
    createAutocomplete(catInput, filterCategories);
    catInput.addEventListener('ac:select', e => {
      split.categoryId = e.detail.id;
      split.categoryName = e.detail.display;
    });
    catInput.addEventListener('change', () => {
      if (!catInput.dataset.acId) {
        split.categoryId = null;
        split.categoryName = catInput.value;
      }
    });

    amtInput.addEventListener('input', () => {
      split.amount = parseFloat(amtInput.value) || 0;
      updateSplitTotal();
    });

    removeBtn.addEventListener('click', () => {
      splits = splits.filter(s => s.id !== split.id);
      renderSplits();
    });
  });

  updateSplitTotal();
}

function updateSplitTotal() {
  const el = document.getElementById('split-total');
  if (splits.length <= 1) { el.textContent = ''; el.className = 'split-total-info'; return; }

  const total = parseFloat(document.getElementById('amount').value) || 0;
  const sum = Math.round(splits.reduce((a, s) => a + s.amount, 0) * 100) / 100;
  const diff = Math.round((total - sum) * 100) / 100;

  if (Math.abs(diff) < 0.01) {
    el.textContent = `✓ Splits total $${sum.toFixed(2)}`;
    el.className = 'split-total-info ok';
  } else {
    el.textContent = `$${sum.toFixed(2)} of $${total.toFixed(2)} · ${diff > 0 ? '+' : ''}$${diff.toFixed(2)} remaining`;
    el.className = 'split-total-info warn';
  }
}

// ── Transaction submission ─────────────────────────────────────────────────

async function submitTransaction(e) {
  e.preventDefault();

  const budgetId = document.getElementById('budget-select').value;
  const payeeName = document.getElementById('payee-name').value.trim();
  const date = document.getElementById('txn-date').value;
  const totalAmount = parseFloat(document.getElementById('amount').value);
  const memo = document.getElementById('memo').value.trim() || null;
  const cleared = document.getElementById('cleared').checked;

  const accountInput = document.getElementById('account-input');
  const accountId = accountInput.dataset.acId;

  if (!payeeName || !date || isNaN(totalAmount)) {
    alert('Please fill in payee, date, and amount.'); return;
  }
  if (!accountId) {
    alert('Please select an account from the dropdown.'); accountInput.focus(); return;
  }

  if (splits.length > 1) {
    const sum = Math.round(splits.reduce((a, s) => a + s.amount, 0) * 100) / 100;
    if (Math.abs(sum - totalAmount) > 0.01) {
      alert(`Split amounts ($${sum.toFixed(2)}) must equal the total ($${totalAmount.toFixed(2)}).`); return;
    }
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const totalMill = Math.round(totalAmount * 1000) * -1;
    let transaction;

    if (splits.length > 1) {
      transaction = {
        account_id: accountId, date, amount: totalMill,
        payee_name: payeeName, memo,
        cleared: cleared ? 'cleared' : 'uncleared',
        subtransactions: splits.map(s => ({
          amount: Math.round(s.amount * 1000) * -1,
          category_id: s.categoryId || null,
          memo: s.description || null
        }))
      };
    } else {
      transaction = {
        account_id: accountId, date, amount: totalMill,
        payee_name: payeeName,
        category_id: splits[0]?.categoryId || null,
        memo, cleared: cleared ? 'cleared' : 'uncleared'
      };
    }

    const res = await fetch(`/api/ynab/budgets/${budgetId}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction })
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to create transaction');

    const accountName = ynabAccounts.find(a => a.id === accountId)?.name ?? accountId;
    document.getElementById('success-payee').textContent = payeeName;
    document.getElementById('success-amount').textContent = `$${totalAmount.toFixed(2)}`;
    document.getElementById('success-account').textContent = accountName;

    const icon = document.getElementById('success-icon');
    icon.classList.remove('bounce');
    void icon.offsetWidth;
    icon.classList.add('bounce');

    showView('view-success');
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add to YNAB →';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function showError(msg) { document.getElementById('error-message').textContent = msg; showView('view-error'); }
function resetInput(id) { document.getElementById(id).value = ''; }

// ── Event listeners ──────────────────────────────────────────────────────────

document.getElementById('file-camera').addEventListener('change', e => { handleFile(e.target.files[0]); resetInput('file-camera'); });
document.getElementById('file-upload').addEventListener('change', e => { handleFile(e.target.files[0]); resetInput('file-upload'); });

document.getElementById('budget-select').addEventListener('change', e => { if (e.target.value) loadBudgetData(e.target.value); });

document.getElementById('back-to-scan').addEventListener('click', () => showView('view-scan'));
document.getElementById('error-back').addEventListener('click', () => showView('view-scan'));
document.getElementById('scan-another').addEventListener('click', () => showView('view-scan'));

document.getElementById('add-split-btn').addEventListener('click', () => {
  splits.push({ id: nextSplitId++, categoryId: null, categoryName: '', amount: 0, description: '' });
  renderSplits();
  document.querySelectorAll('.split-cat').forEach((el, i, arr) => { if (i === arr.length - 1) el.focus(); });
});

document.getElementById('amount').addEventListener('input', updateSplitTotal);
document.getElementById('txn-form').addEventListener('submit', submitTransaction);

// Account autocomplete (created once; filterAccounts reads ynabAccounts dynamically)
createAutocomplete(document.getElementById('account-input'), filterAccounts);

// ── Service worker ───────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

showView('view-scan');
