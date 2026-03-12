const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const dbPath = process.env.DB_FILE || path.join(__dirname, '../data/db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

// Set some defaults (required if your JSON file is empty)
db.defaults({
    admins: [], // Array of { id, username, telegramId, name }
    sessions: [], // Array of { token, adminId, expiresAt }
    otps: [], // Array of { telegramId, code, expiresAt }
    properties: [], // Array of { id, adminId, ... }
    units: [],
    tenants: [], // Array of { id, adminId, ... }
    tickets: [], // Array of { id, adminId, ... }
    payments: [], // Array of { id, adminId, unit, tenantName, amount, method, status, timestamp, type: 'manual'|'receipt' }
    expenses: [], // Array of { id, adminId, category, amount, description, timestamp }
    rules: [
        { id: 1, category: "General", rule: "Swimming pool is open from 6:00 AM to 10:00 PM." },
        { id: 2, category: "General", rule: "Visitors must register at the lobby/reception." },
        { id: 3, category: "Trash", rule: "Garbage collection is daily from 7:00 PM to 9:00 PM." },
        { id: 4, category: "Move-in/Out", rule: "Move-in/out requires a 3-day prior notice and clearance form." }
    ],
    settings: [], // Array of { adminId, rent_reminder_days_before, currency, fixer_id, start_text, rules_text, clearance_text }
}).write();

// Migration script block: if settings is still an object (from previous schema), convert it to an array
// (Logic moved to server.js for safe mapping to root admin)
const currentSettings = db.get('settings').value();
if (currentSettings && !Array.isArray(currentSettings)) {
    console.log("⚠️ Settings object detected. server.js will handle migration.");
}


module.exports = db;
