// ── State ──────────────────────────────────────────────────────────────────

let ynabBudgets = [];
let ynabAccounts = [];
let ynabCategoryGroups = [];
let suggestedCategory = '';
let providerLabel = 'AI';

fetch('/api/config')
  .then(r => r.json())
  .then(({ provider }) => {
    providerLabel = provider === 'gemini' ? 'Gemini' : 'Claude';
  })
  .catch(() => {});

// ── View routing ───────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── Image processing ───────────────────────────────────────────────────────

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

async function handleFile(file) {
  if (!file) return;
  document.querySelector('.processing-text').textContent = `${providerLabel} is reading your receipt…`;
  showView('view-processing');

  try {
    const { base64, mediaType, dataUrl } = await compressImage(file);
    document.getElementById('receipt-img').src = dataUrl;

    const res = await fetch('/api/parse-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to parse receipt');
    }

    const { data } = await res.json();

    document.getElementById('payee-name').value = data.merchant_name ?? '';
    document.getElementById('txn-date').value = data.date ?? today();
    document.getElementById('amount').value = data.total_amount != null
      ? Number(data.total_amount).toFixed(2)
      : '';
    document.getElementById('memo').value = data.memo ?? '';
    suggestedCategory = data.suggested_category ?? '';

    await loadYnabData();
    showView('view-review');

  } catch (err) {
    showError(err.message);
  }
}

// ── YNAB data loading ──────────────────────────────────────────────────────

async function loadYnabData() {
  const budgetSel = document.getElementById('budget-select');
  const accountSel = document.getElementById('account-select');
  const catSel = document.getElementById('category-select');

  budgetSel.innerHTML = '<option>Loading…</option>';
  accountSel.innerHTML = '<option>Loading…</option>';
  catSel.innerHTML = '<option>Loading…</option>';

  try {
    const res = await fetch('/api/ynab/budgets');
    if (!res.ok) throw new Error((await res.json()).error ?? 'YNAB error');
    const { budgets } = await res.json();

    ynabBudgets = budgets;
    budgetSel.innerHTML = budgets.map(b =>
      `<option value="${b.id}">${b.name}</option>`
    ).join('');

    if (budgets.length > 0) await loadBudgetData(budgets[0].id);
  } catch (err) {
    budgetSel.innerHTML = `<option>Error: ${err.message}</option>`;
  }
}

async function loadBudgetData(budgetId) {
  const accountSel = document.getElementById('account-select');
  const catSel = document.getElementById('category-select');

  try {
    const [acRes, catRes] = await Promise.all([
      fetch(`/api/ynab/budgets/${budgetId}/accounts`),
      fetch(`/api/ynab/budgets/${budgetId}/categories`)
    ]);

    const { accounts } = await acRes.json();
    const { category_groups } = await catRes.json();

    ynabAccounts = accounts.filter(a => !a.closed && !a.deleted && a.on_budget);
    ynabCategoryGroups = category_groups.filter(g => !g.deleted && !g.hidden);

    accountSel.innerHTML = ynabAccounts.map(a =>
      `<option value="${a.id}">${a.name}</option>`
    ).join('');

    catSel.innerHTML = '<option value="">Uncategorized</option>';
    ynabCategoryGroups.forEach(group => {
      const cats = group.categories.filter(c => !c.deleted && !c.hidden);
      if (!cats.length) return;
      const og = document.createElement('optgroup');
      og.label = group.name;
      cats.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        og.appendChild(opt);
      });
      catSel.appendChild(og);
    });

    matchCategory(catSel);
  } catch (err) {
    accountSel.innerHTML = `<option>Error: ${err.message}</option>`;
    catSel.innerHTML = `<option>Error: ${err.message}</option>`;
  }
}

function matchCategory(select) {
  if (!suggestedCategory) return;

  const keywords = {
    'food & dining': ['dining', 'restaurant', 'food', 'cafe', 'coffee', 'pizza', 'sushi'],
    'groceries': ['grocer', 'supermarket', 'market', 'food'],
    'gas & fuel': ['gas', 'fuel', 'petrol', 'auto'],
    'shopping': ['shopping', 'clothing', 'amazon', 'retail', 'electronics'],
    'entertainment': ['entertainment', 'fun', 'hobbies', 'game', 'movie', 'streaming'],
    'healthcare': ['health', 'medical', 'pharmacy', 'doctor', 'dental', 'hospital'],
    'transportation': ['transport', 'transit', 'uber', 'lyft', 'taxi', 'travel', 'flight'],
    'utilities': ['utilities', 'electric', 'water', 'internet', 'phone', 'cable']
  };

  const kws = keywords[suggestedCategory.toLowerCase()] ?? [suggestedCategory.toLowerCase()];

  for (const group of ynabCategoryGroups) {
    for (const cat of group.categories) {
      const name = cat.name.toLowerCase();
      if (kws.some(k => name.includes(k))) {
        select.value = cat.id;
        return;
      }
    }
  }
}

// ── Submit transaction ─────────────────────────────────────────────────────

async function submitTransaction(e) {
  e.preventDefault();

  const budgetId = document.getElementById('budget-select').value;
  const accountId = document.getElementById('account-select').value;
  const categoryId = document.getElementById('category-select').value || null;
  const payeeName = document.getElementById('payee-name').value.trim();
  const date = document.getElementById('txn-date').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const memo = document.getElementById('memo').value.trim() || null;
  const cleared = document.getElementById('cleared').checked;

  if (!budgetId || !accountId || !payeeName || !date || isNaN(amount)) {
    alert('Please fill in all required fields.');
    return;
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const res = await fetch(`/api/ynab/budgets/${budgetId}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction: {
          account_id: accountId,
          date,
          amount: Math.round(amount * 1000) * -1, // outflow = negative milliunits
          payee_name: payeeName,
          category_id: categoryId,
          memo,
          cleared: cleared ? 'cleared' : 'uncleared'
        }
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to create transaction');
    }

    const accountName = ynabAccounts.find(a => a.id === accountId)?.name ?? accountId;

    document.getElementById('success-payee').textContent = payeeName;
    document.getElementById('success-amount').textContent = `$${amount.toFixed(2)}`;
    document.getElementById('success-account').textContent = accountName;
    document.getElementById('success-icon').classList.add('bounce');

    showView('view-success');
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add to YNAB →';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  showView('view-error');
}

function resetFileInput(id) {
  document.getElementById(id).value = '';
}

// ── Event listeners ──────────────────────────────────────────────────────────

document.getElementById('file-camera').addEventListener('change', e => {
  handleFile(e.target.files[0]);
  resetFileInput('file-camera');
});

document.getElementById('file-upload').addEventListener('change', e => {
  handleFile(e.target.files[0]);
  resetFileInput('file-upload');
});

document.getElementById('budget-select').addEventListener('change', e => {
  if (e.target.value) loadBudgetData(e.target.value);
});

document.getElementById('back-to-scan').addEventListener('click', () => showView('view-scan'));
document.getElementById('error-back').addEventListener('click', () => showView('view-scan'));
document.getElementById('scan-another').addEventListener('click', () => showView('view-scan'));

document.getElementById('txn-form').addEventListener('submit', submitTransaction);

// ── Service worker ───────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

showView('view-scan');
