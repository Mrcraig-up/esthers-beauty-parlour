// ESTHERS BEAUTY PARLOUR — Stock & Till backend
// Database: Supabase Postgres (persistent — survives restarts/redeploys,
// unlike a SQLite file on Render's ephemeral disk).
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// DATABASE_URL is the full Postgres connection string from Supabase
// (Project Settings → Database → Connection string).
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in your host\'s environment variables.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wraps an async route handler so a thrown error becomes a clean 500
// instead of crashing the process or hanging the request.
const ah = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Server error.' });
});

const uid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');

/* ---------------- SCHEMA (safe to run every boot) ---------------- */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branches(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT
    );
    CREATE TABLE IF NOT EXISTS employees(
      id TEXT PRIMARY KEY, work_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL, branch_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products(
      id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      category TEXT NOT NULL, unit TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL, cost DOUBLE PRECISION NOT NULL, reorder_level DOUBLE PRECISION NOT NULL,
      is_service BOOLEAN NOT NULL DEFAULT FALSE,
      color TEXT, density TEXT, length TEXT,
      is_freebie_only BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS stock(
      branch_id TEXT NOT NULL, product_id TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY(branch_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS sales(
      id TEXT PRIMARY KEY, seq TEXT NOT NULL, branch_id TEXT NOT NULL, employee_id TEXT NOT NULL,
      total DOUBLE PRECISION NOT NULL, timestamp BIGINT NOT NULL,
      discount DOUBLE PRECISION NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'Cash',
      amount_received DOUBLE PRECISION,
      change_due DOUBLE PRECISION,
      currency TEXT NOT NULL DEFAULT 'USD',
      fx_rate DOUBLE PRECISION
    );
    CREATE TABLE IF NOT EXISTS sale_items(
      id SERIAL PRIMARY KEY, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL, price DOUBLE PRECISION NOT NULL,
      is_freebie BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS stock_requests(
      id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, product_id TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL, type TEXT NOT NULL, reason TEXT,
      requested_by TEXT NOT NULL, requested_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_by TEXT, confirmed_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS audit_log(
      id TEXT PRIMARY KEY, timestamp BIGINT NOT NULL, branch_id TEXT,
      employee_id TEXT, action TEXT NOT NULL, details TEXT
    );
    CREATE TABLE IF NOT EXISTS counters(
      name TEXT PRIMARY KEY, value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories(
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS returns(
      id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, product_id TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL, reason TEXT, sale_id TEXT, refund_amount DOUBLE PRECISION,
      employee_id TEXT NOT NULL, timestamp BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY, value TEXT
    );
  `);
}

/* ---------------- SEED (first run only) ---------------- */
async function ensureSeed() {
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM branches');
  if (count === 0) {
    const b1 = uid('br'), b2 = uid('br');
    const admin = uid('emp'), m1 = uid('emp'), c1 = uid('emp'), c2 = uid('emp');

    await pool.query('INSERT INTO branches(id,name,location) VALUES ($1,$2,$3)', [b1, 'Rotten Row', 'Rotten Row, Harare']);
    await pool.query('INSERT INTO branches(id,name,location) VALUES ($1,$2,$3)', [b2, 'Robert Mugabe', 'Robert Mugabe Road, Harare']);

    const emps = [
      [admin, 'ADM-001', 'System Administrator', 'Administrator', 'ALL'],
      [m1, 'EBP-001', 'Branch Manager', 'Manager', b1],
      [c1, 'EBP-002', 'Cashier', 'Cashier', b1],
      [c2, 'EBP-003', 'Cashier', 'Cashier', b2],
    ];
    for (const e of emps) {
      await pool.query('INSERT INTO employees(id,work_id,name,role,branch_id) VALUES ($1,$2,$3,$4,$5)', e);
    }
    // No example products are seeded — branches and staff logins are ready,
    // but every product/service in your catalogue is one you add yourself
    // via Inventory, so nothing here assumes what you stock.
    await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2)', ['fxCurrency', 'ZiG']);
    await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2)', ['fxRate', '0']);
    await pool.query('INSERT INTO counters(name,value) VALUES ($1,$2)', ['receipt_seq', 0]);
    console.log('Database seeded.');
  }
  const seqRow = await pool.query('SELECT 1 FROM counters WHERE name=$1', ['receipt_seq']);
  if (seqRow.rowCount === 0) await pool.query('INSERT INTO counters(name,value) VALUES ($1,$2)', ['receipt_seq', 0]);
  const fxc = await pool.query('SELECT 1 FROM settings WHERE key=$1', ['fxCurrency']);
  if (fxc.rowCount === 0) await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2)', ['fxCurrency', 'ZiG']);
  const fxr = await pool.query('SELECT 1 FROM settings WHERE key=$1', ['fxRate']);
  if (fxr.rowCount === 0) await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2)', ['fxRate', '0']);
}

/* ---------------- HELPERS ---------------- */
async function logAudit({ branchId, employeeId, action, details }) {
  await pool.query(
    'INSERT INTO audit_log(id,timestamp,branch_id,employee_id,action,details) VALUES ($1,$2,$3,$4,$5,$6)',
    [uid('aud'), Date.now(), branchId || null, employeeId || null, action, details || '']
  );
}
async function nextWorkId() {
  const { rows } = await pool.query('SELECT work_id FROM employees');
  let max = 0;
  rows.forEach(r => { const m = r.work_id.match(/(\d+)$/); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return 'EBP-' + String(max + 1).padStart(3, '0');
}
function toEmpDTO(e) { return { id: e.id, workId: e.work_id, name: e.name, role: e.role, branchId: e.branch_id }; }
async function getEmployee(id) {
  const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [id]);
  return rows[0] || null;
}
async function getProduct(id) {
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
  return rows[0] || null;
}

/* ---------------- AUTH ---------------- */
// Lightweight auth: Work ID + Name, both assigned by an Administrator/Manager.
app.post('/api/auth/login', ah(async (req, res) => {
  const { workId, name } = req.body || {};
  if (!workId || !name) return res.status(400).json({ error: 'Work ID and Name are required.' });
  const { rows } = await pool.query('SELECT * FROM employees WHERE LOWER(work_id)=LOWER($1) AND LOWER(name)=LOWER($2)', [workId.trim(), name.trim()]);
  const emp = rows[0];
  if (!emp) return res.status(401).json({ error: "Work ID and Name don't match our records." });
  await logAudit({ branchId: emp.branch_id === 'ALL' ? null : emp.branch_id, employeeId: emp.id, action: 'Log in', details: `${emp.name} (${emp.work_id}) logged in` });
  res.json({ employee: toEmpDTO(emp) });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  const { employeeId, branchId } = req.body || {};
  const emp = await getEmployee(employeeId);
  if (emp) await logAudit({ branchId, employeeId, action: 'Log out', details: `${emp.name} (${emp.work_id}) logged out` });
  res.json({ ok: true });
}));

/* ---------------- BRANCHES ---------------- */
app.get('/api/branches', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM branches');
  res.json(rows.map(b => ({ id: b.id, name: b.name, location: b.location })));
}));
app.post('/api/branches', ah(async (req, res) => {
  const { name, location, actorId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Branch name is required.' });
  const actor = await getEmployee(actorId);
  if (!actor || actor.role !== 'Administrator') return res.status(403).json({ error: 'Only the Administrator can add branches.' });
  const id = uid('br');
  await pool.query('INSERT INTO branches(id,name,location) VALUES ($1,$2,$3)', [id, name, location || '']);
  const { rows: products } = await pool.query('SELECT id FROM products WHERE is_service=FALSE');
  for (const p of products) {
    await pool.query('INSERT INTO stock(branch_id,product_id,qty) VALUES ($1,$2,0)', [id, p.id]);
  }
  await logAudit({ branchId: id, employeeId: actorId, action: 'Add branch', details: `${name} (${location || '—'}) added` });
  res.json({ id, name, location });
}));

/* ---------------- EMPLOYEES ---------------- */
app.get('/api/employees', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees');
  res.json(rows.map(toEmpDTO));
}));
app.post('/api/employees', ah(async (req, res) => {
  const { name, workId, role, branchId, actorId } = req.body || {};
  const actor = await getEmployee(actorId);
  if (!actor || (actor.role !== 'Administrator' && actor.role !== 'Manager')) {
    return res.status(403).json({ error: 'Only Administrators and Managers can add employees.' });
  }
  if (!name || !workId || !role || !branchId) return res.status(400).json({ error: 'Missing fields.' });
  if (actor.role === 'Manager' && branchId !== actor.branch_id) {
    return res.status(403).json({ error: 'Managers can only add employees to their own branch.' });
  }
  if (role === 'Administrator' && actor.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only an Administrator can create another Administrator.' });
  }
  const exists = await pool.query('SELECT 1 FROM employees WHERE LOWER(work_id)=LOWER($1)', [workId]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'That Work ID is already assigned to another employee.' });
  const id = uid('emp');
  await pool.query('INSERT INTO employees(id,work_id,name,role,branch_id) VALUES ($1,$2,$3,$4,$5)', [id, workId, name, role, branchId]);
  await logAudit({ branchId, employeeId: actorId, action: 'Add employee', details: `${name} (${workId}, ${role}) added` });
  res.json(toEmpDTO({ id, work_id: workId, name, role, branch_id: branchId }));
}));
app.get('/api/employees/next-work-id', ah(async (req, res) => res.json({ workId: await nextWorkId() })));
app.delete('/api/employees/:id', ah(async (req, res) => {
  const { actorId } = req.body || {};
  const actor = await getEmployee(actorId);
  const target = await getEmployee(req.params.id);
  if (!actor || !target) return res.status(404).json({ error: 'Not found.' });
  if (actor.role !== 'Administrator' && actor.role !== 'Manager') return res.status(403).json({ error: 'Not permitted.' });
  if (target.role === 'Administrator') return res.status(403).json({ error: 'Cannot remove an Administrator.' });
  if (target.id === actor.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
  await pool.query('DELETE FROM employees WHERE id=$1', [target.id]);
  await logAudit({ branchId: target.branch_id, employeeId: actorId, action: 'Remove employee', details: `${target.name} (${target.work_id}) removed` });
  res.json({ ok: true });
}));

/* ---------------- CATEGORIES ---------------- */
app.get('/api/categories', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY name');
  res.json(rows.map(c => ({ id: c.id, name: c.name })));
}));
app.post('/api/categories', ah(async (req, res) => {
  const { name, actorId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required.' });
  const exists = await pool.query('SELECT 1 FROM categories WHERE LOWER(name)=LOWER($1)', [name.trim()]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'That category already exists.' });
  const id = uid('cat');
  await pool.query('INSERT INTO categories(id,name) VALUES ($1,$2)', [id, name.trim()]);
  await logAudit({ employeeId: actorId, action: 'Add category', details: `"${name.trim()}" added` });
  res.json({ id, name: name.trim() });
}));
app.delete('/api/categories/:id', ah(async (req, res) => {
  const { actorId } = req.body || {};
  const actor = await getEmployee(actorId);
  if (!actor || actor.role !== 'Administrator') return res.status(403).json({ error: 'Only the Administrator can remove categories.' });
  const { rows } = await pool.query('SELECT * FROM categories WHERE id=$1', [req.params.id]);
  const cat = rows[0];
  if (!cat) return res.status(404).json({ error: 'Not found.' });
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE category=$1', [cat.name]);
  if (count > 0) return res.status(409).json({ error: `${count} product(s) still use this category.` });
  await pool.query('DELETE FROM categories WHERE id=$1', [cat.id]);
  await logAudit({ employeeId: actorId, action: 'Remove category', details: `"${cat.name}" removed` });
  res.json({ ok: true });
}));

/* ---------------- SETTINGS (foreign currency) ---------------- */
app.get('/api/settings', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM settings');
  const map = {}; rows.forEach(r => map[r.key] = r.value);
  res.json({ fxCurrency: map.fxCurrency || 'ZiG', fxRate: Number(map.fxRate || 0) });
}));
app.put('/api/settings', ah(async (req, res) => {
  const { fxCurrency, fxRate, actorId } = req.body || {};
  const actor = await getEmployee(actorId);
  if (!actor || actor.role !== 'Administrator') return res.status(403).json({ error: 'Only the Administrator can change currency settings.' });
  await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['fxCurrency', fxCurrency || 'ZiG']);
  await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['fxRate', String(fxRate || 0)]);
  await logAudit({ employeeId: actorId, action: 'Update currency settings', details: `${fxCurrency}, rate ${fxRate}` });
  res.json({ ok: true });
}));

/* ---------------- RETURNS ---------------- */
app.post('/api/returns', ah(async (req, res) => {
  const { branchId, productId, qty, reason, saleId, refundAmount, actorId } = req.body || {};
  if (!branchId || !productId || !qty || !actorId) return res.status(400).json({ error: 'Missing fields.' });
  const p = await getProduct(productId);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  if (!p.is_service) {
    const { rows } = await pool.query('SELECT qty FROM stock WHERE branch_id=$1 AND product_id=$2', [branchId, productId]);
    const cur = rows[0];
    const after = (cur ? cur.qty : 0) + Number(qty);
    if (cur) await pool.query('UPDATE stock SET qty=$1 WHERE branch_id=$2 AND product_id=$3', [after, branchId, productId]);
    else await pool.query('INSERT INTO stock(branch_id,product_id,qty) VALUES ($1,$2,$3)', [branchId, productId, after]);
  }
  const id = uid('ret');
  await pool.query('INSERT INTO returns(id,branch_id,product_id,qty,reason,sale_id,refund_amount,employee_id,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, branchId, productId, qty, reason || '—', saleId || null, refundAmount || 0, actorId, Date.now()]);
  await logAudit({ branchId, employeeId: actorId, action: 'Stock returned', details: `${p.name}: ${qty} ${p.unit} returned${p.is_service ? '' : ' to stock'} — ${reason || '—'}${refundAmount ? `, refunded $${Number(refundAmount).toFixed(2)}` : ''}` });
  res.json({ id, ok: true });
}));
app.get('/api/returns', ah(async (req, res) => {
  const { branchId, all } = req.query;
  const { rows } = all === '1'
    ? await pool.query('SELECT * FROM returns ORDER BY timestamp DESC LIMIT 300')
    : await pool.query('SELECT * FROM returns WHERE branch_id=$1 ORDER BY timestamp DESC LIMIT 300', [branchId]);
  res.json(rows.map(r => ({ id: r.id, branchId: r.branch_id, productId: r.product_id, qty: r.qty, reason: r.reason, saleId: r.sale_id, refundAmount: r.refund_amount, employeeId: r.employee_id, timestamp: Number(r.timestamp) })));
}));

/* ---------------- REPORTS ---------------- */
app.get('/api/reports/sales', ah(async (req, res) => {
  const { branchId, all, period } = req.query;
  const now = Date.now();
  let sinceMs, fmt;
  if (period === 'yearly') { sinceMs = now - 365 * 24 * 3600 * 1000; fmt = 'YYYY-MM'; }
  else if (period === 'monthly') { sinceMs = now - 30 * 24 * 3600 * 1000; fmt = 'YYYY-MM-DD'; }
  else { sinceMs = now - 7 * 24 * 3600 * 1000; fmt = 'YYYY-MM-DD'; }
  const { rows } = all === '1'
    ? await pool.query(
        `SELECT to_char(to_timestamp(timestamp/1000.0), $1) AS label, SUM(total) AS total, COUNT(*)::int AS count
         FROM sales WHERE timestamp>=$2 GROUP BY label ORDER BY label`, [fmt, sinceMs])
    : await pool.query(
        `SELECT to_char(to_timestamp(timestamp/1000.0), $1) AS label, SUM(total) AS total, COUNT(*)::int AS count
         FROM sales WHERE branch_id=$2 AND timestamp>=$3 GROUP BY label ORDER BY label`, [fmt, branchId, sinceMs]);
  res.json(rows.map(r => ({ label: r.label, total: Number(r.total), count: r.count })));
}));

/* ---------------- PRODUCTS ---------------- */
app.get('/api/products', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products');
  res.json(rows.map(p => ({
    id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit,
    price: p.price, cost: p.cost, reorderLevel: p.reorder_level, isService: p.is_service,
    color: p.color, density: p.density, length: p.length, isFreebieOnly: p.is_freebie_only
  })));
}));
app.post('/api/products', ah(async (req, res) => {
  const { sku, name, category, unit, price, cost, reorderLevel, openingStock, isService, color, density, length, isFreebieOnly, branchId, actorId } = req.body || {};
  if (!sku || !name || !category || !unit) return res.status(400).json({ error: 'Missing fields.' });
  const exists = await pool.query('SELECT 1 FROM products WHERE LOWER(sku)=LOWER($1)', [sku]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'That SKU already exists.' });
  const catExists = await pool.query('SELECT 1 FROM categories WHERE name=$1', [category]);
  if (catExists.rowCount === 0) await pool.query('INSERT INTO categories(id,name) VALUES ($1,$2)', [uid('cat'), category]);
  const id = uid('prod');
  const svc = !!isService;
  const freebieOnly = (!svc && !!isFreebieOnly);
  await pool.query(
    'INSERT INTO products(id,sku,name,category,unit,price,cost,reorder_level,is_service,color,density,length,is_freebie_only) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id, sku, name, category, unit, price || 0, svc ? 0 : (cost || 0), svc ? 0 : (reorderLevel || 0), svc, color || null, density || null, length || null, freebieOnly]
  );
  if (!svc) {
    const { rows: branches } = await pool.query('SELECT id FROM branches');
    for (const b of branches) {
      await pool.query('INSERT INTO stock(branch_id,product_id,qty) VALUES ($1,$2,$3)', [b.id, id, b.id === branchId ? (openingStock || 0) : 0]);
    }
  }
  await logAudit({ branchId, employeeId: actorId, action: svc ? 'Add service' : 'Add product', details: `${name} (${sku}) added${svc ? '' : `, opening stock ${openingStock || 0} ${unit}`}${freebieOnly ? ' — freebie-only item' : ''}` });
  res.json({ id, sku, name, category, unit, price, cost, reorderLevel, isService: svc, color, density, length, isFreebieOnly: freebieOnly });
}));
app.put('/api/products/:id', ah(async (req, res) => {
  const { sku, name, category, unit, price, cost, reorderLevel, isService, color, density, length, isFreebieOnly, actorId, branchId } = req.body || {};
  const p = await getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const catExists = await pool.query('SELECT 1 FROM categories WHERE name=$1', [category]);
  if (catExists.rowCount === 0) await pool.query('INSERT INTO categories(id,name) VALUES ($1,$2)', [uid('cat'), category]);
  const svc = !!isService;
  const freebieOnly = (!svc && !!isFreebieOnly);
  await pool.query(
    'UPDATE products SET sku=$1,name=$2,category=$3,unit=$4,price=$5,cost=$6,reorder_level=$7,is_service=$8,color=$9,density=$10,length=$11,is_freebie_only=$12 WHERE id=$13',
    [sku, name, category, unit, price, svc ? 0 : cost, svc ? 0 : reorderLevel, svc, color || null, density || null, length || null, freebieOnly, p.id]
  );
  await logAudit({ branchId, employeeId: actorId, action: 'Edit product', details: `${name} (${sku}) updated` });
  res.json({ ok: true });
}));
app.delete('/api/products/:id', ah(async (req, res) => {
  const { actorId, branchId } = req.body || {};
  const p = await getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM products WHERE id=$1', [p.id]);
  await pool.query('DELETE FROM stock WHERE product_id=$1', [p.id]);
  await logAudit({ branchId, employeeId: actorId, action: 'Delete product', details: `${p.name} (${p.sku}) removed from catalogue` });
  res.json({ ok: true });
}));

/* ---------------- STOCK ---------------- */
app.get('/api/stock', ah(async (req, res) => {
  const { branchId } = req.query;
  if (!branchId) return res.status(400).json({ error: 'branchId required.' });
  const { rows } = await pool.query('SELECT product_id, qty FROM stock WHERE branch_id=$1', [branchId]);
  const map = {};
  rows.forEach(r => { map[r.product_id] = r.qty; });
  res.json(map);
}));

/* ---------------- STOCK REQUESTS (add/confirm workflow) ---------------- */
app.get('/api/stock-requests', ah(async (req, res) => {
  const { branchId, all } = req.query;
  const { rows } = all === '1'
    ? await pool.query('SELECT * FROM stock_requests ORDER BY requested_at DESC LIMIT 200')
    : await pool.query('SELECT * FROM stock_requests WHERE branch_id=$1 ORDER BY requested_at DESC LIMIT 200', [branchId]);
  res.json(rows.map(r => ({
    id: r.id, branchId: r.branch_id, productId: r.product_id, qty: r.qty, type: r.type, reason: r.reason,
    requestedBy: r.requested_by, requestedAt: Number(r.requested_at), status: r.status,
    confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at ? Number(r.confirmed_at) : null
  })));
}));
app.post('/api/stock-requests', ah(async (req, res) => {
  const { branchId, productId, qty, type, reason, actorId } = req.body || {};
  if (!branchId || !productId || !qty || !type) return res.status(400).json({ error: 'Missing fields.' });
  const p = await getProduct(productId);
  const id = uid('req');
  await pool.query(
    `INSERT INTO stock_requests(id,branch_id,product_id,qty,type,reason,requested_by,requested_at,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [id, branchId, productId, qty, type, reason || '—', actorId, Date.now()]
  );
  await logAudit({ branchId, employeeId: actorId, action: 'Stock entry submitted', details: `${p ? p.name : productId}: ${type} ${qty} ${p ? p.unit : ''} — ${reason || '—'} (awaiting confirmation)` });
  res.json({ id, status: 'pending' });
}));
app.post('/api/stock-requests/:id/confirm', ah(async (req, res) => {
  const { actorId } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM stock_requests WHERE id=$1', [req.params.id]);
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Already resolved.' });
  if (r.requested_by === actorId) return res.status(403).json({ error: 'A different employee must confirm this entry.' });
  const p = await getProduct(r.product_id);
  const { rows: stockRows } = await pool.query('SELECT qty FROM stock WHERE branch_id=$1 AND product_id=$2', [r.branch_id, r.product_id]);
  const cur = stockRows[0];
  const before = cur ? cur.qty : 0;
  const after = r.type === 'add' ? before + r.qty : Math.max(0, before - r.qty);
  if (cur) await pool.query('UPDATE stock SET qty=$1 WHERE branch_id=$2 AND product_id=$3', [after, r.branch_id, r.product_id]);
  else await pool.query('INSERT INTO stock(branch_id,product_id,qty) VALUES ($1,$2,$3)', [r.branch_id, r.product_id, after]);
  await pool.query("UPDATE stock_requests SET status='confirmed', confirmed_by=$1, confirmed_at=$2 WHERE id=$3", [actorId, Date.now(), r.id]);
  await logAudit({ branchId: r.branch_id, employeeId: actorId, action: 'Stock confirmed', details: `${p.name}: ${before} → ${after} ${p.unit} (${r.type} ${r.qty})` });
  res.json({ ok: true, before, after });
}));
app.post('/api/stock-requests/:id/reject', ah(async (req, res) => {
  const { actorId } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM stock_requests WHERE id=$1', [req.params.id]);
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Already resolved.' });
  const isOwner = r.requested_by === actorId;
  const p = await getProduct(r.product_id);
  await pool.query("UPDATE stock_requests SET status='rejected', confirmed_by=$1, confirmed_at=$2 WHERE id=$3", [actorId, Date.now(), r.id]);
  await logAudit({ branchId: r.branch_id, employeeId: actorId, action: isOwner ? 'Stock entry cancelled' : 'Stock rejected', details: `${p.name}: ${r.type} ${r.qty} ${p.unit} ${isOwner ? 'cancelled by requester' : 'rejected'}` });
  res.json({ ok: true });
}));

/* ---------------- SALES / POS ---------------- */
app.post('/api/sales', ah(async (req, res) => {
  // items: [{productId, qty, price, isFreebie}]
  const { branchId, employeeId, items, discount, paymentMethod, amountReceived, currency } = req.body || {};
  if (!branchId || !employeeId || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing fields.' });

  for (const it of items) {
    const p = await getProduct(it.productId);
    if (p && p.is_service) continue; // services have no stock to check
    const { rows } = await pool.query('SELECT qty FROM stock WHERE branch_id=$1 AND product_id=$2', [branchId, it.productId]);
    const cur = rows[0];
    if (!cur || cur.qty < it.qty) return res.status(409).json({ error: 'Insufficient stock for one or more items.' });
  }
  const { rows: [seqRow] } = await pool.query('SELECT value FROM counters WHERE name=$1', ['receipt_seq']);
  const nextSeq = seqRow.value + 1;
  await pool.query('UPDATE counters SET value=$1 WHERE name=$2', [nextSeq, 'receipt_seq']);
  const seq = 'EBP-' + String(nextSeq).padStart(6, '0');

  // Safety net: freebie-only products (e.g. giveaway wig caps) can never be charged,
  // even if a client bug or tampered request tries to sell one at full price.
  for (const it of items) {
    const p = await getProduct(it.productId);
    if (p && p.is_freebie_only) it.isFreebie = true;
  }
  const disc = Number(discount) || 0;
  const subtotal = items.reduce((a, it) => a + (it.isFreebie ? 0 : it.price * it.qty), 0);
  const total = Math.max(0, subtotal - disc);
  const { rows: [fxRow] } = await pool.query('SELECT value FROM settings WHERE key=$1', ['fxRate']);
  const fxRate = fxRow ? Number(fxRow.value) : 0;
  const pay = paymentMethod || 'Cash';
  const received = amountReceived != null ? Number(amountReceived) : null;
  let changeDue = null;
  if (received != null) {
    const receivedInUsd = (currency && currency !== 'USD' && fxRate > 0) ? received / fxRate : received;
    changeDue = receivedInUsd - total;
  }

  const saleId = uid('sale');
  await pool.query(
    'INSERT INTO sales(id,seq,branch_id,employee_id,total,timestamp,discount,payment_method,amount_received,change_due,currency,fx_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [saleId, seq, branchId, employeeId, total, Date.now(), disc, pay, received, changeDue, currency || 'USD', fxRate]
  );
  for (const it of items) {
    await pool.query('INSERT INTO sale_items(sale_id,product_id,qty,price,is_freebie) VALUES ($1,$2,$3,$4,$5)',
      [saleId, it.productId, it.qty, it.isFreebie ? 0 : it.price, !!it.isFreebie]);
    const p = await getProduct(it.productId);
    if (!(p && p.is_service)) {
      await pool.query('UPDATE stock SET qty = qty - $1 WHERE branch_id=$2 AND product_id=$3', [it.qty, branchId, it.productId]);
    }
  }
  await logAudit({ branchId, employeeId, action: 'Sale', details: `${seq} — ${items.length} item line(s), $${total.toFixed(2)}${disc ? ` (discount $${disc.toFixed(2)})` : ''}, ${pay}` });
  res.json({ id: saleId, seq, total, subtotal, discount: disc, paymentMethod: pay, amountReceived: received, changeDue, currency: currency || 'USD', fxRate, timestamp: Date.now(), items });
}));
app.get('/api/sales', ah(async (req, res) => {
  const { branchId } = req.query;
  const { rows: sales } = branchId
    ? await pool.query('SELECT * FROM sales WHERE branch_id=$1 ORDER BY timestamp DESC LIMIT 300', [branchId])
    : await pool.query('SELECT * FROM sales ORDER BY timestamp DESC LIMIT 300');
  const out = [];
  for (const s of sales) {
    const { rows: items } = await pool.query('SELECT product_id, qty, price, is_freebie FROM sale_items WHERE sale_id=$1', [s.id]);
    out.push({
      id: s.id, seq: s.seq, branchId: s.branch_id, employeeId: s.employee_id, total: s.total, timestamp: Number(s.timestamp),
      discount: s.discount, paymentMethod: s.payment_method, amountReceived: s.amount_received, changeDue: s.change_due,
      currency: s.currency, fxRate: s.fx_rate,
      items: items.map(i => ({ productId: i.product_id, qty: i.qty, price: i.price, isFreebie: i.is_freebie }))
    });
  }
  res.json(out);
}));

/* ---------------- AUDIT LOG ---------------- */
app.get('/api/audit', ah(async (req, res) => {
  const { branchId, all } = req.query;
  const { rows } = all === '1'
    ? await pool.query('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 500')
    : await pool.query('SELECT * FROM audit_log WHERE branch_id=$1 ORDER BY timestamp DESC LIMIT 500', [branchId]);
  res.json(rows.map(a => ({ id: a.id, timestamp: Number(a.timestamp), branchId: a.branch_id, employeeId: a.employee_id, action: a.action, details: a.details })));
}));

app.get('/api/health', ah(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, time: Date.now() });
}));

// Downloads a full JSON export of every table — a portable backup that
// doesn't depend on Supabase or this server still existing.
app.get('/api/admin/backup', ah(async (req, res) => {
  const employee = await getEmployee(req.query.employeeId || '');
  if (!employee || employee.role !== 'Administrator') return res.status(403).json({ error: 'Administrator access required.' });
  const tables = ['branches', 'employees', 'products', 'stock', 'sales', 'sale_items', 'stock_requests', 'audit_log', 'counters', 'categories', 'returns', 'settings'];
  const dump = { exportedAt: new Date().toISOString() };
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${t}`);
    dump[t] = rows;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await logAudit({ branchId: req.query.branchId || 'ALL', employeeId: employee.id, action: 'Database backup downloaded', details: `Snapshot taken ${new Date().toLocaleString()}` });
  res.setHeader('Content-Disposition', `attachment; filename="esthers-backup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(dump, null, 2));
}));

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(ensureSeed)
  .then(() => {
    app.listen(PORT, () => console.log(`ESTHERS BEAUTY PARLOUR backend running on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to start:', e);
    process.exit(1);
  });
