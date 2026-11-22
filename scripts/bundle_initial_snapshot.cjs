const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputFile = path.join(__dirname, '../public/initial_snapshot.json');

const files = [
  'contracts.json',
  'payments.json',
  'appointments.json',
  'cash_funds.json',
  'customer_lists.json',
  'employees.json',
  'inventory_items.json',
  'reps.json'
];

const snapshot = {};

for (const f of files) {
  const filePath = path.join(dataDir, f);
  const key = f.replace('.json', '');
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      snapshot[key] = JSON.parse(content);
    } catch (e) {
      snapshot[key] = [];
    }
  } else {
    snapshot[key] = [];
  }
}

fs.writeFileSync(outputFile, JSON.stringify(snapshot, null, 2), 'utf8');
console.log('[Snapshot Bundler] Successfully bundled initial snapshot.');
