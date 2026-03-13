# UI Bug Fixes — 6-Item Batch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 reported UI/UX bugs in the LandlordHQ dashboard without breaking existing functionality.

**Architecture:** All fixes are isolated to `dashboard.html` and `public/js/dashboard.js`. No server changes needed. Each fix targets a specific element or function with minimal blast radius.

**Tech Stack:** Vanilla JS, HTML/CSS, lowdb (data already flowing correctly into the DB — these are display/wiring bugs only)

---

## Root Cause Audit

| # | Issue | Root Cause | File |
|---|-------|-----------|------|
| 1 | Financials missing /payment & /report reference | No contextual callout in finance-section or support-section | `dashboard.html` |
| 2 | Docs missing /unlink | Card never added to Tenant Commands grid | `dashboard.html` |
| 3 | Recent Support Done shows 5, should show 3 | `slice(0,5)` should be `slice(0,3)` | `dashboard.js` |
| 4 | Search bar broken | No handler for `finance-section`; no reset when query cleared | `dashboard.js` |
| 5 | Support Hub done tickets need a table | All tickets rendered as cards; no resolved table | `dashboard.html` + `dashboard.js` |
| 6 | Logout button shows white background | `<button>` gets browser default background; `.nav-item` has no `background:none` | `dashboard.html` CSS |

---

## Task 1: Fix Logout Button (white background)

**Files:**
- Modify: `dashboard.html` — CSS block around line 174 `.nav-item`

**Change:** Add `button.nav-item` reset rule immediately after `.sidebar-footer` block.

```css
button.nav-item {
    background: none;
    border: none;
    width: 100%;
    font: inherit;
    cursor: pointer;
}
```

**Safety check:** Only targets `<button>` elements with `.nav-item`. Existing `<div class="nav-item">` items are unaffected.

---

## Task 2: Fix Recent Support Done — 3 items max

**Files:**
- Modify: `public/js/dashboard.js` line ~1146

**Change:** Two occurrences of `recentResolvedTickets.slice(0, 5)` → `recentResolvedTickets.slice(0, 3)`. One in the `slice` call for table rows.

**Safety check:** Only the Recent Support Done dashboard card. The full Support Hub page is separate.

---

## Task 3: Add /unlink to Docs Page

**Files:**
- Modify: `dashboard.html` — Tenant Commands grid in `docs-section`

**Change:** Insert a new card after the `/link` card (teal, border-left: #14b8a6) with orange color (#f97316):

```html
<div class="card" style="border-left: 4px solid #f97316; padding: 20px;">
    <h4 style="margin-bottom: 12px; display: flex; align-items: center; gap: 10px;">
        <span style="background: rgba(249, 115, 22, 0.1); color: #f97316; padding: 6px 12px; border-radius: 8px; font-family: monospace; font-size: 1rem;">/unlink</span>
    </h4>
    <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 15px; line-height: 1.5;">Disconnects the tenant's Telegram account from their unit. Useful when moving out or switching devices. After unlinking, the tenant must use <code>/link</code> again with a new code to reconnect.</p>
    <div style="background: var(--bg); border: 1px solid var(--border); padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: 0.9rem; color: var(--secondary);">
        <i class="fas fa-terminal" style="color: var(--text-muted); margin-right: 8px;"></i>/unlink
    </div>
</div>
```

**Safety check:** Purely additive HTML to a static docs grid. No JS touched.

---

## Task 4: Add Telegram command callouts to Finance Hub & Support Hub

**Files:**
- Modify: `dashboard.html` — `finance-section` and `support-section`

**Finance Hub change:** Add an info strip at the very top of `finance-section`, before the summary cards row:

```html
<div style="background: rgba(43, 122, 255, 0.06); border: 1px solid rgba(43, 122, 255, 0.2); border-radius: 12px; padding: 12px 18px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px; font-size: 0.88rem; color: var(--text-muted);">
    <i class="fas fa-telegram-plane" style="color: var(--primary); font-size: 1.1rem;"></i>
    <span>Tenant payment receipts arrive here via the <code style="background: rgba(43,122,255,0.1); padding: 1px 5px; border-radius: 4px; color: var(--primary);">/payment</code> Telegram command. Pending receipts appear in <strong>Pending Verifications</strong> above for your review.</span>
</div>
```

**Support Hub change:** Add a similar info strip at the very top of `support-section`, before the tickets grid:

```html
<div style="background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; padding: 12px 18px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px; font-size: 0.88rem; color: var(--text-muted);">
    <i class="fas fa-telegram-plane" style="color: var(--danger); font-size: 1.1rem;"></i>
    <span>Maintenance tickets arrive here when tenants send <code style="background: rgba(239,68,68,0.08); padding: 1px 5px; border-radius: 4px; color: var(--danger);">/report &lt;Issue&gt;</code> or attach a photo with <code style="background: rgba(239,68,68,0.08); padding: 1px 5px; border-radius: 4px; color: var(--danger);">/report</code> in the caption on Telegram.</span>
</div>
```

**Safety check:** Purely additive HTML. No JS or data flow touched.

---

## Task 5: Support Hub — Resolved tickets as a table

**Files:**
- Modify: `dashboard.html` — `support-section`, add a resolved tickets table placeholder
- Modify: `public/js/dashboard.js` — ticket rendering block (~line 1199)

### 5a: HTML — Add resolved table container in `support-section`

After the `tickets-list` grid div, add:

```html
<div id="resolved-tickets-section" style="margin-top: 32px; display: none;">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
        <i class="fas fa-check-circle" style="color: var(--success);"></i>
        <h3 style="font-size: 1rem; font-weight: 600; color: var(--text-main);">Resolved Tickets</h3>
    </div>
    <div class="card" style="padding: 0; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
            <thead>
                <tr style="border-bottom: 2px solid var(--border); background: var(--bg);">
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted); white-space: nowrap;">Date / Time</th>
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted);">Unit</th>
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted);">Tenant</th>
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted);">Issue</th>
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted); white-space: nowrap;">Fixer Notified</th>
                    <th style="padding: 14px 16px; font-weight: 600; color: var(--text-muted);">Status</th>
                </tr>
            </thead>
            <tbody id="resolved-tickets-body"></tbody>
        </table>
    </div>
</div>
```

### 5b: JS — Split ticket rendering into open (cards) + closed (table)

Replace the current ticket rendering block in `refreshDashboard()` (the block that populates `#tickets-list`) with:

```javascript
const tickGrid = document.getElementById('tickets-list');
const resolvedSection = document.getElementById('resolved-tickets-section');
const resolvedBody = document.getElementById('resolved-tickets-body');

if (tickGrid) {
    const openTickets = tickets.filter(tk => tk.status !== 'closed');
    const closedTickets = tickets.filter(tk => tk.status === 'closed').sort((a, b) => b.timestamp - a.timestamp);

    // --- Open tickets: card grid (existing layout) ---
    tickGrid.innerHTML = openTickets.length > 0
        ? ''
        : '<p style="color:var(--text-muted); grid-column: 1/-1; text-align: center; padding: 40px;">No active support tickets.</p>';

    openTickets.forEach(tk => {
        const t = tenants.find(ten => String(ten.unit) === String(tk.unit)) || { name: 'Unknown' };
        tickGrid.innerHTML += `
        <div class="card">
            <div class="card-body">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                    <div class="unit-number">UNIT ${tk.unit}</div>
                    <span class="status-pill pill-danger">Open</span>
                </div>
                <div class="card-title">${esc(t.name)}</div>
                <div class="card-meta"><i class="fas fa-clock"></i> ${new Date(tk.timestamp).toLocaleString()}</div>
                <p style="font-size:0.95rem; line-height:1.6; color:var(--text-main); margin-bottom:20px;">${tk.issue}</p>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    ${tk.media && tk.media.length > 0 ? tk.media.map(m => renderMedia(m.fileId, m.type)).join('') : (tk.fileId ? renderMedia(tk.fileId, tk.mediaType || 'photo') : '')}
                </div>
                <div class="ticket-checklist" style="margin-top: 15px; border-top: 1px solid var(--border-color); padding-top: 15px;">
                    <label style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px; cursor: pointer; color: var(--text-main);">
                        <input type="checkbox" id="chk-rep-${tk.id}" ${tk.reported ? 'checked' : ''} onchange="handleTicketCheck(this, '${tk.id}', 'reported')" style="width: 18px; height: 18px; cursor: pointer;">
                        Reported to Fixer
                    </label>
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-main);">
                        <input type="checkbox" id="chk-res-${tk.id}" onchange="handleTicketCheck(this, '${tk.id}', 'status')" style="width: 18px; height: 18px; cursor: pointer;">
                        Issue Resolved (Done)
                    </label>
                </div>
            </div>
        </div>`;
    });

    // --- Closed tickets: resolved table ---
    if (resolvedSection && resolvedBody) {
        if (closedTickets.length === 0) {
            resolvedSection.style.display = 'none';
        } else {
            resolvedSection.style.display = 'block';
            resolvedBody.innerHTML = closedTickets.map(tk => {
                const t = tenants.find(ten => String(ten.unit) === String(tk.unit)) || { name: 'Unknown' };
                const date = new Date(tk.timestamp);
                return `
                <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding: 12px 16px; color: var(--text-muted); white-space: nowrap;">
                        <div style="font-weight: 500; color: var(--text-main);">${date.toLocaleDateString()}</div>
                        <div style="font-size: 0.78rem;">${date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                    </td>
                    <td style="padding: 12px 16px; font-weight: 600;">Unit ${esc(tk.unit)}</td>
                    <td style="padding: 12px 16px;">${esc(t.name)}</td>
                    <td style="padding: 12px 16px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(tk.issue)}">${esc(tk.issue)}</td>
                    <td style="padding: 12px 16px; text-align: center;">
                        ${tk.reported
                            ? '<span style="color: var(--success);"><i class="fas fa-check"></i> Yes</span>'
                            : '<span style="color: var(--text-muted);">—</span>'}
                    </td>
                    <td style="padding: 12px 16px;">
                        <span class="status-pill pill-success" style="font-size: 0.78rem;"><i class="fas fa-check-circle"></i> Resolved</span>
                    </td>
                </tr>`;
            }).join('');
        }
    }
}
```

**Safety check:**
- Open ticket cards retain ALL existing functionality (checkboxes, media, handleTicketCheck)
- Closed tickets are display-only rows (no editing on resolved items — consistent with the existing `opacity: 0.5; pointer-events: none` pattern)
- The `resolved-tickets-section` hides itself when there are no closed tickets (no empty state clutter)
- Search in `support-section` already searches `#tickets-list .card` (open ones); extend it to also search `#resolved-tickets-body tr` in Task 6

---

## Task 6: Fix Search Bar — add Finance Hub + reset behavior

**Files:**
- Modify: `public/js/dashboard.js` — search event listener (~line 1409)

**Change:** Replace the existing search handler with an expanded version:

```javascript
document.getElementById('global-search').addEventListener('input', function(e) {
    const query = e.target.value.toLowerCase();
    const activeSection = document.querySelector('.content-section.active')?.id;

    // Helper: reset visibility of a NodeList
    const showAll = (selector) => document.querySelectorAll(selector).forEach(el => el.style.display = '');
    const filter = (selector, display = '') =>
        document.querySelectorAll(selector).forEach(el => {
            el.style.display = el.innerText.toLowerCase().includes(query) ? display : 'none';
        });

    if (activeSection === 'properties-section') {
        if (!query) { showAll('#properties-grid .card'); return; }
        filter('#properties-grid .card', 'block');

    } else if (activeSection === 'tenants-section') {
        if (!query) { showAll('#tenants-table-body tr'); return; }
        filter('#tenants-table-body tr', '');

    } else if (activeSection === 'support-section') {
        if (!query) {
            showAll('#tickets-list .card');
            showAll('#resolved-tickets-body tr');
            return;
        }
        filter('#tickets-list .card', 'block');
        filter('#resolved-tickets-body tr', '');

    } else if (activeSection === 'finance-section') {
        if (!query) {
            showAll('#payments-history-body tr');
            showAll('#expenses-body tr');
            showAll('#finance-upcoming-body tr');
            return;
        }
        filter('#payments-history-body tr', '');
        filter('#expenses-body tr', '');
        filter('#finance-upcoming-body tr', '');
    }
});
```

**Safety check:**
- Uses `?.id` safe navigation (won't throw if no active section)
- Reset (empty query) explicitly restores display — prevents stuck-hidden-rows bug on polling refresh
- Finance section searches all 3 tables (upcoming, history, expenses) simultaneously
- Support section now also searches resolved tickets table
- Existing properties/tenants behavior identical (just extracted to helpers)

---

## Execution Order (safest sequence)

1. Task 1 (CSS logout) — isolated, 0 risk
2. Task 2 (Recent support 3) — one-char change
3. Task 3 (Docs /unlink) — additive HTML only
4. Task 4 (Telegram callouts) — additive HTML only
5. Task 5 (Support resolved table) — split render logic, test open/close ticket flow
6. Task 6 (Search bar) — depends on Task 5's `#resolved-tickets-body` existing first
