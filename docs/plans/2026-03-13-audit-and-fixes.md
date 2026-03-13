# LandlordHQ Audit & Multi-Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 bugs, answer 6 system questions, and improve data integrity across Properties, Tenants, Support Hub, and the Telegram bot integration.

**Architecture:** All changes are isolated to `src/server.js`, `src/bot.js`, `public/js/dashboard.js`, and `dashboard.html`. No new dependencies. Follows existing patterns (lowdb, Telegraf, csrfHeaders, renderPagination).

**Tech Stack:** Node.js/Express 5, lowdb, Telegraf, vanilla JS frontend, HTML/CSS inline

---

## SYSTEM QUESTIONS — Answers (No Code)

### Q1: Property Status [Active / Inactive / Maintenance]
**Current impact: NONE.** The field is saved and loaded in the UI, but no code path reads it to make any decision. It does NOT affect:
- Whether tenants can be assigned to the property
- Whether the property appears in dropdowns
- Any dashboard stats or overdue logic

**Recommendation:** Either wire it up (e.g., block adding tenants to Maintenance/Inactive properties — see Task 3 below) or remove it from the form to reduce confusion. This plan keeps it and wires it to the tenant capacity check.

---

### Q2: Tenant Status [Active / Inactive]
**Current impact: REAL AND SIGNIFICANT.** Used in 5 places:
- Dashboard stat "Active Leases" (`tenants.filter(t => t.status !== 'Inactive').length`)
- Overdue check skips Inactive tenants
- Upcoming payments skips Inactive tenants
- Finance Hub upcoming receivables: only `status === 'Active'`
- Manual payment form dropdown: only shows Active tenants

**Conclusion:** Keep it. It is functional and correctly gates all payment-related features.

---

### Q3: Financials > Upcoming Receivables
**Purpose:** Shows Active tenants whose rent due date is coming up soon and who have NOT yet paid this month. Calculated from `tenant.rent_due_day` vs today's date.

**Connected to:** Tenant data (`rent_due_day`, `status`) + Payments data (to detect if already paid).

**Necessary:** Yes. Gives landlord a forward-looking view of expected collections before they become overdue.

---

### Q4: Dashboard > Overdue Payments
**Purpose:** Shows Active tenants who are PAST their `rent_due_day` (with 1-day grace) AND have no verified payment recorded for the current month.

**Connected to:** Tenant data + Payment records. Cross-references both to compute overdue status.

**Necessary:** Yes. Core feature. Tells landlord exactly who to follow up with today.

---

### Q5: Settings > Fixer Chat ID — Does it work?
**Answer: BROKEN by configuration.** The code IS wired correctly — checking "Reported to Fixer" calls `POST /api/tickets/:id/forward`, which sends the ticket to the Fixer's Telegram via `bot.telegram.sendMessage(settings.fixer_id, ...)`.

**Root cause of the error `TelegramError: 400: Bad Request: chat not found`:**
The stored value is `@noelferrer` (a username). Telegram's Bot API **cannot send to personal account usernames** — only to:
- Numeric user IDs (e.g., `123456789`) ← what is needed
- Public channel usernames
- Group/channel numeric IDs

**Fix required (Task 5 below):**
1. Add `/myid` bot command so the fixer can learn their numeric ID
2. Update Settings UI label to say "Numeric Telegram ID only"
3. Strip leading `@` and validate it's numeric before saving

---

### Q6: Settings > Currency — Does it have function?
**Answer: YES, but frontend-only.** `settings.currency` (e.g., `₱` or `$`) is used in 9+ locations in `dashboard.js` to format all monetary display values. It is never sent to the backend/bot.

**Conclusion:** Keep it. It works correctly for its purpose.

---

## CODE CHANGES

### Task 1: Fix Due Day display — make saves visible

**Root cause:** `rent_due_day` IS saved correctly to DB (verified in code). The bug is a UX issue — the Tenants table has no "Due Day" column, so after saving, users can't see the value changed. They re-open the modal and it does show the updated value — but it's not obvious.

**Files:**
- Modify: `public/js/dashboard.js` (tenant table render, ~line 495)
- Modify: `dashboard.html` (tenant table `<thead>`, ~line 1730)

**Step 1: Add "Due Day" column header to tenant table**

In `dashboard.html`, find the `<thead>` of the tenants table (look for `<th>Move-in</th>` or similar) and add `<th>Due Day</th>` after the Move-in column.

**Step 2: Render due day in each tenant row**

In `dashboard.js` tenant row rendering (~line 506), after the Move-in `<td>`, add:
```javascript
<td style="color: var(--text-muted); font-size: 0.9rem;">${t.rent_due_day ? `Day ${t.rent_due_day}` : 'Day 1'}</td>
```

**Step 3: Verify other fields update correctly**

Open an edit tenant modal, change: name, email, phone, property, status, due day, lease amount, move-in date, advance, deposit, lease end, remarks. Save. Confirm all fields update (check DB `data/db.json` if in doubt). All fields are included in the `data` object in `dashboard.js` lines 237–252 and the server does a blanket `assign(updates).write()` — so all fields should save. No other fix needed unless testing reveals otherwise.

**Step 4: Commit**
```bash
git add dashboard.html public/js/dashboard.js
git commit -m "feat: show rent due day column in tenants table"
```

---

### Task 2: Fix closing support ticket

**Root cause investigation needed.** The close logic uses two sequential API calls (`updateTicketStatusNoRefresh` then `updateTicketStatus`). The second call triggers `refreshDashboard()` which re-renders support hub. This should work — but there may be a CSRF timing issue or confirm modal lifecycle bug.

**Fix: Simplify to a single atomic PUT that closes the ticket.**

**Files:**
- Modify: `public/js/dashboard.js` (handleTicketCheck, ~line 1466)
- Modify: `src/server.js` (PUT /api/tickets/:id, ~line 711 — add `status: 'closed'` sets `reported: true` too)

**Step 1: Update server.js — when status is set to 'closed', also auto-set reported to true**

In `src/server.js` PUT `/api/tickets/:id` (~line 723):
```javascript
// Auto-set reported when closing
if (updates.status === 'closed') {
    updates.reported = true;
}
db.get('tickets').find({ id: targetId, adminId: req.admin.id }).assign(updates).write();
```

**Step 2: Simplify handleTicketCheck in dashboard.js — single call to close**

Replace the `isRep && isRes` branch (lines 1466–1481) with:
```javascript
if (isRep && isRes) {
    openConfirmModal(
        'Close & Lock Ticket?',
        'Mark this issue as resolved? It will move to the Resolved Tickets table.',
        'danger',
        async () => {
            await updateTicketStatus(id, 'status', 'closed'); // single call — server handles reported=true
        }
    );
    // Revert checkbox if modal dismissed
    const oldClose = closeConfirmModal;
    window.closeConfirmModal = function() {
        if (!document.getElementById(`chk-res-${id}`)?.closest('.resolved-ticket')) {
            // ticket still open, check if it's actually closed now
        }
        window.closeConfirmModal = oldClose;
        oldClose();
    };
}
```

Actually, cleaner approach — remove the `window.closeConfirmModal` override (fragile). Instead:

```javascript
if (isRep && isRes) {
    checkbox.checked = false; // revert immediately; will be set correctly after DB confirms
    openConfirmModal(
        'Close & Lock Ticket?',
        'Mark this issue as resolved? It will move to the Resolved Tickets table.',
        'danger',
        async () => {
            await updateTicketStatus(id, 'status', 'closed');
            // refreshDashboard() inside updateTicketStatus will re-render with correct state
        }
    );
}
```

**Step 3: Verify the ticket appears in resolved table after closing**

After closing: confirm the resolved tickets section (`#resolved-tickets-section`) becomes visible and contains the closed ticket.

**Step 4: Also handle single-checkbox close (no "Reported to Fixer" required)**

Currently, a user CAN close a ticket without checking "Reported to Fixer" (goes to else branch, sets `status: 'closed'`). This is fine — keep this path.

**Step 5: Commit**
```bash
git add src/server.js public/js/dashboard.js
git commit -m "fix: simplify ticket close flow, auto-set reported when closing"
```

---

### Task 3: Property units capacity — enforce tenant limit

**Current state:** No enforcement. A property with 2 units can have unlimited tenants.

**Files:**
- Modify: `src/server.js` (POST /api/tenants ~line 593, PUT /api/tenants/:unit ~line 639)
- Modify: `public/js/dashboard.js` (add property unit count display, ~line 490)

**Step 1: Add capacity check to POST /api/tenants in server.js**

After existing validation (~line 617), before inserting:
```javascript
// Enforce property unit capacity
if (tenant.propertyId) {
    const property = db.get('properties').find({ id: tenant.propertyId, adminId: req.admin.id }).value();
    if (property) {
        const maxUnits = parseInt(property.units) || 0;
        const currentCount = db.get('tenants').filter({ propertyId: tenant.propertyId, adminId: req.admin.id }).value().length;
        if (maxUnits > 0 && currentCount >= maxUnits) {
            return res.status(400).json({ success: false, error: `This property is at full capacity (${maxUnits} unit${maxUnits !== 1 ? 's' : ''}). Add more units in Property settings first.` });
        }
    }
}
```

**Step 2: Add capacity check to PUT /api/tenants/:unit in server.js**

If `propertyId` is changing, check capacity of the NEW property:
```javascript
if (updates.propertyId) {
    const property = db.get('properties').find({ id: updates.propertyId, adminId: req.admin.id }).value();
    if (property) {
        const maxUnits = parseInt(property.units) || 0;
        // Count tenants in new property EXCLUDING current tenant (they don't count against themselves)
        const currentCount = db.get('tenants')
            .filter(t => t.propertyId === updates.propertyId && t.adminId === req.admin.id && t.unit !== unit)
            .value().length;
        if (maxUnits > 0 && currentCount >= maxUnits) {
            return res.status(400).json({ success: false, error: `Target property is at full capacity (${maxUnits} units).` });
        }
    }
}
```

**Step 3: Show occupancy in property cards (dashboard.html + dashboard.js)**

In `renderPropertiesGrid` (dashboard.js ~line 761), inside each property card, show:
```javascript
const occupancy = tenants.filter(t => String(t.propertyId) === String(p.id)).length;
const maxUnits = parseInt(p.units) || 0;
// Add to card: `${occupancy}/${maxUnits} occupied`
```

Pass `tenants` to the render function (it's available in the refresh closure as `window.tenantData`).

**Step 4: Commit**
```bash
git add src/server.js public/js/dashboard.js
git commit -m "feat: enforce property unit capacity when adding/moving tenants"
```

---

### Task 4: Dashboard — Add "Pending Verification" card

**Goal:** Show a card beside "Overdue Payments" with count of unverified payment receipts. Clicking navigates to Financials.

**Files:**
- Modify: `dashboard.html` (Row 2 grid, ~line 1144)
- Modify: `public/js/dashboard.js` (refreshDashboard, ~line 1088)

**Step 1: Add card HTML in dashboard.html Row 2**

The Row 2 grid (`grid-template-columns: repeat(auto-fit, minmax(400px, 1fr))`) currently has only 1 card (Overdue Payments). Add a second card:

```html
<!-- Pending Verification Card -->
<div class="card" style="padding: 24px; min-height: 200px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 30px; height: 30px; border-radius: 8px; background: rgba(245, 158, 11, 0.1); color: var(--warning); display: flex; align-items: center; justify-content: center;">
                <i class="fas fa-clock"></i>
            </div>
            <span style="font-weight: 600; font-size: 1.1rem;">Pending Verification</span>
        </div>
        <div id="dash-pending-verif-pill" class="status-pill pill-warning" style="display: none;">0 Pending</div>
    </div>
    <div id="dash-pending-verif-list" style="overflow-x: auto;">
        <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">
            No pending verifications.
        </div>
    </div>
    <div style="margin-top: 16px; text-align: right;">
        <a href="#" onclick="showSection('finance', document.querySelectorAll('.nav-item')[3]); window.scrollTo(0,0); return false;" style="color: var(--primary); font-size: 0.85rem; text-decoration: none; font-weight: 500;">
            Go to Financials <i class="fas fa-arrow-right" style="font-size: 0.75rem;"></i>
        </a>
    </div>
</div>
```

**Step 2: Populate the card in dashboard.js refreshDashboard**

After line 1088 (`const pendingPayments = payments.filter(p => p.status !== 'verified');`):
```javascript
// Pending Verification card
const pendVerifPill = document.getElementById('dash-pending-verif-pill');
const pendVerifList = document.getElementById('dash-pending-verif-list');
if (pendVerifPill) {
    pendVerifPill.innerText = `${pendingPayments.length} Pending`;
    pendVerifPill.style.display = pendingPayments.length > 0 ? 'inline-block' : 'none';
}
if (pendVerifList) {
    if (pendingPayments.length === 0) {
        pendVerifList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">No pending verifications.</div>';
    } else {
        // Show latest 3 pending payments as mini rows
        const recent = pendingPayments.slice().sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 3);
        pendVerifList.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
            ${recent.map(p => {
                const t = tenants.find(ten => ten.unit === p.unit) || { name: 'Unknown' };
                return `<tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding:8px 4px; font-weight:500;">${esc(t.name)}</td>
                    <td style="padding:8px 4px; color:var(--text-muted);">Unit ${esc(p.unit)}</td>
                    <td style="padding:8px 4px; text-align:right; color:var(--warning); font-weight:600;">${currencySymbol}${Number(p.amount||0).toLocaleString()}</td>
                </tr>`;
            }).join('')}
        </table>
        ${pendingPayments.length > 3 ? `<div style="text-align:center; padding: 8px; color:var(--text-muted); font-size:0.8rem;">+${pendingPayments.length - 3} more</div>` : ''}`;
    }
}
```

**Note:** `currencySymbol` and `tenants` and `esc` are already in scope at that point in `refreshDashboard`.

**Step 3: Commit**
```bash
git add dashboard.html public/js/dashboard.js
git commit -m "feat: add pending verification card to dashboard"
```

---

### Task 5: Fix Fixer notification (must use numeric Telegram ID)

**Root cause:** Telegram bot API cannot send to personal usernames like `@noelferrer`. Only numeric IDs work.

**Files:**
- Modify: `src/bot.js` (add `/myid` command)
- Modify: `src/server.js` (validate fixer_id is numeric before forwarding)
- Modify: `dashboard.html` (update Settings label and hint text)

**Step 1: Add /myid command to bot.js**

In `src/bot.js`, find where other bot commands are registered and add:
```javascript
bot.command('myid', (ctx) => {
    ctx.reply(`Your Telegram numeric Chat ID is:\n\n\`${ctx.from.id}\`\n\nCopy this number into the Fixer Chat ID field in LandlordHQ Settings.`, { parse_mode: 'Markdown' });
});
```

**Step 2: Strip @ and validate numeric in server.js forward endpoint**

In `src/server.js` POST `/api/tickets/:id/forward` (~line 685), after the `if (!settings.fixer_id)` check:
```javascript
// Normalize: strip leading @ if present, then validate numeric
const rawFixerId = String(settings.fixer_id).trim().replace(/^@/, '');
const fixerChatId = /^\d+$/.test(rawFixerId) ? parseInt(rawFixerId) : null;
if (!fixerChatId) {
    return res.status(400).json({ error: "Fixer Chat ID must be a numeric Telegram user ID (not a username). Have the fixer send /myid to the bot." });
}
```
Then replace all `settings.fixer_id` references in that endpoint with `fixerChatId`.

**Step 3: Update Settings UI in dashboard.html**

Find the Fixer Chat ID input (~line 1615):
- Change label to: `Fixer Telegram ID <span style="color:var(--text-muted); font-weight:400;">(numeric only)</span>`
- Change placeholder to: `e.g. 123456789`
- Add hint below input: `<p style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">Have your fixer send <code>/myid</code> to the bot to get their numeric ID.</p>`

**Step 4: Also strip @ when saving settings (server.js)**

In POST `/api/settings` (~line 734), after receiving body:
```javascript
if (req.body.fixer_id) {
    req.body.fixer_id = String(req.body.fixer_id).trim().replace(/^@/, '');
}
```

**Step 5: Commit**
```bash
git add src/bot.js src/server.js dashboard.html
git commit -m "fix: fixer chat ID must be numeric Telegram user ID, add /myid bot command"
```

---

### Task 6: Resolved Tickets — add pagination

**Current state:** All closed tickets rendered in a single table with no pagination. For large datasets this becomes unwieldy.

**Pattern to follow:** Properties and Tenants use `renderPagination(containerId, page, totalPages, callback)` with `ITEMS_PER_PAGE = 10`.

**Files:**
- Modify: `public/js/dashboard.js` (resolved ticket render, ~line 1286)
- Modify: `dashboard.html` (resolved tickets section, add pagination container)

**Step 1: Add state variable and pagination container in dashboard.js**

Near the top where `currentPropertiesPage`, `currentTenantsPage` are declared (~line 37), add:
```javascript
let currentResolvedPage = 1;
```

**Step 2: Replace the resolved table render with paginated version**

In the section that builds `closedTickets` and calls `renderResolvedRows` (~line 1288), replace the render call with:
```javascript
window._closedTickets = closedTickets;
window._tenants = tenants;
currentResolvedPage = 1; // reset to page 1 on data reload
renderResolvedTable();
```

**Step 3: Create renderResolvedTable() function**

```javascript
function renderResolvedTable() {
    const allClosed = window._closedTickets || [];
    const resolvedBody = document.getElementById('resolved-tickets-body');
    const resolvedSection = document.getElementById('resolved-tickets-section');
    if (!resolvedBody || !resolvedSection) return;

    if (allClosed.length === 0) {
        resolvedSection.style.display = 'none';
        return;
    }
    resolvedSection.style.display = 'block';

    const totalPages = Math.ceil(allClosed.length / ITEMS_PER_PAGE);
    if (currentResolvedPage > totalPages) currentResolvedPage = totalPages;
    const start = (currentResolvedPage - 1) * ITEMS_PER_PAGE;
    const pageData = allClosed.slice(start, start + ITEMS_PER_PAGE);

    resolvedBody.innerHTML = pageData.map(tk => {
        const tenant = (window._tenants || []).find(t => t.unit === tk.unit);
        const dt = tk.timestamp ? new Date(tk.timestamp) : null;
        const dateStr = dt ? dt.toLocaleDateString() : '-';
        const timeStr = dt ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const hasMedia = (tk.media && tk.media.length > 0) || tk.fileId;
        return `<tr>
            <td style="padding:10px 8px;">${dateStr}<br><span style="font-size:0.78rem;color:var(--text-muted);">${timeStr}</span></td>
            <td style="padding:10px 8px;">Unit ${esc(tk.unit)}</td>
            <td style="padding:10px 8px;">${esc(tenant?.name || tk.tenantName || '-')}</td>
            <td style="padding:10px 8px;">${esc(tk.issue || '-')}</td>
            <td style="padding:10px 8px; text-align:center;">${hasMedia
                ? `<span style="color:var(--primary); font-size:1.1rem;" title="Has attachment"><i class="fas fa-${tk.media?.[0]?.type === 'video' || tk.mediaType === 'video' ? 'video' : 'image'}"></i></span>`
                : '<span style="color:var(--text-muted);">—</span>'
            }</td>
        </tr>`;
    }).join('');

    renderPagination('resolved-pagination', currentResolvedPage, totalPages, (page) => {
        currentResolvedPage = page;
        renderResolvedTable();
    });
}
```

**Step 4: Add pagination container to dashboard.html resolved tickets section**

After the `</table>` closing tag in the resolved tickets section, add:
```html
<div id="resolved-pagination" style="margin-top: 16px;"></div>
```

**Step 5: Wire sortable headers to reset to page 1**

In `sortResolvedTickets()` function (~line 1352), after sorting `window._closedTickets`, add:
```javascript
currentResolvedPage = 1;
renderResolvedTable();
```

**Step 6: Commit**
```bash
git add public/js/dashboard.js dashboard.html
git commit -m "feat: add pagination to resolved tickets table"
```

---

### Task 7: Remove top search bar

**Files:**
- Modify: `dashboard.html` (remove search box from `.top-header-inner`)
- Modify: `public/js/dashboard.js` (remove search event listener)
- Modify: `dashboard.html` CSS (remove `.search-box` styles if desired)

**Step 1: Find and remove search HTML from top header**

In `dashboard.html`, find the `.top-header-inner` div (the top bar with clock). It contains a `<div class="search-box">` element. Remove that entire search-box div.

**Step 2: Remove search event listener in dashboard.js**

Search for `search-input` or `searchInput` in dashboard.js and remove/comment out the entire `addEventListener('input', ...)` block that handles search filtering.

**Step 3: Remove search CSS (optional — keeps CSS clean)**

In `dashboard.html` CSS section, find `.search-box` and `.search-box input` rules and remove them.

**Step 4: Commit**
```bash
git add dashboard.html public/js/dashboard.js
git commit -m "remove: top search bar"
```

---

### Task 8: Invite Engine — verify expired display in super.html

**Current backend state: ALREADY COMPLETE.** Investigation found:
- `/api/register` endpoint checks 24h expiry and marks as `expired` (server.js ~line 527)
- Hourly cron job marks all `active` invites older than 24h as `expired` (server.js ~line 1073)
- Rejected invites return error: "This invitation code has expired (valid for 24h)."

**Only needed:** Verify `super.html` UI shows "expired" status visually distinct from "active" and "claimed".

**Step 1: Check super.html invite list rendering**

Read `super.html` and find how invite status is displayed. Look for conditional rendering on `invite.status`.

**Step 2: If not styled, add visual differentiation**

In the invite list render, ensure:
- `active` → green/success pill
- `claimed` → blue/info pill
- `expired` → grey/muted pill (currently it may just show the raw string "expired")

Example:
```javascript
const statusColor = invite.status === 'claimed' ? '#22c55e' : invite.status === 'expired' ? '#9ca3af' : '#f59e0b';
```

**Step 3: Commit if changes made**
```bash
git add super.html
git commit -m "fix: show expired invite status clearly in super admin panel"
```

---

## Execution Order

| # | Task | Risk | Files |
|---|------|------|-------|
| 7 | Remove search bar | Very Low | dashboard.html, dashboard.js |
| 1 | Due Day visibility | Very Low | dashboard.html, dashboard.js |
| 4 | Pending Verification card | Low | dashboard.html, dashboard.js |
| 6 | Resolved Tickets pagination | Low | dashboard.html, dashboard.js |
| 2 | Fix ticket close | Medium | dashboard.js, server.js |
| 3 | Property capacity check | Medium | server.js |
| 5 | Fixer numeric ID fix | Medium | bot.js, server.js, dashboard.html |
| 8 | Invite expired display | Very Low | super.html |
