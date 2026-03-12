require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./database');
const { setupReminders } = require('./scheduler');
const { v4: uuidv4 } = require('uuid');

console.log("Loading bot.js...");

const token = process.env.TELEGRAM_BOT_TOKEN;

// Validate token format (bot_id:secret)
if (token && !token.includes(':')) {
    console.error('❌ ERROR: Invalid TELEGRAM_BOT_TOKEN format in .env file.');
    console.error('A valid token should look like: 123456789:ABCDefghIJKLmnopQRSTuvwxyz');
    process.exit(1);
}

const bot = new Telegraf(token);

// Fetch fallback owner ID for legacy support during migration
const fallbackOwnerId = process.env.OWNER_TELEGRAM_ID ? parseInt(process.env.OWNER_TELEGRAM_ID) : null;

// Middleware to check if the user is an admin
const getAdmin = (ctx) => {
    db.read(); // Ensure we have latest data
    return db.get('admins').find({ telegramId: ctx.from.id.toString() }).value() 
           || (fallbackOwnerId && ctx.from.id === fallbackOwnerId ? { telegramId: fallbackOwnerId.toString(), id: 'legacy' } : null);
};

const getSettings = (ctx) => {
    db.read();
    let adminId = null;
    
    // 1. Check if it's an admin context
    if (ctx.admin && ctx.admin.id) {
        adminId = ctx.admin.id;
    } 
    // 2. Check if it's a tenant context
    else if (ctx.tenant && ctx.tenant.adminId) {
        adminId = ctx.tenant.adminId;
    }
    // 3. Fallback: Lookup admin by telegramId or use demo_admin
    else {
        const admin = getAdmin(ctx);
        if (admin) {
            adminId = admin.id;
        } else {
            const demoAdmin = db.get('admins').find({ username: 'demo_admin' }).value();
            adminId = demoAdmin ? demoAdmin.id : 'demo-admin-uuid';
        }
    }

    const settings = db.get('settings').find({ adminId }).value() || {};
    return settings;
};

const isAdmin = (ctx, next) => {
    const admin = getAdmin(ctx);
    if (admin) {
        ctx.admin = admin; // Attach admin context
        return next();
    }
    return ctx.reply("❌ Unauthorized. This command is for Unit Owners only.");
};

// --- DEMO AUTO-LINK MIDDLEWARE ---
// If the user is NOT an admin and NOT a registered tenant, link them to a Demo Unit
bot.use(async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    if (ctx.from.is_bot) return next();

    const telegramId = ctx.from.id.toString();
    
    // Ensure we have the latest data from the file (concurrency protection)
    db.read();
    
    // Check if it's an admin
    const admin = getAdmin(ctx);
    if (admin) {
        ctx.admin = admin; 
        // We continue to check if this admin is also linked as a tenant
    }

    // Check for existing link
    let tenant = db.get('tenants').find({ telegramId }).value();
    
    if (!tenant && !admin) {
        // Auto-link context: Only for non-admins to avoid polluting admin accounts with demo garbage
        // unless they explicitly /link later.
        const demoAdmin = db.get('admins').find({ username: 'demo_admin' }).value() || { id: 'demo-admin-uuid' };
        const firstProp = db.get('properties').find({ adminId: demoAdmin.id }).value();
        
        const newDemoTenant = {
            id: uuidv4(),
            unit: `DEMO-${Math.floor(100 + Math.random() * 900)}`,
            name: `${ctx.from.first_name || 'Guest'} (Demo)`,
            telegramId,
            adminId: demoAdmin.id,
            propertyId: firstProp ? firstProp.id : 'demo-prop-id',
            linkCode: 'DEMO',
            leaseAmount: 5000,
            rent_due_day: 1,
            status: 'Active'
        };

        db.get('tenants').push(newDemoTenant).write();
        console.log(`✨ Silent Auto-linked Demo User: ${newDemoTenant.name} as ${newDemoTenant.unit}`);
        tenant = newDemoTenant;
    }

    ctx.tenant = tenant; // Attach for handlers (/report, /payment, etc.)
    return next();
});

// --- Landlord Claiming Command ---
bot.command('claim', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return ctx.reply("Usage: /claim <username>");

    const username = args[0].toLowerCase();
    
    // Find the dormant admin
    const admin = db.get('admins').find({ username }).value();
    
    if (!admin) {
        return ctx.reply(`❌ Registration not found for username: ${username}`);
    }
    
    if (admin.telegramId) {
        return ctx.reply(`⚠️ This account has already been claimed.`);
    }

    // Securely attach this telegram ID to the admin account
    db.get('admins')
      .find({ username })
      .assign({ telegramId: ctx.from.id.toString() })
      .write();

    ctx.reply(`✅ **Account Activated!**\n\nWelcome, ${admin.name}. Your LandlordHQ account is now linked to this Telegram profile.\n\nYou can now log in to the dashboard using your username: \`${username}\``, { parse_mode: 'Markdown' });
});

// --- Tenant Commands ---

bot.start((ctx) => {
    const settings = getSettings(ctx);
    const startText = settings.start_text || "Welcome to Landlord HQ. Enter /help for more commands.";
    ctx.reply(startText);
});

bot.help((ctx) => {
    const helpCommands = `🏢 **Landlord HQ Commands:**\n\n` + 
        `• **/start** - Show the welcome message.\n` +
        `• **/help** - Show this list of commands.\n` +
        `• **/rules** - View the Condo House Rules.\n` +
        `• **/clearance** - View the Move-out Clearance process.\n` +
        `• **/report <issue>** - Submit a maintenance ticket (e.g. \`/report Leaking pipe\`).\n` +
        `• **/payment** - Attach a Photo/Video receipt to log a payment.\n\n` +
        `💡 **Tip:** When sending a Photo/Video, use \`/report <issue>\` or \`/payment\` in the caption to classify it correctly.`;
    ctx.replyWithMarkdown(helpCommands);
});

bot.command('link', (ctx) => {
    const text = ctx.message.text.split(' ');
    if (text.length < 2) return ctx.reply("Usage: /link <LinkCode>\nAsk your landlord for your unique 6-character link code.");

    const code = text[1].toUpperCase();

    db.read();
    const existing = db.get('tenants').find({ linkCode: code }).value();

    if (existing) {
        if (existing.telegramId && String(existing.telegramId) === String(ctx.from.id)) {
            return ctx.reply(`✅ You are already linked to **Unit ${existing.unit}**!`);
        }
        if (existing.telegramId) {
            return ctx.reply("❌ This link code has already been used by another account. Please ask your landlord for a new one.");
        }

        // --- IMPROVEMENT: Check if user is already linked elsewhere ---
        const alreadyLinked = db.get('tenants').find({ telegramId: ctx.from.id.toString() }).value();
        if (alreadyLinked) {
            return ctx.reply(`❌ You are already linked to **Unit ${alreadyLinked.unit}**. Please /unlink first if you wish to change units.`);
        }

        const telegramId = ctx.from.id.toString();

        db.read();
        db.get('tenants').find({ linkCode: code, adminId: existing.adminId }).assign({ telegramId }).write();
        console.log(`🔗 Linked User ${telegramId} to Unit ${existing.unit}`);
        ctx.reply(`✅ Success! You are now securely registered as the tenant for **Unit ${existing.unit}**. You will receive automated rent reminders here.`);
    } else {
        ctx.reply("❌ Invalid Link Code. Please check the code and try again.");
    }
});

bot.command('unlink', (ctx) => {
    const telegramId = ctx.from.id.toString();
    db.read();
    const tenant = db.get('tenants').find({ telegramId }).value();

    if (!tenant) {
        return ctx.reply("❌ You are not currently linked to any unit.");
    }

    // Unlink the tenant
    db.get('tenants').find({ telegramId }).assign({ telegramId: null }).write();
    console.log(`📴 Unlinked User ${telegramId} from Unit ${tenant.unit}`);
    ctx.reply(`📴 You have been unlinked from **Unit ${tenant.unit}**. You will no longer receive reminders for this unit.`);
});

bot.command('rules', (ctx) => {
    const settings = getSettings(ctx);
    const rulesText = settings.rules_text || "📝 **Condo House Rules:**\n\n1. No loud music after 10PM.\n2. Keep common areas clean.";
    ctx.replyWithMarkdown(rulesText);
});
bot.command('report', (ctx) => {
    const issue = ctx.message.text.split(' ').slice(1).join(' ');
    if (!issue) return ctx.reply("Usage: /report <Describe your issue here>\n\n💡 Tip: You can also send a photo or video with the caption 'report: your issue' to attach evidence!");

    const tenant = ctx.tenant;
    if (!tenant) return ctx.reply("❌ You must be /register-ed to report an issue.");

    const ticket = {
        id: uuidv4(),
        adminId: tenant.adminId,
        unit: tenant.unit,
        tenantName: tenant.name,
        issue,
        media: [],
        status: 'open',
        timestamp: new Date().toISOString()
    };

    db.get('tickets').push(ticket).write();

    ctx.reply(`✅ Issue reported! Your ticket ID is **#${ticket.id}**. The Landlord has been notified.\n\n💡 You can send photos/videos to add evidence to your report.`);

    // Route to the specific landlord
    const admin = db.get('admins').find({ id: tenant.adminId }).value() || { telegramId: fallbackOwnerId };
    if (admin && admin.telegramId) {
        bot.telegram.sendMessage(admin.telegramId, `🚨 **New Tenant Concern:**\n\nUnit ${tenant.unit}: ${issue}\n(Ticket #${ticket.id})`);
    }
});

bot.command('payment', (ctx) => {
    ctx.reply("💰 **Payment Submission:**\n\nPlease send a Photo or Video of your receipt/transaction as an attachment and use `/payment` in the caption.");
});

bot.command('clearance', (ctx) => {
    const settings = getSettings(ctx);
    const clearanceText = settings.clearance_text || "📦 **Move-out Clearance Process:**\n\n1. Settle all outstanding utility bills.\n2. Submit the Clearance Form to the Admin office.\n3. Send a photo of the signed form here for verification.";
    ctx.replyWithMarkdown(clearanceText);
});

// --- Smart Media Handler (Photos) ---
// Routes photos based on caption:
//   - Caption starts with "report:" → creates a ticket with media
//   - Caption starts with "receipt" or no caption → treated as payment receipt
bot.on('photo', async (ctx) => {
    db.read();
    const tenant = ctx.tenant;

    if (!tenant) {
        return ctx.reply("❌ You must be /register-ed to send media.");
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    const caption = (ctx.message.caption || '').trim().toLowerCase();
    
    const admin = db.get('admins').find({ id: tenant.adminId }).value() || { telegramId: fallbackOwnerId };

    // Route: Maintenance Report
    if (caption.startsWith('/report')) {
        const issue = ctx.message.caption.substring(7).trim() || 'Photo evidence submitted';

        const ticket = {
            id: uuidv4(),
            adminId: tenant.adminId,
            unit: tenant.unit,
            tenantName: tenant.name,
            issue,
            media: [{ type: 'photo', fileId }],
            status: 'open',
            timestamp: new Date().toISOString()
        };

        db.get('tickets').push(ticket).write();

        ctx.reply(`✅ Issue reported with photo evidence!\n\nTicket **#${ticket.id}** created for Unit ${tenant.unit}.`);

        if (admin && admin.telegramId) {
            bot.telegram.sendMessage(admin.telegramId, `🚨 **New Concern with Photo:**\n\nUnit ${tenant.unit}: ${issue}\n(Ticket #${ticket.id})`);
            bot.telegram.sendPhoto(admin.telegramId, fileId, { caption: `📸 Evidence from Unit ${tenant.unit} - ${tenant.name}` });
        }
        return;
    }

    // Route: Payment receipt (Default for everything else)
    const payment = {
        id: uuidv4(),
        adminId: tenant.adminId,
        unit: tenant.unit,
        tenantName: tenant.name,
        fileId: fileId,
        mediaType: 'photo',
        status: 'pending',
        timestamp: new Date().toISOString()
    };

    db.get('payments').push(payment).write();
    console.log(`💰 Payment receipt received from Unit ${tenant.unit} (${tenant.name})`);
    ctx.reply(`✅ **Receipt Received!**\n\nThe Landlord has been notified. We will verify your payment for Unit ${tenant.unit} shortly.`);

    if (admin && admin.telegramId) {
        bot.telegram.sendMessage(admin.telegramId, `💰 **New Payment Proof:**\n\nUnit ${tenant.unit} has submitted a receipt for verification.`);
        bot.telegram.sendPhoto(admin.telegramId, fileId, { caption: `Receipt from Unit ${tenant.unit} (${tenant.name})` });
    }
});

// --- Smart Media Handler (Videos) ---
bot.on('video', async (ctx) => {
    db.read();
    const tenant = ctx.tenant;

    if (!tenant) {
        return ctx.reply("❌ You must be /register-ed to send media.");
    }

    const fileId = ctx.message.video.file_id;
    const caption = (ctx.message.caption || '').trim().toLowerCase();
    
    const admin = db.get('admins').find({ id: tenant.adminId }).value() || { telegramId: fallbackOwnerId };

    // Route: Maintenance Report
    if (caption.startsWith('/report')) {
        const issue = ctx.message.caption.substring(7).trim() || 'Video evidence submitted';

        const ticket = {
            id: uuidv4(),
            adminId: tenant.adminId,
            unit: tenant.unit,
            tenantName: tenant.name,
            issue,
            media: [{ type: 'video', fileId }],
            status: 'open',
            timestamp: new Date().toISOString()
        };

        db.get('tickets').push(ticket).write();

        ctx.reply(`✅ Issue reported with video evidence!\n\nTicket **#${ticket.id}** created for Unit ${tenant.unit}.`);

        if (admin && admin.telegramId) {
            bot.telegram.sendMessage(admin.telegramId, `🚨 **New Concern with Video:**\n\nUnit ${tenant.unit}: ${issue}\n(Ticket #${ticket.id})`);
            bot.telegram.sendVideo(admin.telegramId, fileId, { caption: `🎥 Evidence from Unit ${tenant.unit} - ${tenant.name}` });
        }
        return;
    }

    // Route: Payment receipt (Default for everything else)
    const payment = {
        id: uuidv4(),
        adminId: tenant.adminId,
        unit: tenant.unit,
        tenantName: tenant.name,
        fileId: fileId,
        mediaType: 'video',
        status: 'pending',
        timestamp: new Date().toISOString()
    };

    db.get('payments').push(payment).write();
    console.log(`🎥 Video receipt received from Unit ${tenant.unit} (${tenant.name})`);
    ctx.reply(`✅ **Receipt (Video) Received!**\n\nThe Landlord has been notified. We will verify your payment for Unit ${tenant.unit} shortly.`);

    if (admin && admin.telegramId) {
        bot.telegram.sendMessage(admin.telegramId, `💰 **New Payment Proof (Video):**\n\nUnit ${tenant.unit} has submitted a video receipt.`);
        bot.telegram.sendVideo(admin.telegramId, fileId, { caption: `Receipt from Unit ${tenant.unit} (${tenant.name})` });
    }
});

// --- Owner/Admin Commands ---

bot.command('addtenant', isAdmin, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply("Usage: /addtenant <UnitNumber> <TenantName> [DueDay]");

    const unit = args[0];
    const name = args[1];
    const rent_due_day = parseInt(args[2]) || 1;

    const existing = db.get('tenants').find({ unit, adminId: ctx.admin.id }).value();
    if (existing) return ctx.reply(`⚠️ Unit ${unit} already exists.`);

    const linkCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    db.get('tenants').push({ unit, telegramId: null, name, rent_due_day, adminId: ctx.admin.id, linkCode }).write();
    ctx.replyWithMarkdown(`✅ Added Unit **${unit}** for **${name}** (Due Day: ${rent_due_day}).\n\n🔑 **Link Code:** \`${linkCode}\`\nSend this to the tenant. They must send \`/link ${linkCode}\` to this bot to receive notifications.`);
});

bot.command('removetenant', isAdmin, (ctx) => {
    const unit = ctx.message.text.split(' ')[1];
    if (!unit) return ctx.reply("Usage: /removetenant <UnitNumber>");

    const existing = db.get('tenants').find({ unit, adminId: ctx.admin.id }).value();
    if (!existing) return ctx.reply(`❌ Unit ${unit} not found.`);

    db.get('tenants').remove({ unit, adminId: ctx.admin.id }).write();
    ctx.reply(`🗑️ Removed Unit **${unit}** and its tenant data.`);
});

bot.command('tenantlist', isAdmin, (ctx) => {
    // Pagination for tenant list to prevent Telegram message length limits
    const tenants = db.get('tenants').filter({ adminId: ctx.admin.id }).value();
    if (tenants.length === 0) return ctx.reply("📋 No units found.");

    let message = "📋 **Unit List:**\n\n";
    let messages = [];

    tenants.forEach(t => {
        const status = t.telegramId ? "✅ Linked" : "🕒 Pending";
        const entry = `• **Unit ${t.unit}**: ${t.name} (${status})\n  (Due: ${t.rent_due_day})\n`;
        
        // Telegram max message length is roughly 4096. Keep strings slightly below that.
        if (message.length + entry.length > 4000) {
            messages.push(message);
            message = entry;
        } else {
            message += entry;
        }
    });
    if (message.length > 0) messages.push(message);

    messages.forEach(msg => ctx.replyWithMarkdown(msg));
});

bot.command('broadcast', isAdmin, (ctx) => {
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) return ctx.reply("Usage: /broadcast <Your Message Here>");

    const tenants = db.get('tenants').filter({ adminId: ctx.admin.id }).value();
    const activeTenants = tenants.filter(t => t.telegramId);

    if (activeTenants.length === 0) {
        return ctx.reply("⚠️ No registered tenants found to broadcast to.");
    }

    ctx.reply(`📣 Sending broadcast to ${activeTenants.length} tenants...`);

    // Basic rate limiting mechanism placeholder - strictly for broadcasting safely
    let delay = 0;
    activeTenants.forEach((tenant, index) => {
        setTimeout(() => {
            bot.telegram.sendMessage(
                tenant.telegramId,
                `📣 **Announcement from Landlord:**\n\n${text}`
            ).catch(err => console.error(`Failed to send broadcast to ${tenant.name}:`, err));
        }, delay);
        delay += 50; // 50ms delay between messages to respect 30 messages/second limit
    });

    setTimeout(() => {
        ctx.reply("✅ Broadcast sent to all active tenants!");
    }, delay + 500);
});

// --- Error Handling ---
bot.catch((err, ctx) => {
    console.log(`Ooops, encountered an error for ${ctx.updateType}`, err);
});

// Launch Bot
if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log('🚀 CondoBot is live and running!');
    setupReminders(bot);
    
    bot.launch().catch(err => {
        console.error('Failed to launch CondoBot:', err);
    });
} else {
    console.error('❌ ERROR: TELEGRAM_BOT_TOKEN is missing in .env file.');
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
