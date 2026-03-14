require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./database');
const { setupReminders } = require('./scheduler');
const bot = require('./bot');
const { v4: uuidv4 } = require('uuid');
const { addMinutes, isAfter } = require('date-fns');

const logFile = path.join(__dirname, '../debug.log');
const formatArg = (a) => (typeof a === 'string' ? a : JSON.stringify(a));
const debugLog = (msg) => {
    const timestamp = new Date().toISOString();
    try {
        fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    } catch (_) { /* never crash the app due to a logging failure */ }
};
console.log = (msg, ...args) => debugLog([msg, ...args].map(formatArg).join(' '));
console.error = (msg, ...args) => debugLog('ERROR: ' + [msg, ...args].map(formatArg).join(' '));

const app = express();
app.set('trust proxy', 1); // Trust first proxy for rate limiting (Nginx/Caddy on VPS)
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- CORS: Restrict to same origin in production ---
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(cookieParser());

// Security headers — CSP allows inline styles/scripts and CDN resources used by the dashboard
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://api.telegram.org"],
            connectSrc: ["'self'"],
        }
    }
}));

app.use(express.json({ limit: '1mb' })); // Express 5 built-in, cap payload size
app.use(csrfProtection); // CSRF double-submit cookie check on all state-changing requests

// --- Data Migration & Root Admin Setup ---
const fallbackOwnerId = process.env.OWNER_TELEGRAM_ID; 
if (fallbackOwnerId) {
    let admins = db.get('admins').value() || [];
    let rootAdmin = db.get('admins').find({ telegramId: fallbackOwnerId }).value();
    
    // 1. Ensure Root Admin exists
    if (!rootAdmin) {
        console.log("🛠️ Root Admin missing. Creating from .env...");
        rootAdmin = {
            id: uuidv4(),
            username: process.env.OWNER_USERNAME || 'admin',
            telegramId: fallbackOwnerId,
            name: 'System Admin'
        };
        db.get('admins').push(rootAdmin).write();
    }

    // 2. Map orphaned records to Root Admin
    const collections = ['tenants', 'tickets', 'payments', 'expenses', 'properties', 'settings'];
    collections.forEach(col => {
        let records = db.get(col).value();
        
        // Handle 'settings' specifically if it's still a single object
        if (col === 'settings' && records && !Array.isArray(records)) {
             records = [ { ...records, adminId: rootAdmin.id } ];
             db.set('settings', records).write();
             console.log(`✅ Migrated settings object to array for Root Admin.`);
             return;
        }

        if (Array.isArray(records)) {
            let updated = false;
            records.forEach(r => {
                if (!r.adminId) {
                    r.adminId = rootAdmin.id;
                    updated = true;
                }
                // Migration: Ensure properties have createdAt
                if (col === 'properties' && !r.createdAt) {
                    r.createdAt = new Date().toISOString();
                    updated = true;
                }
            });
            if (updated) {
                db.set(col, records).write();
                console.log(`✅ Migrated orphaned records or added missing fields in '${col}' to Root Admin.`);
            }
        }
    });
}

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

// --- Input Validation Helpers ---
const MAX_STRING_LENGTH = 500;
const MAX_SHORT_STRING = 100;

function validateString(val, maxLen = MAX_STRING_LENGTH) {
    return typeof val === 'string' && val.trim().length > 0 && val.length <= maxLen;
}

function validateEmail(val) {
    if (!val) return true; // optional field
    return typeof val === 'string' && val.length <= MAX_SHORT_STRING && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

function validatePhone(val) {
    if (!val) return true; // optional field
    return typeof val === 'string' && val.length <= 30 && /^[\d\s\-+().]+$/.test(val);
}

function validatePositiveNumber(val) {
    const n = parseFloat(val);
    return !isNaN(n) && n >= 0;
}

/**
 * Helper to resolve IDs that might be numeric (timestamps) or strings (UUIDs)
 * in lowdb find() queries.
 */
function resolveId(id) {
    if (!id) return null;
    if (!isNaN(id) && !isNaN(parseFloat(id))) {
        return Number(id);
    }
    return id; // Return as string (UUID)
}

// --- OTP Hashing ---
function hashOTP(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

// --- Secure Random Code Generation ---
function generateSecureCode(length = 8) {
    return crypto.randomBytes(length).toString('base64url').substring(0, length).toUpperCase();
}

// --- Cookie Options ---
const COOKIE_NAME = 'landlordhq_token';
const CSRF_COOKIE_NAME = 'landlordhq_csrf';
const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/'
};
const csrfCookieOptions = {
    httpOnly: false, // Must be readable by JS
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
};

// --- CSRF Protection (Double-Submit Cookie) ---
function generateCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
    // Skip CSRF for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Skip CSRF for auth endpoints (login/register — no session yet)
    if (req.path.startsWith('/api/auth/') || req.path === '/api/register') return next();

    const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
    const headerToken = req.headers['x-csrf-token'];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ success: false, error: 'CSRF token mismatch. Please refresh and try again.' });
    }
    next();
}

// --- Audit Logger ---
function auditLog(adminId, action, resource, details = {}) {
    if (!db.get('auditLog').value()) db.set('auditLog', []).write();
    db.get('auditLog').push({
        id: uuidv4(),
        adminId,
        action,    // e.g. 'create', 'update', 'delete', 'login', 'logout'
        resource,  // e.g. 'tenant', 'property', 'payment', 'session'
        details,   // e.g. { unit: '101', tenantName: 'John' }
        timestamp: new Date().toISOString()
    }).write();
}

// --- Pagination Helper ---
function paginate(array, page = 1, limit = 50) {
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const total = array.length;
    const totalPages = Math.ceil(total / l);
    const start = (p - 1) * l;
    const data = array.slice(start, start + l);
    return { data, page: p, limit: l, total, totalPages };
}

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
// Generate cryptographically random 6-digit code
const generateOTP = () => {
    const num = crypto.randomInt(100000, 999999);
    return num.toString();
};

// 1. Request OTP
app.post('/api/auth/request', rateLimiter, async (req, res) => {
    db.read(); // Re-read DB to pick up newly registered admins
    // Determine admin trying to login based on provided username.
    // Note: For multi-client, the frontend needs to send the username.
    // If not provided in req.body.username (which login.html currently doesn't, we will fall back to legacy behavior for now to not break the UI before the UI update, then update it)
    let telegramUsername = req.body.username;
    // Find the admin in DB
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
    
    // Store hashed OTP in DB (plaintext sent via Telegram only)
    const hashedCode = hashOTP(code);
    db.get('otps').remove({ telegramId: admin.telegramId }).write();
    db.get('otps').push({ telegramId: admin.telegramId, code: hashedCode, expiresAt }).write();

    console.log(`🔑 OTP sent to Admin: ${admin.name}`);

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
    db.read(); // Re-read DB to pick up newly registered admins
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

    if (record.code === hashOTP(code)) {
        // Success! Clear the OTP and issue a session token via HttpOnly cookie
        db.get('otps').remove({ telegramId: admin.telegramId }).write();

        // Generate a new Session Token
        const sessionToken = uuidv4();
        const sessionExpires = addMinutes(new Date(), 60 * 24).toISOString(); // 24 hour session

        db.get('sessions').push({
            token: sessionToken,
            adminId: admin.id,
            expiresAt: sessionExpires
        }).write();

        res.cookie(COOKIE_NAME, sessionToken, cookieOptions);
        // Issue CSRF token cookie (readable by JS for double-submit)
        res.cookie(CSRF_COOKIE_NAME, generateCsrfToken(), csrfCookieOptions);
        auditLog(admin.id, 'login', 'session', { username: admin.username });
        res.json({ success: true });
    } else {
        // Track failed attempt
        db.get('otps').find({ telegramId: admin.telegramId }).assign({ attempts }).write();
        const remaining = MAX_OTP_ATTEMPTS - attempts;
        res.status(401).json({ success: false, error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
    }
});

// --- Auth Middleware ---
const authenticateAdmin = (req, res, next) => {
    // Read token from HttpOnly cookie first, fall back to Authorization header
    let token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) {
        const authHeader = req.headers['authorization'];
        if (authHeader) token = authHeader.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, error: "Missing authorization token." });
    }

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

const authenticateSuperAdmin = (req, res, next) => {
    authenticateAdmin(req, res, () => {
        // The core owner specified in the .env file is the only true super admin
        if (req.admin.telegramId !== process.env.OWNER_TELEGRAM_ID) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin only' });
        }
        next();
    });
};

// --- Auth Check & Logout ---
app.get('/api/auth/check', authenticateAdmin, (req, res) => {
    // Refresh CSRF token on every auth check (page load)
    res.cookie(CSRF_COOKIE_NAME, generateCsrfToken(), csrfCookieOptions);
    res.json({ success: true, admin: { name: req.admin.name, username: req.admin.username } });
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (token) {
        const session = db.get('sessions').find({ token }).value();
        if (session) auditLog(session.adminId, 'logout', 'session');
        db.get('sessions').remove({ token }).write();
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
});

// --- Super Admin Endpoints ---
app.get('/super', (req, res) => {
    res.sendFile(path.join(__dirname, '../super.html'));
});

// Generate a new invite code
app.post('/api/super/invites', authenticateSuperAdmin, (req, res) => {
    const code = 'INV-' + generateSecureCode(8);
    
    // Store it in the DB
    if (!db.get('invites').value()) db.set('invites', []).write();
    
    const invite = {
        code,
        status: 'active', // active, claimed
        createdAt: new Date().toISOString(),
        claimedBy: null,
        claimedAt: null
    };
    
    db.get('invites').push(invite).write();
    auditLog(req.admin.id, 'create', 'invite', { code: invite.code });
    res.json({ success: true, invite });
});

// View audit log (super admin only, paginated)
app.get('/api/super/audit-log', authenticateSuperAdmin, (req, res) => {
    const logs = (db.get('auditLog').value() || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (req.query.page) {
        return res.json(paginate(logs, req.query.page, req.query.limit));
    }
    // Default: return last 100 entries
    res.json(logs.slice(0, 100));
});

// View filtered audit log for current landlord (paginated)
app.get('/api/audit-log', authenticateAdmin, (req, res) => {
    const logs = (db.get('auditLog').value() || [])
        .filter(log => log.adminId === req.admin.id)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (req.query.page) {
        return res.json(paginate(logs, req.query.page, req.query.limit));
    }
    // Default: return last 50 entries
    res.json(logs.slice(0, 50));
});

// List all invite codes
app.get('/api/super/invites', authenticateSuperAdmin, (req, res) => {
    const invites = db.get('invites').value() || [];
    res.json(invites);
});

// --- Public Registration API ---
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, '../signup.html')));
app.get('/register', (req, res) => res.redirect('/signup'));

app.post('/api/register', (req, res) => {
    db.read(); // Re-read DB to avoid stale state across processes
    const { code, name, username } = req.body;

    if (!code || !name || !username) {
        return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    if (!validateString(name, MAX_SHORT_STRING)) {
        return res.status(400).json({ success: false, error: 'Name must be 1-100 characters.' });
    }

    if (!validateString(username, 50) || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ success: false, error: 'Username must be 1-50 alphanumeric characters.' });
    }

    // Check if invite exists and is active
    let invites = db.get('invites').value() || [];
    const invite = invites.find(i => i.code === code.trim().toUpperCase());

    if (!invite || invite.status !== 'active') {
        return res.status(400).json({ success: false, error: 'Invalid or already claimed invite code.' });
    }

    // Check for 24h expiration
    const inviteDate = new Date(invite.createdAt);
    const now = new Date();
    const hoursOld = (now - inviteDate) / (1000 * 60 * 60);

    if (hoursOld > 24) {
        db.get('invites').find({ code: invite.code }).assign({ status: 'expired' }).write();
        return res.status(400).json({ success: false, error: 'This invitation code has expired (valid for 24h).' });
    }

    // Check if username is taken
    let admins = db.get('admins').value() || [];
    const usernameTaken = admins.some(a => a.username.toLowerCase() === username.toLowerCase());
    
    if (usernameTaken) {
        return res.status(400).json({ success: false, error: 'Username is already taken.' });
    }

    // Create dormant admin (telegramId is null until they /claim)
    const newAdmin = {
        id: uuidv4(),
        username: username.toLowerCase(),
        name,
        telegramId: null // Pending claim
    };

    db.get('admins').push(newAdmin).write();

    // Mark invite as claimed
    db.get('invites')
      .find({ code: invite.code })
      .assign({ status: 'claimed', claimedBy: username, claimedAt: new Date().toISOString() })
      .write();

    res.json({ success: true, message: 'Account created. Awaiting Telegram claim.' });
});

// --- API Endpoints ---

// Helper: Generate 6-char alphanumeric code (crypto-secure)
const generateLinkCode = () => generateSecureCode(6);

// Helper: Parse ID from URL param (supports legacy numeric + new UUID)
// --- ID Resolver ---
// (Already defined at line 150)

// Get all tenants (paginated)
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

    // Support pagination via ?page=&limit= (default: return all for backward compat)
    if (req.query.page) {
        const result = paginate(tenants, req.query.page, req.query.limit);
        return res.json(result);
    }
    res.json(tenants);
});

// Create a new tenant
app.post('/api/tenants', authenticateAdmin, (req, res) => {
    const tenant = req.body;

    // Input validation
    if (!tenant.unit || !validateString(tenant.unit, 50)) {
        return res.status(400).json({ success: false, error: 'Unit is required (max 50 chars).' });
    }
    if (!tenant.name || !validateString(tenant.name, MAX_SHORT_STRING)) {
        return res.status(400).json({ success: false, error: 'Tenant name is required (max 100 chars).' });
    }
    if (!validateEmail(tenant.email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format.' });
    }
    if (!validatePhone(tenant.phone)) {
        return res.status(400).json({ success: false, error: 'Invalid phone format.' });
    }
    if (tenant.leaseAmount && !validatePositiveNumber(tenant.leaseAmount)) {
        return res.status(400).json({ success: false, error: 'Lease amount must be a positive number.' });
    }
    if (tenant.advancePayment && !validatePositiveNumber(tenant.advancePayment)) {
        return res.status(400).json({ success: false, error: 'Advance payment must be a positive number.' });
    }
    if (tenant.securityDeposit && !validatePositiveNumber(tenant.securityDeposit)) {
        return res.status(400).json({ success: false, error: 'Security deposit must be a positive number.' });
    }

    // Check if unit already exists for THIS admin
    const existing = db.get('tenants').find({ unit: tenant.unit, adminId: req.admin.id }).value();
    if (existing) {
        return res.status(400).json({ success: false, error: `Unit ${tenant.unit} already exists.` });
    }

    // Enforce property unit capacity
    if (tenant.propertyId) {
        const property = db.get('properties').find({ id: tenant.propertyId, adminId: req.admin.id }).value();
        if (property) {
            const maxUnits = parseInt(property.units) || 0;
            const currentCount = db.get('tenants').filter({ propertyId: tenant.propertyId, adminId: req.admin.id }).value().length;
            if (maxUnits > 0 && currentCount >= maxUnits) {
                return res.status(400).json({ success: false, error: `This property is at full capacity (${maxUnits} unit${maxUnits !== 1 ? 's' : ''}). Increase the unit count in Property settings first.` });
            }
        }
    }

    // Convert numeric fields
    if (tenant.leaseAmount) tenant.leaseAmount = parseFloat(tenant.leaseAmount);
    if (tenant.advancePayment) tenant.advancePayment = parseFloat(tenant.advancePayment);
    if (tenant.securityDeposit) tenant.securityDeposit = parseFloat(tenant.securityDeposit);

    tenant.linkCode = generateLinkCode();
    tenant.adminId = req.admin.id; // Assign to current admin

    db.get('tenants').push(tenant).write();
    auditLog(req.admin.id, 'create', 'tenant', { unit: tenant.unit, name: tenant.name });
    res.json({ success: true, tenant });
});

// Update a tenant
app.put('/api/tenants/:unit', authenticateAdmin, (req, res) => {
    const { unit } = req.params;
    const updates = req.body;

    // If moving to a different property, enforce capacity of the new property
    if (updates.propertyId) {
        const currentTenant = db.get('tenants').find({ unit, adminId: req.admin.id }).value();
        const isChangingProperty = !currentTenant || String(currentTenant.propertyId) !== String(updates.propertyId);
        if (isChangingProperty) {
            const property = db.get('properties').find({ id: updates.propertyId, adminId: req.admin.id }).value();
            if (property) {
                const maxUnits = parseInt(property.units) || 0;
                // Count tenants in new property EXCLUDING the current tenant (they don't add to count)
                const currentCount = db.get('tenants')
                    .filter(t => t.propertyId === updates.propertyId && t.adminId === req.admin.id && t.unit !== unit)
                    .value().length;
                if (maxUnits > 0 && currentCount >= maxUnits) {
                    return res.status(400).json({ success: false, error: `Target property is at full capacity (${maxUnits} unit${maxUnits !== 1 ? 's' : ''}). Increase the unit count in Property settings first.` });
                }
            }
        }
    }

    // Convert numeric fields if they exist
    if (updates.leaseAmount) updates.leaseAmount = parseFloat(updates.leaseAmount);
    if (updates.advancePayment) updates.advancePayment = parseFloat(updates.advancePayment);
    if (updates.securityDeposit) updates.securityDeposit = parseFloat(updates.securityDeposit);

    db.get('tenants').find({ unit, adminId: req.admin.id }).assign(updates).write();
    auditLog(req.admin.id, 'update', 'tenant', { unit });
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
    auditLog(req.admin.id, 'delete', 'tenant', { unit });
    res.json({ success: true, message: `Unit ${unit} and associated records deleted.` });
});

// Get all tickets (paginated)
app.get('/api/tickets', authenticateAdmin, (req, res) => {
    db.read();
    const tickets = db.get('tickets').filter({ adminId: req.admin.id }).value() || [];
    if (req.query.page) {
        return res.json(paginate(tickets, req.query.page, req.query.limit));
    }
    res.json(tickets);
});

// Forward ticket to fixer
app.post('/api/tickets/:id/forward', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const ticket = db.get('tickets').find({ id: resolveId(id), adminId: req.admin.id }).value();
    
    const settings = db.get('settings').find({ adminId: req.admin.id }).value() || {};

    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (!settings.fixer_id) return res.status(400).json({ error: "Fixer Chat ID not configured in Settings. Have your fixer send /myid to the bot to get their numeric ID." });

    // Normalize: strip leading @ if present, then require numeric ID
    const rawFixerId = String(settings.fixer_id).trim().replace(/^@/, '');
    const fixerChatId = /^\d+$/.test(rawFixerId) ? parseInt(rawFixerId, 10) : null;
    if (!fixerChatId) {
        return res.status(400).json({ error: "Fixer Chat ID must be a numeric Telegram user ID (e.g. 123456789). Have your fixer send /myid to the bot to get their ID." });
    }

    console.log(`📡 Forwarding ticket #${id} to Fixer [ID: ${fixerChatId}]...`);

    bot.telegram.sendMessage(
        fixerChatId,
        `🛠️ **Maintenance Request Forwarded:**\n\n**Unit**: ${ticket.unit}\n**Issue**: ${ticket.issue}\n**Tenant**: ${ticket.tenantName}\n\nPlease attend to this issue.`,
        { parse_mode: 'Markdown' }
    ).catch(err => console.error("Failed to notify fixer:", err));

    // If ticket has media, forward it too
    if (ticket.media && ticket.media.length > 0) {
        ticket.media.forEach(m => {
            if (m.type === 'photo') {
                bot.telegram.sendPhoto(fixerChatId, m.fileId, { caption: `📸 From Unit ${ticket.unit}` }).catch(err => console.error("Failed to send media to fixer:", err));
            } else if (m.type === 'video') {
                bot.telegram.sendVideo(fixerChatId, m.fileId, { caption: `🎥 From Unit ${ticket.unit}` }).catch(err => console.error("Failed to send media to fixer:", err));
            }
        });
    }

    db.get('tickets').find({ id: resolveId(id), adminId: req.admin.id }).assign({ status: 'forwarded' }).write();
    auditLog(req.admin.id, 'forward', 'ticket', { id: resolveId(id), unit: ticket.unit });
    res.json({ success: true, message: `Ticket #${id} forwarded to maintenance.` });
});

// Update ticket status (partial update)
app.put('/api/tickets/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const targetId = resolveId(id);
    const updates = req.body;
    console.log(`📝 Ticket Update [${targetId}]:`, updates);

    const ticket = db.get('tickets').find({ id: targetId, adminId: req.admin.id }).value();
    if (!ticket) {
        return res.status(404).json({ success: false, error: "Ticket not found." });
    }

    // When closing a ticket, also mark it as reported (atomic close)
    if (updates.status === 'closed') {
        updates.reported = true;
        updates.closedAt = new Date().toISOString();
    }

    db.get('tickets').find({ id: targetId, adminId: req.admin.id }).assign(updates).write();
    auditLog(req.admin.id, 'update', 'ticket', { id: targetId, status: updates.status });
    res.json({ success: true, message: `Ticket ${targetId} updated successfully.` });
});

// Get settings
app.get('/api/settings', authenticateAdmin, (req, res) => {
    const settings = db.get('settings').find({ adminId: req.admin.id }).value() || {};
    res.json(settings);
});

// Update settings
app.post('/api/settings', authenticateAdmin, (req, res) => {
    // Normalize fixer_id: strip leading @ so numeric-only IDs are stored
    if (req.body.fixer_id) {
        req.body.fixer_id = String(req.body.fixer_id).trim().replace(/^@/, '');
    }
    const newSettings = { ...req.body, adminId: req.admin.id };
    const existing = db.get('settings').find({ adminId: req.admin.id }).value();
    if (existing) {
        db.get('settings').find({ adminId: req.admin.id }).assign(newSettings).write();
    } else {
        db.get('settings').push(newSettings).write();
    }
    auditLog(req.admin.id, 'update', 'settings', {});
    res.json({ success: true, message: "Settings updated successfully." });
});

// --- Properties Endpoints ---
app.get('/api/properties', authenticateAdmin, (req, res) => {
    const properties = db.get('properties').filter({ adminId: req.admin.id }).value() || [];
    if (req.query.page) {
        return res.json(paginate(properties, req.query.page, req.query.limit));
    }
    res.json(properties);
});

app.post('/api/properties', authenticateAdmin, (req, res) => {
    if (!req.body.name || !validateString(req.body.name, MAX_SHORT_STRING)) {
        return res.status(400).json({ success: false, error: 'Property name is required (max 100 chars).' });
    }
    if (req.body.address && !validateString(req.body.address, 200)) {
        return res.status(400).json({ success: false, error: 'Address too long (max 200 chars).' });
    }

    const property = {
        id: uuidv4(),
        adminId: req.admin.id,
        ...req.body,
        status: req.body.status || 'Active',
        createdAt: new Date().toISOString()
    };
    db.get('properties').push(property).write();
    auditLog(req.admin.id, 'create', 'property', { name: property.name, id: property.id });
    res.json({ success: true, property });
});

app.put('/api/properties/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const targetId = resolveId(id);
    console.log(`📝 Update Request: id=${id}, targetId=${targetId} (${typeof targetId}), adminId=${req.admin.id} (${typeof req.admin.id})`);

    const property = db.get('properties').value().find(p => String(p.id) === String(targetId) && String(p.adminId) === String(req.admin.id));
    if (!property) {
        console.error(`❌ Property not found: targetId=${targetId} (${typeof targetId}), adminId=${req.admin.id}`);
        const allProps = db.get('properties').filter({ adminId: req.admin.id }).value();
        console.log(`📂 Available props for admin:`, allProps.map(p => ({ id: p.id, type: typeof p.id })));
        return res.status(404).json({ success: false, error: 'Property not found' });
    }

    // Use regular find for assign().write() chain
    db.get('properties').find(p => String(p.id) === String(targetId) && String(p.adminId) === String(req.admin.id)).assign(updates).write();
    auditLog(req.admin.id, 'update', 'property', { id: targetId });
    res.json({ success: true, message: `Property ${targetId} updated.` });
});

app.delete('/api/properties/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const targetId = resolveId(id);
    console.log(`🗑️ Delete Request for Property ID: ${targetId}`);

    const property = db.get('properties').value().find(p => String(p.id) === String(targetId) && String(p.adminId) === String(req.admin.id));
    if (!property) {
        console.error(`❌ Property not found: ${targetId}`);
        return res.status(404).json({ success: false, error: 'Property not found' });
    }

    db.get('properties').remove({ id: targetId, adminId: req.admin.id }).write();
    auditLog(req.admin.id, 'delete', 'property', { id: targetId });
    res.json({ success: true, message: `Property ${targetId} deleted.` });
});

// --- Payment Proof Endpoints ---

app.get('/api/payments', authenticateAdmin, (req, res) => {
    db.read();
    const payments = db.get('payments').filter({ adminId: req.admin.id }).value() || [];
    if (req.query.page) {
        return res.json(paginate(payments, req.query.page, req.query.limit));
    }
    res.json(payments);
});

// Add a manual payment log
app.post('/api/payments', authenticateAdmin, (req, res) => {
    if (req.body.amount !== undefined && !validatePositiveNumber(req.body.amount)) {
        return res.status(400).json({ success: false, error: 'Amount must be a positive number.' });
    }
    if (req.body.notes && !validateString(req.body.notes, MAX_STRING_LENGTH)) {
        return res.status(400).json({ success: false, error: 'Notes too long (max 500 chars).' });
    }

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
    auditLog(req.admin.id, 'create', 'payment', { id: payment.id, unit: payment.unit, amount: payment.amount });
    res.json({ success: true, payment });
});

app.post('/api/payments/:id/verify', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const payment = db.get('payments').find({ id: resolveId(id), adminId: req.admin.id }).value();

    if (payment) {
        const { amount } = req.body;
        let updateData = { status: 'verified' };
        
        const tenant = db.get('tenants').find({ unit: payment.unit, adminId: req.admin.id }).value();

        if (amount !== undefined && amount !== null) {
            updateData.amount = parseFloat(amount);
        } else if (!payment.amount) {
            if (tenant && tenant.leaseAmount) {
                updateData.amount = tenant.leaseAmount;
            } else {
                updateData.amount = 0;
            }
        }

        if (tenant && tenant.propertyId) {
            updateData.propertyId = tenant.propertyId;
        }

        db.get('payments').find({ id: resolveId(id), adminId: req.admin.id }).assign(updateData).write();

        // Notify tenant via Telegram
        if (tenant && tenant.telegramId) {
            bot.telegram.sendMessage(
                tenant.telegramId,
                `✅ **Payment Verified!**\n\nYour payment for Unit ${payment.unit} has been confirmed by the landlord. Thank you!`
            ).catch(err => console.error("Failed to notify tenant:", err));
        }

        auditLog(req.admin.id, 'verify', 'payment', { id: resolveId(id), unit: payment.unit });
        res.json({ success: true, message: 'Payment verified' });
    } else {
        res.status(404).json({ error: 'Payment not found' });
    }
});

// --- Payment Deletion ---
app.delete('/api/payments/:paymentId', authenticateAdmin, (req, res) => {
    const { paymentId } = req.params;
    const paymentExists = db.get('payments').find({ id: resolveId(paymentId), adminId: req.admin.id }).value();

    if (paymentExists) {
        db.get('payments').remove({ id: resolveId(paymentId), adminId: req.admin.id }).write();
        auditLog(req.admin.id, 'delete', 'payment', { id: resolveId(paymentId) });
        res.json({ success: true, message: 'Payment deleted successfully' });
    } else {
        res.status(404).json({ error: 'Payment not found' });
    }
});

// --- Expense Endpoints ---
app.get('/api/expenses', authenticateAdmin, (req, res) => {
    const expenses = db.get('expenses').filter({ adminId: req.admin.id }).value() || [];
    if (req.query.page) {
        return res.json(paginate(expenses, req.query.page, req.query.limit));
    }
    res.json(expenses);
});

app.post('/api/expenses', authenticateAdmin, (req, res) => {
    if (req.body.amount !== undefined && !validatePositiveNumber(req.body.amount)) {
        return res.status(400).json({ success: false, error: 'Amount must be a positive number.' });
    }
    if (req.body.description && !validateString(req.body.description, MAX_STRING_LENGTH)) {
        return res.status(400).json({ success: false, error: 'Description too long (max 500 chars).' });
    }

    const expense = {
        id: uuidv4(),
        adminId: req.admin.id,
        timestamp: new Date().toISOString(),
        ...req.body
    };

    if (expense.amount) expense.amount = parseFloat(expense.amount);

    db.get('expenses').push(expense).write();
    auditLog(req.admin.id, 'create', 'expense', { id: expense.id, amount: expense.amount });
    res.json({ success: true, expense });
});

app.delete('/api/expenses/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    db.get('expenses').remove({ id: resolveId(id), adminId: req.admin.id }).write();
    auditLog(req.admin.id, 'delete', 'expense', { id: resolveId(id) });
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
app.get('/api/media/:fileId', authenticateAdmin, async (req, res) => {
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
        res.setHeader('Cache-Control', 'private, max-age=86400'); // Cache for 24h, private only
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

    if (!message || !validateString(message, 2000)) {
        return res.status(400).json({ error: 'Message is required (max 2000 chars).' });
    }

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

    // Clean up expired invitations (older than 24h and still 'active')
    const invites = db.get('invites').value() || [];
    const expiredInvites = invites.filter(i => i.status === 'active' && (now - new Date(i.createdAt)) / (1000 * 60 * 60) > 24);
    if (expiredInvites.length > 0) {
        expiredInvites.forEach(i => {
            db.get('invites').find({ code: i.code }).assign({ status: 'expired' }).write();
        });
        console.log(`🧹 Marked ${expiredInvites.length} invitation(s) as expired.`);
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
