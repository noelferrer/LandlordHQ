const db = require('./src/database');
const { v4: uuidv4 } = require('uuid');

const username = process.argv[2];
const telegramId = process.argv[3];
const name = process.argv[4] || 'Admin';

if (!username || !telegramId) {
    console.log('Usage: node add_admin.js <username> <telegramId> [name]');
    process.exit(1);
}

const cleanedUsername = username.replace('@', '');

// Check if admin exists
const existing = db.get('admins').find({ telegramId }).value();
if (existing) {
    console.log(`Admin already exists: ${existing.username} (${existing.telegramId})`);
    process.exit(0);
}

const newAdmin = {
    id: uuidv4(),
    username: cleanedUsername,
    telegramId: telegramId,
    name: name
};

db.get('admins').push(newAdmin).write();

console.log('✅ Admin added successfully:');
console.log(JSON.stringify(newAdmin, null, 2));
