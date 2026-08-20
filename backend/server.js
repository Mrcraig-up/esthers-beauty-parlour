// ESTHERS BEAUTY PARLOUR — Stock & Till backend
// Real server + SQLite database (file: esthers.db)
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// DB_PATH lets Render (or any host) point this at a persistent disk mount,
// e.g. /data/esthers.db, so the database survives redeploys.
// Locally, it just defaults to esthers.db next to this file.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'esthers.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ---------------- SCHEMA ---------------- */
db.exec(`
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
  price REAL NOT NULL, cost REAL NOT NULL, reorder_level REAL NOT NULL,
  is_service INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stock(
  branch_id TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(branch_id, product_id)
);
CREATE TABLE IF NOT EXISTS sales(
  id TEXT PRIMARY KEY, seq TEXT NOT NULL, branch_id TEXT NOT NULL, employee_id TEXT NOT NULL,
  total REAL NOT NULL, timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_requests(
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, product_id TEXT NOT NULL,
  qty REAL NOT NULL, type TEXT NOT NULL, reason TEXT,
  requested_by TEXT NOT NULL, requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  confirmed_by TEXT, confirmed_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log(
  id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, branch_id TEXT,
  employee_id TEXT, action TEXT NOT NULL, details TEXT
);
CREATE TABLE IF NOT EXISTS counters(
  name TEXT PRIMARY KEY, value INTEGER NOT NULL
);
`);

/* ---------------- MIGRATIONS (safe on existing DBs) ---------------- */
const productCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!productCols.includes('is_service')) {
  db.exec("ALTER TABLE products ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0");
}

/* ---------------- SEED (first run only) ---------------- */
const branchCount = db.prepare('SELECT COUNT(*) c FROM branches').get().c;
if (branchCount === 0) {
  const uid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
  const b1 = uid('br'), b2 = uid('br');
  const admin = uid('emp'), m1 = uid('emp'), c1 = uid('emp'), c2 = uid('emp');

  db.prepare('INSERT INTO branches(id,name,location) VALUES (?,?,?)').run(b1, 'Rotten Row', 'Rotten Row, Harare');
  db.prepare('INSERT INTO branches(id,name,location) VALUES (?,?,?)').run(b2, 'Robert Mugabe', 'Robert Mugabe Road, Harare');

  const insEmp = db.prepare('INSERT INTO employees(id,work_id,name,role,branch_id) VALUES (?,?,?,?,?)');
  insEmp.run(admin, 'ADM-001', 'System Administrator', 'Administrator', 'ALL');
  insEmp.run(m1, 'EBP-001', 'Branch Manager', 'Manager', b1);
  insEmp.run(c1, 'EBP-002', 'Cashier', 'Cashier', b1);
  insEmp.run(c2, 'EBP-003', 'Cashier', 'Cashier', b2);

  const insProd = db.prepare('INSERT INTO products(id,sku,name,category,unit,price,cost,reorder_level,is_service) VALUES (?,?,?,?,?,?,?,?,?)');
  const insStock = db.prepare('INSERT INTO stock(branch_id,product_id,qty) VALUES (?,?,?)');
  const seedProducts = [
    // [sku, name, category, unit, price, cost, reorderLevel, isService]
    ['HHW-001','Brazilian Straight Full Lace Wig 20in','Human Hair Wigs','piece',180.00,120.00,3,0],
    ['HHW-002','Peruvian Body Wave Wig 22in','Human Hair Wigs','piece',195.00,130.00,3,0],
    ['HHW-003','Malaysian Curly Wig 18in','Human Hair Wigs','piece',165.00,110.00,3,0],
    ['SYN-001','Synthetic Bob Wig','Synthetic Wigs','piece',35.00,20.00,8,0],
    ['SYN-002','Synthetic Long Wavy Wig','Synthetic Wigs','piece',42.00,25.00,8,0],
    ['LF-001','13x4 Lace Frontal Straight','Lace Frontals','piece',65.00,42.00,5,0],
    ['LF-002','13x4 Lace Frontal Curly','Lace Frontals','piece',70.00,45.00,5,0],
    ['CLO-001','4x4 Lace Closure Straight','Closures','piece',38.00,24.00,6,0],
    ['CLO-002','5x5 Lace Closure Body Wave','Closures','piece',42.00,27.00,6,0],
    ['BND-001','Brazilian Bundle 18in','Bundles','piece',48.00,30.00,10,0],
    ['BND-002','Peruvian Bundle 20in','Bundles','piece',55.00,35.00,10,0],
    ['BRD-001','Braiding Hair Jumbo Pack','Braiding Hair','pack',6.50,4.00,25,0],
    ['ACC-001','Wig Stand','Accessories','piece',5.00,2.80,12,0],
    ['ACC-002','Wig Cap','Accessories','piece',1.50,0.80,30,0],
    ['ACC-003','Edge Brush & Comb Set','Accessories','set',3.50,2.00,20,0],
    ['OIL-001','Wig & Scalp Growth Oil 100ml','Oils & Treatments','piece',8.50,5.50,15,0],
    ['OIL-002','Edge Control Gel 100ml','Oils & Treatments','piece',6.00,3.80,15,0],
    ['OIL-003','Wig Shampoo 250ml','Oils & Treatments','piece',8.00,5.00,15,0],
    ['INS-001','Wig Installation — Glue-Down','Installations','session',25.00,0,0,1],
    ['INS-002','Wig Installation — Sew-In','Installations','session',35.00,0,0,1],
    ['MNT-001','Wig Wash & Revamp','Maintenance','session',20.00,0,0,1],
    ['MNT-002','Wig Repair & Restyle','Maintenance','session',18.00,0,0,1],
  ];
  seedProducts.forEach(row => {
    const id = uid('prod');
    insProd.run(id, ...row);
    if (!row[7]) { // only track stock for physical products
      insStock.run(b1, id, Math.floor(Math.random()*15)+5);
      insStock.run(b2, id, Math.floor(Math.random()*10)+3);
    }
  });
  db.prepare('INSERT INTO counters(name,value) VALUES (?,?)').run('receipt_seq', 0);
  console.log('Database seeded.');
}
if (!db.prepare('SELECT 1 FROM counters WHERE name=?').get('receipt_seq')) {
  db.prepare('INSERT INTO counters(name,value) VALUES (?,?)').run('receipt_seq', 0);
}

/* ---------------- HELPERS ---------------- */
const uid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
function logAudit({branchId, employeeId, action, details}) {
  db.prepare('INSERT INTO audit_log(id,timestamp,branch_id,employee_id,action,details) VALUES (?,?,?,?,?,?)')
    .run(uid('aud'), Date.now(), branchId || null, employeeId || null, action, details || '');
}
function nextWorkId() {
  const rows = db.prepare('SELECT work_id FROM employees').all();
  let max = 0;
  rows.forEach(r => { const m = r.work_id.match(/(\d+)$/); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return 'EBP-' + String(max + 1).padStart(3, '0');
}

/* ---------------- AUTH ---------------- */
// Lightweight auth: Work ID + Name, both assigned by an Administrator/Manager.
app.post('/api/auth/login', (req, res) => {
  const { workId, name } = req.body || {};
  if (!workId || !name) return res.status(400).json({ error: 'Work ID and Name are required.' });
  const emp = db.prepare('SELECT * FROM employees WHERE LOWER(work_id)=LOWER(?) AND LOWER(name)=LOWER(?)').get(workId.trim(), name.trim());
  if (!emp) return res.status(401).json({ error: "Work ID and Name don't match our records." });
  logAudit({ branchId: emp.branch_id === 'ALL' ? null : emp.branch_id, employeeId: emp.id, action: 'Log in', details: `${emp.name} (${emp.work_id}) logged in` });
  res.json({ employee: toEmpDTO(emp) });
});
app.post('/api/auth/logout', (req, res) => {
  const { employeeId, branchId } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId);
  if (emp) logAudit({ branchId, employeeId, action: 'Log out', details: `${emp.name} (${emp.work_id}) logged out` });
  res.json({ ok: true });
});
function toEmpDTO(e){ return { id: e.id, workId: e.work_id, name: e.name, role: e.role, branchId: e.branch_id }; }

/* ---------------- BRANCHES ---------------- */
app.get('/api/branches', (req, res) => {
  res.json(db.prepare('SELECT * FROM branches').all().map(b => ({ id: b.id, name: b.name, location: b.location })));
});
app.post('/api/branches', (req, res) => {
  const { name, location, actorId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Branch name is required.' });
  const actor = db.prepare('SELECT * FROM employees WHERE id=?').get(actorId);
  if (!actor || actor.role !== 'Administrator') return res.status(403).json({ error: 'Only the Administrator can add branches.' });
  const id = uid('br');
  db.prepare('INSERT INTO branches(id,name,location) VALUES (?,?,?)').run(id, name, location || '');
  const products = db.prepare('SELECT id FROM products WHERE is_service=0').all();
  const insStock = db.prepare('INSERT INTO stock(branch_id,product_id,qty) VALUES (?,?,0)');
  products.forEach(p => insStock.run(id, p.id));
  logAudit({ branchId: id, employeeId: actorId, action: 'Add branch', details: `${name} (${location || '—'}) added` });
  res.json({ id, name, location });
});

/* ---------------- EMPLOYEES ---------------- */
app.get('/api/employees', (req, res) => {
  res.json(db.prepare('SELECT * FROM employees').all().map(toEmpDTO));
});
app.post('/api/employees', (req, res) => {
  const { name, workId, role, branchId, actorId } = req.body || {};
  const actor = db.prepare('SELECT * FROM employees WHERE id=?').get(actorId);
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
  const exists = db.prepare('SELECT 1 FROM employees WHERE LOWER(work_id)=LOWER(?)').get(workId);
  if (exists) return res.status(409).json({ error: 'That Work ID is already assigned to another employee.' });
  const id = uid('emp');
  db.prepare('INSERT INTO employees(id,work_id,name,role,branch_id) VALUES (?,?,?,?,?)').run(id, workId, name, role, branchId);
  logAudit({ branchId, employeeId: actorId, action: 'Add employee', details: `${name} (${workId}, ${role}) added` });
  res.json(toEmpDTO({ id, work_id: workId, name, role, branch_id: branchId }));
});
app.get('/api/employees/next-work-id', (req, res) => res.json({ workId: nextWorkId() }));
app.delete('/api/employees/:id', (req, res) => {
  const { actorId } = req.body || {};
  const actor = db.prepare('SELECT * FROM employees WHERE id=?').get(actorId);
  const target = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!actor || !target) return res.status(404).json({ error: 'Not found.' });
  if (actor.role !== 'Administrator' && actor.role !== 'Manager') return res.status(403).json({ error: 'Not permitted.' });
  if (target.role === 'Administrator') return res.status(403).json({ error: 'Cannot remove an Administrator.' });
  if (target.id === actor.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
  db.prepare('DELETE FROM employees WHERE id=?').run(target.id);
  logAudit({ branchId: target.branch_id, employeeId: actorId, action: 'Remove employee', details: `${target.name} (${target.work_id}) removed` });
  res.json({ ok: true });
});

/* ---------------- PRODUCTS ---------------- */
app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products').all().map(p => ({
    id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit,
    price: p.price, cost: p.cost, reorderLevel: p.reorder_level, isService: !!p.is_service
  })));
});
app.post('/api/products', (req, res) => {
  const { sku, name, category, unit, price, cost, reorderLevel, openingStock, isService, branchId, actorId } = req.body || {};
  if (!sku || !name || !category || !unit) return res.status(400).json({ error: 'Missing fields.' });
  const exists = db.prepare('SELECT 1 FROM products WHERE LOWER(sku)=LOWER(?)').get(sku);
  if (exists) return res.status(409).json({ error: 'That SKU already exists.' });
  const id = uid('prod');
  const svc = isService ? 1 : 0;
  db.prepare('INSERT INTO products(id,sku,name,category,unit,price,cost,reorder_level,is_service) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, sku, name, category, unit, price || 0, svc ? 0 : (cost || 0), svc ? 0 : (reorderLevel || 0), svc);
  if (!svc) {
    const branches = db.prepare('SELECT id FROM branches').all();
    const insStock = db.prepare('INSERT INTO stock(branch_id,product_id,qty) VALUES (?,?,?)');
    branches.forEach(b => insStock.run(b.id, id, b.id === branchId ? (openingStock || 0) : 0));
  }
  logAudit({ branchId, employeeId: actorId, action: svc ? 'Add service' : 'Add product', details: `${name} (${sku}) added${svc ? '' : `, opening stock ${openingStock || 0} ${unit}`}` });
  res.json({ id, sku, name, category, unit, price, cost, reorderLevel, isService: !!svc });
});
app.put('/api/products/:id', (req, res) => {
  const { sku, name, category, unit, price, cost, reorderLevel, isService, actorId, branchId } = req.body || {};
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const svc = isService ? 1 : 0;
  db.prepare('UPDATE products SET sku=?,name=?,category=?,unit=?,price=?,cost=?,reorder_level=?,is_service=? WHERE id=?')
    .run(sku, name, category, unit, price, svc ? 0 : cost, svc ? 0 : reorderLevel, svc, p.id);
  logAudit({ branchId, employeeId: actorId, action: 'Edit product', details: `${name} (${sku}) updated` });
  res.json({ ok: true });
});
app.delete('/api/products/:id', (req, res) => {
  const { actorId, branchId } = req.body || {};
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  db.prepare('DELETE FROM stock WHERE product_id=?').run(p.id);
  logAudit({ branchId, employeeId: actorId, action: 'Delete product', details: `${p.name} (${p.sku}) removed from catalogue` });
  res.json({ ok: true });
});

/* ---------------- STOCK ---------------- */
app.get('/api/stock', (req, res) => {
  const { branchId } = req.query;
  if (!branchId) return res.status(400).json({ error: 'branchId required.' });
  const rows = db.prepare('SELECT product_id, qty FROM stock WHERE branch_id=?').all(branchId);
  const map = {};
  rows.forEach(r => { map[r.product_id] = r.qty; });
  res.json(map);
});

/* ---------------- STOCK REQUESTS (add/confirm workflow) ---------------- */
app.get('/api/stock-requests', (req, res) => {
  const { branchId, all } = req.query;
  const rows = all === '1'
    ? db.prepare('SELECT * FROM stock_requests ORDER BY requested_at DESC LIMIT 200').all()
    : db.prepare('SELECT * FROM stock_requests WHERE branch_id=? ORDER BY requested_at DESC LIMIT 200').all(branchId);
  res.json(rows.map(r => ({
    id: r.id, branchId: r.branch_id, productId: r.product_id, qty: r.qty, type: r.type, reason: r.reason,
    requestedBy: r.requested_by, requestedAt: r.requested_at, status: r.status,
    confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at
  })));
});
app.post('/api/stock-requests', (req, res) => {
  const { branchId, productId, qty, type, reason, actorId } = req.body || {};
  if (!branchId || !productId || !qty || !type) return res.status(400).json({ error: 'Missing fields.' });
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  const id = uid('req');
  db.prepare(`INSERT INTO stock_requests(id,branch_id,product_id,qty,type,reason,requested_by,requested_at,status)
              VALUES (?,?,?,?,?,?,?,?,'pending')`).run(id, branchId, productId, qty, type, reason || '—', actorId, Date.now());
  logAudit({ branchId, employeeId: actorId, action: 'Stock entry submitted', details: `${p ? p.name : productId}: ${type} ${qty} ${p ? p.unit : ''} — ${reason || '—'} (awaiting confirmation)` });
  res.json({ id, status: 'pending' });
});
app.post('/api/stock-requests/:id/confirm', (req, res) => {
  const { actorId } = req.body || {};
  const r = db.prepare('SELECT * FROM stock_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Already resolved.' });
  if (r.requested_by === actorId) return res.status(403).json({ error: 'A different employee must confirm this entry.' });
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
  const cur = db.prepare('SELECT qty FROM stock WHERE branch_id=? AND product_id=?').get(r.branch_id, r.product_id);
  const before = cur ? cur.qty : 0;
  const after = r.type === 'add' ? before + r.qty : Math.max(0, before - r.qty);
  if (cur) db.prepare('UPDATE stock SET qty=? WHERE branch_id=? AND product_id=?').run(after, r.branch_id, r.product_id);
  else db.prepare('INSERT INTO stock(branch_id,product_id,qty) VALUES (?,?,?)').run(r.branch_id, r.product_id, after);
  db.prepare("UPDATE stock_requests SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=?").run(actorId, Date.now(), r.id);
  logAudit({ branchId: r.branch_id, employeeId: actorId, action: 'Stock confirmed', details: `${p.name}: ${before} → ${after} ${p.unit} (${r.type} ${r.qty})` });
  res.json({ ok: true, before, after });
});
app.post('/api/stock-requests/:id/reject', (req, res) => {
  const { actorId } = req.body || {};
  const r = db.prepare('SELECT * FROM stock_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Already resolved.' });
  const isOwner = r.requested_by === actorId;
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
  db.prepare("UPDATE stock_requests SET status='rejected', confirmed_by=?, confirmed_at=? WHERE id=?").run(actorId, Date.now(), r.id);
  logAudit({ branchId: r.branch_id, employeeId: actorId, action: isOwner ? 'Stock entry cancelled' : 'Stock rejected', details: `${p.name}: ${r.type} ${r.qty} ${p.unit} ${isOwner ? 'cancelled by requester' : 'rejected'}` });
  res.json({ ok: true });
});

/* ---------------- SALES / POS ---------------- */
app.post('/api/sales', (req, res) => {
  const { branchId, employeeId, items } = req.body || {}; // items: [{productId, qty, price}]
  if (!branchId || !employeeId || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing fields.' });

  for (const it of items) {
    const p = db.prepare('SELECT is_service FROM products WHERE id=?').get(it.productId);
    if (p && p.is_service) continue; // services have no stock to check
    const cur = db.prepare('SELECT qty FROM stock WHERE branch_id=? AND product_id=?').get(branchId, it.productId);
    if (!cur || cur.qty < it.qty) return res.status(409).json({ error: 'Insufficient stock for one or more items.' });
  }
  const seqRow = db.prepare('SELECT value FROM counters WHERE name=?').get('receipt_seq');
  const nextSeq = seqRow.value + 1;
  db.prepare('UPDATE counters SET value=? WHERE name=?').run(nextSeq, 'receipt_seq');
  const seq = 'EBP-' + String(nextSeq).padStart(6, '0');

  const saleId = uid('sale');
  const total = items.reduce((a, it) => a + it.price * it.qty, 0);
  db.prepare('INSERT INTO sales(id,seq,branch_id,employee_id,total,timestamp) VALUES (?,?,?,?,?,?)')
    .run(saleId, seq, branchId, employeeId, total, Date.now());
  const insItem = db.prepare('INSERT INTO sale_items(sale_id,product_id,qty,price) VALUES (?,?,?,?)');
  items.forEach(it => {
    insItem.run(saleId, it.productId, it.qty, it.price);
    const p = db.prepare('SELECT is_service FROM products WHERE id=?').get(it.productId);
    if (!(p && p.is_service)) {
      db.prepare('UPDATE stock SET qty = qty - ? WHERE branch_id=? AND product_id=?').run(it.qty, branchId, it.productId);
    }
  });
  logAudit({ branchId, employeeId, action: 'Sale', details: `${seq} — ${items.length} item line(s), $${total.toFixed(2)}` });
  res.json({ id: saleId, seq, total, timestamp: Date.now(), items });
});
app.get('/api/sales', (req, res) => {
  const { branchId } = req.query;
  const sales = branchId
    ? db.prepare('SELECT * FROM sales WHERE branch_id=? ORDER BY timestamp DESC LIMIT 300').all(branchId)
    : db.prepare('SELECT * FROM sales ORDER BY timestamp DESC LIMIT 300').all();
  const getItems = db.prepare('SELECT product_id, qty, price FROM sale_items WHERE sale_id=?');
  res.json(sales.map(s => ({
    id: s.id, seq: s.seq, branchId: s.branch_id, employeeId: s.employee_id, total: s.total, timestamp: s.timestamp,
    items: getItems.all(s.id).map(i => ({ productId: i.product_id, qty: i.qty, price: i.price }))
  })));
});

/* ---------------- AUDIT LOG ---------------- */
app.get('/api/audit', (req, res) => {
  const { branchId, all } = req.query;
  const rows = all === '1'
    ? db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM audit_log WHERE branch_id=? ORDER BY timestamp DESC LIMIT 500').all(branchId);
  res.json(rows.map(a => ({ id: a.id, timestamp: a.timestamp, branchId: a.branch_id, employeeId: a.employee_id, action: a.action, details: a.details })));
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Downloads a safe, consistent point-in-time copy of the live database.
// Uses better-sqlite3's .backup() (not a raw file copy) so it can't grab
// a half-written WAL state while the till is in use.
app.get('/api/admin/backup', async (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id=?').get(req.query.employeeId || '');
  if (!employee || employee.role !== 'Administrator') return res.status(403).json({ error: 'Administrator access required.' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpPath = path.join(os.tmpdir(), `esthers-backup-${stamp}.db`);
  try {
    await db.backup(tmpPath);
    logAudit({ branchId: req.query.branchId || 'ALL', employeeId: employee.id, action: 'Database backup downloaded', details: `Snapshot taken ${new Date().toLocaleString()}` });
    res.download(tmpPath, `esthers-backup-${stamp}.db`, () => fs.unlink(tmpPath, () => {}));
  } catch(e) {
    fs.unlink(tmpPath, () => {});
    res.status(500).json({ error: 'Backup failed.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ESTHERS BEAUTY PARLOUR backend running on http://localhost:${PORT}`));
