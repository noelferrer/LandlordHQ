require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./database');
const { setupReminders } = require('./scheduler');
const bot = require('./bot');
const { v4: uuidv4 } = require('uuid');
const { addMinutes, isAfter } = require('date-fns');

const app = express();
app.set('trust proxy', 1); // Trust first proxy for rate limiting (Nginx/Caddy on VPS)
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- CORS: Restrict to same origin in production ---
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];
app.use(cors({ origin: ALLOWED_ORIGINS }));

app.use(express.json()); // Express 5 built-in, no body-parser needed

// --- Rate Limiter (in-memory, per IP) ---
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 10; // Max 10 OTP attempts per 15 min window

function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const record = rateLimitStore.get(ip);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.set(ip, { windowStart: now, count: 1 });
        return next();
    }

    record.count++;
    if (record.count > RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({
            success: false,
            error: 'Too many attempts. Please wait 15 minutes before trying again.'
        });
    }
    return next();
}

// Cleanup stale rate limit entries every 30 min
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitStore) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
            rateLimitStore.delete(ip);
        }
    }
}, 30 * 60 * 1000);

// Serve Static Files (public/ only — never serve project root)
app.use(express.static(path.join(__dirname, '../public')));

// Serve Default
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard.html'));
});

// Serve Login Page explicitly (though static will catch it)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../login.html'));
});

// --- Authentication (OTP via Telegram using DB) ---
// Generate random 6-digit code
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// 1. Request OTP
app.post('/api/auth/request', rateLimiter, async (req, res) => {
    // Determine admin trying to login based on provided username.
    // Note: For multi-client, the frontend needs to send the username.
    // If not provided in req.body.username (which login.html currently doesn't, we will fall back to legacy behavior for now to not break the UI before the UI update, then update it)
    let telegramUsername = req.body.username;
    let fallbackOwnerId = process.env.OWNER_TELEGRAM_ID; 

    // Find the admin in DB
    // To support the transition, if the DB is empty, let's auto-create the root admin from .env
    let admins = db.get('admins').value() || [];
    if (admins.length === 0 && fallbackOwnerId) {
        db.get('admins').push({
            id: uuidv4(),
            username: process.env.OWNER_USERNAME || 'admin',
            telegramId: fallbackOwnerId,
            name: 'System Admin'
        }).write();
    }

    // Now look for the admin by username or fallback to the master ID if not provided.
    let admin = null;
    if (telegramUsername) {
        // Strip @ if present
        telegramUsername = telegramUsername.replace('@', '');
        admin = db.get('admins').find({ username: telegramUsername }).value();
    } else {
        // Fallback to legacy single user behavior temporarily
        admin = db.get('admins').find({ telegramId: fallbackOwnerId }).value();
    }

    if (!admin) {
        return res.status(404).json({ success: false, error: "Admin account not found. Please contact support." });
    }

    const code = generateOTP();
    const expiresAt = addMinutes(new Date(), 10).toISOString();
    
    // Store in DB
    // Remove old OTPs for this admin
    db.get('otps').remove({ telegramId: admin.telegramId }).write();
    db.get('otps').push({ telegramId: admin.telegramId, code, expiresAt }).write();

    console.log(`🔑 Generated OTP: ${code} for Admin: ${admin.name} (${admin.telegramId})`);

    // Send it via Telegram
    try {
        await bot.telegram.sendMessage(admin.telegramId, `🔐 **Landlord HQ Login**\n\nYour secure verification code is:\n\n\`${code}\`\n\n_This code will expire in 10 minutes. If you did not request this, you can safely ignore this message._`, { parse_mode: 'Markdown' });
        res.json({ success: true, message: "OTP sent to your Telegram." });
    } catch (err) {
        console.error("Failed to send OTP to Telegram:", err);
        res.status(500).json({ success: false, error: "Failed to send code via Telegram." });
    }
});

// 2. Verify OTP
app.post('/api/auth/verify', rateLimiter, (req, res) => {
    const { code, username } = req.body;
    let telegramUsername = username;
    let fallbackOwnerId = process.env.OWNER_TELEGRAM_ID; 

    let admin = null;
    if (telegramUsername) {
        telegramUsername = telegramUsername.replace('@', '');
        admin = db.get('admins').find({ username: telegramUsername }).value();
    } else {
        admin = db.get('admins').find({ telegramId: fallbackOwnerId }).value();
    }

    if (!admin) {
         return res.status(401).json({ success: false, error: "Invalid admin context." });
    }

    const record = db.get('otps').find({ telegramId: admin.telegramId }).value();
    if (!record) {
        return res.status(401).json({ success: false, error: "No OTP requested or expired." });
    }

    if (isAfter(new Date(), new Date(record.expiresAt))) {
        db.get('otps').remove({ telegramId: admin.telegramId }).write();
        return res.status(401).json({ success: false, error: "OTP has expired. Please request a new one." });
    }

    // Max attempts check (5 tries then invalidate)
    const MAX_OTP_ATTEMPTS = 5;
    const attempts = (record.attempts || 0) + 1;

    if (attempts > MAX_OTP_ATTEMPTS) {
        db.get('otps').remove({ telegramId: admin.telegramId }).write();
        return res.status(401).json({ success: false, error: "Too many failed attempts. Please request a new code." });
    }

    if (record.code === code) {
        // Success! Clear the OTP and issue a generic token
        db.get('otps').remove({ telegramId: admin.telegramId }).write();
        
        // Generate a new Session Token
        const sessionToken = uuidv4();
        const sessionExpires = addMinutes(new Date(), 60 * 24).toISOString(); // 24 hour session
        
        db.get('sessions').push({
            token: sessionToken,
            adminId: admin.id,
            expiresAt: sessionExpires
        }).write();

        res.json({ success: true, token: sessionToken });
    } else {
        // Track failed attempt
        db.get('otps').find({ telegramId: admin.telegramId }).assign({ attempts }).write();
        const remaining = MAX_OTP_ATTEMPTS - attempts;
        res.status(401).json({ success: false, error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
    }
});

// --- Auth Middleware ---
const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ success: false, error: "Missing authorization token." });
    }

    const token = authHeader.split(' ')[1]; // Format: "Bearer token..."
    const session = db.get('sessions').find({ token }).value();

    if (!session) {
        return res.status(401).json({ success: false, error: "Invalid or expired session token." });
    }

    if (isAfter(new Date(), new Date(session.expiresAt))) {
        db.get('sessions').remove({ token }).write();
        return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
    }

    // Attach admin context to the request
    const admin = db.get('admins').find({ id: session.adminId }).value();
    if (!admin) {
        return res.status(401).json({ success: false, error: "Admin account not found." });
    }

    req.admin = admin;
    next();
};

// --- API Endpoints ---

// Helper: Generate 6-char alphanumeric code
const generateLinkCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Helper: Parse ID from URL param (supports legacy numeric + new UUID)
const parseId = (id) => /^\d+$/.test(id) ? parseInt(id) : id;

// Get all tenants
app.get('/api/tenants', authenticateAdmin, (req, res) => {
    let tenants = db.get('tenants').filter({ adminId: req.admin.id }).value() || [];
    let updated = false;

    // Auto-generate link codes for tenants who don't have one and aren't linked to Telegram yet
    tenants = tenants.map(t => {
        if (!t.telegramId && !t.linkCode) {
            t.linkCode = generateLinkCode();
            updated = true;
        }
        return t;
    });

    if (updated) db.get('tenants').assign(tenants).write();

    res.json(tenants);
});

// Create a new tenant
app.post('/api/tenants', authenticateAdmin, (req, res) => {
    const tenant = req.body;
    // Check if unit already exists for THIS admin
    const existing = db.get('tenants').find({ unit: tenant.unit, adminId: req.admin.id }).value();
    if (existing) {
        return res.status(400).json({ success: false, error: `Unit ${tenant.unit} already exists.` });
    }

    // Convert numeric fields
    if (tenant.leaseAmount) tenant.leaseAmount = parseFloat(tenant.leaseAmount);
    if (tenant.advancePayment) tenant.advancePayment = parseFloat(tenant.advancePayment);
    if (tenant.securityDeposit) tenant.securityDeposit = parseFloat(tenant.securityDeposit);

    tenant.linkCode = generateLinkCode();
    tenant.adminId = req.admin.id; // Assign to current admin

    db.get('tenants').push(tenant).write();
    res.json({ success: true, tenant });
});

// Update a tenant
app.put('/api/tenants/:unit', authenticateAdmin, (req, res) => {
    const { unit } = req.params;
    const updates = req.body;
    
    // Convert numeric fields if they exist
    if (updates.leaseAmount) updates.leaseAmount = parseFloat(updates.leaseAmount);
    if (updates.advancePayment) updates.advancePayment = parseFloat(updates.advancePayment);
    if (updates.securityDeposit) updates.securityDeposit = parseFloat(updates.securityDeposit);

    db.get('tenants').find({ unit, adminId: req.admin.id }).assign(updates).write();
    res.json({ success: true, message: `Unit ${unit} updated.` });
});

// Delete a tenant
app.delete('/api/tenants/:unit', authenticateAdmin, (req, res) => {
    const { unit } = req.params;
    const existing = db.get('tenants').find({ unit, adminId: req.admin.id }).value();
    if (!existing) {
        return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    db.get('tenants').remove({ unit, adminId: req.admin.id }).write();
    // Cascade delete related historical data to prevent ghost records for the next tenant
    db.get('payments').remove({ unit, adminId: req.admin.id }).write();
    db.get('tickets').remove({ unit, adminId: req.admin.id }).write();
    res.json({ success: true, message: `Unit ${unit} and associated records deleted.` });
});

// Get all tickets (tenant concerns)
app.get('/api/tickets', authenticateAdmin, (req, res) => {
    const tickets = db.get('tickets').filter({ adminId: req.admin.id }).value() || [];
    res.json(tickets);
});

// Forward ticket to fixer
app.post('/api/tickets/:id/forward', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const ticket = db.get('tickets').find({ id: parseId(id), adminId: req.admin.id }).value();
    
    const settings = db.get('settings').find({ adminId: req.admin.id }).value() || {};

    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (!settings.fixer_id) return res.status(400).json({ error: "Fixer ID not configured in settings." });

    console.log(`📡 Forwarding ticket #${id} to Fixer (${settings.fixer_id})...`);

    bot.telegram.sendMessage(
        settings.fixer_id,
        `🛠️ **Maintenance Request Forwarded:**\n\n**Unit**: ${ticket.unit}\n**Issue**: ${ticket.issue}\n**Tenant**: ${ticket.tenantName}\n\nPlease attend to this issue.`,
        { parse_mode: 'Markdown' }
    ).catch(err => console.error("Failed to notify fixer:", err));

    // If ticket has media, forward it too
    if (ticket.media && ticket.media.length > 0) {
        ticket.media.forEach(m => {
            if (m.type === 'photo') {
                bot.telegram.sendPhoto(settings.fixer_id, m.fileId, { caption: `📸 From Unit ${ticket.unit}` });
            } else if (m.type === 'video') {
                bot.telegram.sendVideo(settings.fixer_id, m.fileId, { caption: `🎥 From Unit ${ticket.unit}` });
            }
        });
    }

    db.get('tickets').find({ id: parseId(id), adminId: req.admin.id }).assign({ status: 'forwarded' }).write();
    res.json({ success: true, message: `Ticket #${id} forwarded to maintenance.` });
});

// Update ticket status (partial update)
app.put('/api/tickets/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const ticketId = parseId(id);

    const ticket = db.get('tickets').find({ id: ticketId, adminId: req.admin.id }).value();
    if (!ticket) {
        return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    db.get('tickets').find({ id: ticketId, adminId: req.admin.id }).assign(updates).write();
    res.json({ success: true, message: `Ticket ${ticketId} updated successfully.` });
});

// Get settings
app.get('/api/settings', authenticateAdmin, (req, res) => {
    const settings = db.get('settings').find({ adminId: req.admin.id }).value() || {};
    res.json(settings);
});

// Update settings
app.post('/api/settings', authenticateAdmin, (req, res) => {
    const newSettings = { ...req.body, adminId: req.admin.id };
    const existing = db.get('settings').find({ adminId: req.admin.id }).value();
    if (existing) {
        db.get('settings').find({ adminId: req.admin.id }).assign(newSettings).write();
    } else {
        db.get('settings').push(newSettings).write();
    }
    res.json({ success: true, message: "Settings updated successfully." });
});

// --- Properties Endpoints ---
app.get('/api/properties', authenticateAdmin, (req, res) => {
    const properties = db.get('properties').filter({ adminId: req.admin.id }).value() || [];
    res.json(properties);
});

app.post('/api/properties', authenticateAdmin, (req, res) => {
    const property = {
        id: uuidv4(),
        adminId: req.admin.id, // Assign to current admin
        ...req.body,
        status: req.body.status || 'Active'
    };
    db.get('properties').push(property).write();
    res.json({ success: true, property });
});

app.put('/api/properties/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const targetId = parseId(id);
    console.log(`📝 Update Request for Property ID: ${targetId}`, updates);

    const property = db.get('properties').find({ id: targetId, adminId: req.admin.id }).value();
    if (!property) {
        console.error(`❌ Property not found: ${targetId}`);
        return res.status(404).json({ success: false, error: 'Property not found' });
    }

    db.get('properties').find({ id: targetId, adminId: req.admin.id }).assign(updates).write();
    console.log(`✅ Property ${targetId} updated successfully.`);
    res.json({ success: true, message: `Property ${targetId} updated.` });
});

app.delete('/api/properties/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const targetId = parseId(id);
    console.log(`🗑️ Delete Request for Property ID: ${targetId}`);

    const property = db.get('properties').find({ id: targetId, adminId: req.admin.id }).value();
    if (!property) {
        console.error(`❌ Property not found: ${targetId}`);
        return res.status(404).json({ success: false, error: 'Property not found' });
    }

    db.get('properties').remove({ id: targetId, adminId: req.admin.id }).write();
    console.log(`✅ Property ${targetId} deleted successfully.`);
    res.json({ success: true, message: `Property ${targetId} deleted.` });
});

// --- Payment Proof Endpoints ---

app.get('/api/payments', authenticateAdmin, (req, res) => {
    const payments = db.get('payments').filter({ adminId: req.admin.id }).value() || [];
    res.json(payments);
});

// Add a manual payment log
app.post('/api/payments', authenticateAdmin, (req, res) => {
    const payment = {
        id: uuidv4(),
        adminId: req.admin.id,
        type: 'manual',
        status: 'verified', // Manual payments are pre-verified
        timestamp: new Date().toISOString(),
        ...req.body
    };
    
    if (payment.amount) payment.amount = parseFloat(payment.amount);

    db.get('payments').push(payment).write();
    res.json({ success: true, payment });
});

app.post('/api/payments/:id/verify', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const payment = db.get('payments').find({ id: parseId(id), adminId: req.admin.id }).value();

    if (payment) {
        const { amount } = req.body;
        let updateData = { status: 'verified' };
        
        // If an amount is provided in the request, use it. Otherwise, use existing or fallback.
        if (amount !== undefined && amount !== null) {
            updateData.amount = parseFloat(amount);
        } else if (!payment.amount) {
            const tenant = db.get('tenants').find({ unit: payment.unit, adminId: req.admin.id }).value();
            if (tenant && tenant.leaseAmount) {
                updateData.amount = tenant.leaseAmount;
            } else {
                updateData.amount = 0;
            }
        }

        db.get('payments').find({ id: parseId(id), adminId: req.admin.id }).assign(updateData).write();

        // Notify tenant via Telegram
        const tenant = db.get('tenants').find({ unit: payment.unit, adminId: req.admin.id }).value();
        if (tenant && tenant.telegramId) {
            bot.telegram.sendMessage(
                tenant.telegramId,
                `✅ **Payment Verified!**\n\nYour payment for Unit ${payment.unit} has been confirmed by the landlord. Thank you!`
            ).catch(err => console.error("Failed to notify tenant:", err));
        }

        res.json({ success: true, message: 'Payment verified' });
    } else {
        res.status(404).json({ error: 'Payment not found' });
    }
});

// --- Payment Deletion ---
app.delete('/api/payments/:paymentId', authenticateAdmin, (req, res) => {
    const { paymentId } = req.params;
    const paymentExists = db.get('payments').find({ id: parseId(paymentId), adminId: req.admin.id }).value();

    if (paymentExists) {
        db.get('payments').remove({ id: parseId(paymentId), adminId: req.admin.id }).write();
        res.json({ success: true, message: 'Payment deleted successfully' });
    } else {
        res.status(404).json({ error: 'Payment not found' });
    }
});

// --- Expense Endpoints ---
app.get('/api/expenses', authenticateAdmin, (req, res) => {
    const expenses = db.get('expenses').filter({ adminId: req.admin.id }).value() || [];
    res.json(expenses);
});

app.post('/api/expenses', authenticateAdmin, (req, res) => {
    const expense = {
        id: uuidv4(),
        adminId: req.admin.id,
        timestamp: new Date().toISOString(),
        ...req.body
    };
    
    if (expense.amount) expense.amount = parseFloat(expense.amount);

    db.get('expenses').push(expense).write();
    res.json({ success: true, expense });
});

app.delete('/api/expenses/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    db.get('expenses').remove({ id: parseId(id), adminId: req.admin.id }).write();
    res.json({ success: true });
});

// --- Finance Summary ---
app.get('/api/finance/summary', authenticateAdmin, (req, res) => {
    const allPayments = db.get('payments').filter({ adminId: req.admin.id, status: 'verified' }).value() || [];
    const allExpenses = db.get('expenses').filter({ adminId: req.admin.id }).value() || [];
    
    // Filter exclusively to the current month to correctly represent "Monthly Revenue"
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const payments = allPayments.filter(p => {
        const d = new Date(p.timestamp);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });

    const expenses = allExpenses.filter(e => {
        const d = new Date(e.timestamp);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });
    
    const totalCollected = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const netProfit = totalCollected - totalExpenses;
    
    res.json({
        totalCollected,
        totalExpenses,
        netProfit,
        paymentCount: payments.length,
        expenseCount: expenses.length
    });
});

// --- Telegram Media Proxy ---
// Converts Telegram fileId → displayable image/video URL for the dashboard
// Uses direct Telegram HTTP API (no bot.launch() needed)
app.get('/api/media/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        // Step 1: Get file path from Telegram API directly
        const apiRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const apiData = await apiRes.json();

        if (!apiData.ok || !apiData.result || !apiData.result.file_path) {
            console.error('Telegram getFile failed:', apiData);
            return res.status(404).json({ error: 'File not found on Telegram' });
        }

        const filePath = apiData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        // Step 2: Fetch and stream the file
        const fileRes = await fetch(fileUrl);

        if (!fileRes.ok) {
            return res.status(404).json({ error: 'Could not download file from Telegram' });
        }

        const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
        fileRes.body.pipe(res);
    } catch (err) {
        console.error('Media proxy error:', err.message);
        res.status(500).json({ error: 'Media proxy failed' });
    }
});

// --- Landlord-to-Tenant Messaging ---
app.post('/api/message/:unit', authenticateAdmin, async (req, res) => {
    const { unit } = req.params;
    const { message } = req.body;
    const tenant = db.get('tenants').find({ unit, adminId: req.admin.id }).value();

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.telegramId) return res.status(400).json({ error: 'Tenant not linked via Telegram' });

    try {
        await bot.telegram.sendMessage(
            tenant.telegramId,
            `📩 **Message from Landlord:**\n\n${message}`
        );
        res.json({ success: true, message: `Message sent to Unit ${unit}` });
    } catch (err) {
        console.error('Message send error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Landlord sends photo to tenant
app.post('/api/message/:unit/photo', authenticateAdmin, async (req, res) => {
    const { unit } = req.params;
    const { photoUrl, caption } = req.body;
    const tenant = db.get('tenants').find({ unit, adminId: req.admin.id }).value();

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.telegramId) return res.status(400).json({ error: 'Tenant not linked via Telegram' });

    try {
        await bot.telegram.sendPhoto(
            tenant.telegramId,
            photoUrl,
            { caption: `📩 From Landlord: ${caption || ''}` }
        );
        res.json({ success: true, message: `Photo sent to Unit ${unit}` });
    } catch (err) {
        console.error('Photo send error:', err.message);
        res.status(500).json({ error: 'Failed to send photo' });
    }
});

// --- Session & OTP Cleanup (runs every hour) ---
const cron = require('node-cron');
cron.schedule('0 * * * *', () => {
    const now = new Date();
    const expiredSessions = db.get('sessions').filter(s => isAfter(now, new Date(s.expiresAt))).value();
    const expiredOtps = db.get('otps').filter(o => isAfter(now, new Date(o.expiresAt))).value();

    if (expiredSessions.length > 0) {
        expiredSessions.forEach(s => db.get('sessions').remove({ token: s.token }).write());
        console.log(`🧹 Cleaned up ${expiredSessions.length} expired session(s).`);
    }
    if (expiredOtps.length > 0) {
        expiredOtps.forEach(o => db.get('otps').remove({ telegramId: o.telegramId }).write());
        console.log(`🧹 Cleaned up ${expiredOtps.length} expired OTP(s).`);
    }
}, { scheduled: true, timezone: "Asia/Manila" });

// --- 404 Handler ---
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Global Error Handler (prevents stack trace leaks) ---
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`🌐 Dashboard API is running on http://localhost:${PORT}`);
});
