const bot = require('./bot');
const db = require('./database');

async function runTest() {
    console.log('🧪 Starting Bot Simulation Test (Admin & Tenant Context)...');

    const adminChatId = 618340961; // from .env OWNER_TELEGRAM_ID
    const normalChatId = 999111222;
    
    // Test helper to simulate update and check result
    const simulateMessage = async (chatId, text, isCommand = false, photoId = null) => {
        const update = {
            update_id: Math.floor(Math.random() * 100000),
            message: {
                message_id: Math.floor(Math.random() * 100000),
                from: { id: chatId, first_name: 'Tester', is_bot: false },
                chat: { id: chatId, type: 'private' },
                date: Math.floor(Date.now() / 1000)
            }
        };
        if (photoId) {
            update.message.photo = [{ file_id: photoId, width: 100, height: 100 }];
            if (text) update.message.caption = text;
        } else {
            update.message.text = text;
        }
        if (isCommand) {
            update.message.entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];
        }
        await bot.handleUpdate(update);
    };

    // 1. Admin Link Test
    console.log('\n--- Test 1: Admin manually linking a unit ---');
    // Ensure the tenant for code BOB202 exists and has no telegramId
    db.read();
    db.get('tenants').find({ linkCode: 'BOB202' }).assign({ telegramId: null }).write();
    
    await simulateMessage(adminChatId, '/link BOB202', true);
    
    db.read();
    const bob = db.get('tenants').find({ linkCode: 'BOB202' }).value();
    if (bob && bob.telegramId === String(adminChatId)) {
        console.log('✅ Admin linked to BOB202');
    } else {
        console.log('❌ Admin failed to link to BOB202');
    }

    // 2. Admin Report Test (The one that failed in screenshot)
    console.log('\n--- Test 2: Admin sending /report ---');
    await simulateMessage(adminChatId, '/report faucet broken', true);
    
    db.read();
    const ticket = db.get('tickets').find({ unit: bob.unit, issue: 'faucet broken' }).value();
    if (ticket) {
        console.log(`✅ Admin report successful (Ticket #${ticket.id})`);
    } else {
        console.log('❌ Admin report failed: Tenant context likely missing.');
    }

    // 3. Admin Photo Test
    console.log('\n--- Test 3: Admin sending photo receipt ---');
    await simulateMessage(adminChatId, '/payment', false, 'admin_photo_123');
    
    db.read();
    const payment = db.get('payments').find({ unit: bob.unit, fileId: 'admin_photo_123' }).value();
    if (payment) {
        console.log(`✅ Admin photo logged (Status: ${payment.status})`);
    } else {
        console.log('❌ Admin photo failed: Tenant context likely missing.');
    }

    // 4. Normal User Auto-link Test
    console.log('\n--- Test 4: Normal User Auto-linking ---');
    await simulateMessage(normalChatId, '/start', true);
    db.read();
    const guest = db.get('tenants').find({ telegramId: String(normalChatId) }).value();
    if (guest && guest.unit.startsWith('DEMO-')) {
        console.log(`✅ Guest auto-linked to ${guest.unit}`);
    } else {
        console.log('❌ Guest failed to auto-link');
    }

    console.log('\n✨ Simulation Complete.');
    process.exit(0);
}

runTest().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
