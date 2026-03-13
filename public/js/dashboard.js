        // Security: Redirect to login if unauthenticated (cookie-based)
        fetch('/api/auth/check', { credentials: 'include' })
            .then(r => { if (!r.ok) window.location.replace('/login'); })
            .catch(() => window.location.replace('/login'));

        // Logout handler
        function logout() {
            fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
                .finally(() => window.location.replace('/login'));
        }
        const API_URL = '/api';

        // --- CSRF Helper: read token from cookie, attach to state-changing requests ---
        function getCsrfToken() {
            const match = document.cookie.match(/(?:^|;\s*)landlordhq_csrf=([^;]+)/);
            return match ? match[1] : '';
        }
        function csrfHeaders() {
            return { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() };
        }

        // --- XSS Sanitizer: use esc() on ALL dynamic values in innerHTML ---
        function esc(str) {
            if (str === null || str === undefined) return '';
            const div = document.createElement('div');
            div.textContent = String(str);
            return div.innerHTML;
        }


        // --- Global State & Pagination ---
        window.tenantData = [];
        window.propertyData = [];
        window.appSettings = {};
        
        const ITEMS_PER_PAGE = 10;
        let currentPropertiesPage = 1;
        let currentTenantsPage = 1;
        let currentLogsPage = 1;
        let currentResolvedPage = 1;
        let currentHistoryPage = 1;
        let currentExpensePage = 1;
        // Cached sorted arrays for paginated finance tables
        window._sortedHistory = [];
        window._sortedExpenses = [];

        // --- Navigation ---
        function showSection(id, el) {
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById(`${id}-section`).classList.add('active');
            

            document.querySelectorAll('.nav-item').forEach(i => {
                i.classList.remove('active');
                i.removeAttribute('aria-current');
            });
            if (el) {
                el.classList.add('active');
                el.setAttribute('aria-current', 'page');
            }

            const titles = {
                dashboard: { i: 'fas fa-th-large', t: 'Dashboard', st: 'Real-time unit pulse and occupancy grid' },
                properties: { i: 'fas fa-building', t: 'Properties', st: 'Building-level management and oversight' },
                'property-detail': { i: 'fas fa-building', t: 'Property Details', st: 'Portfolio in-depth view' },
                tenants: { i: 'fas fa-user-friends', t: 'Tenants', st: 'Manage all tenant records' },
                support: { t: 'Support Hub', st: 'Manage tenant tickets and maintenance requests', i: 'fas fa-headset' },
                finance: { t: 'Financial Hub', st: 'Real-time revenue, expenses, and transaction logs', i: 'fas fa-chart-pie' },
                settings: { i: 'fas fa-cog', t: 'System Configuration', st: 'Customize reminder logic and bot behavior' },
                docs: { i: 'fas fa-book', t: 'Command Documentation', st: 'Reference guide for available Telegram tenant commands' },
                logs: { i: 'fas fa-history', t: 'Activity Logs', st: 'Full audit trail of administrative actions' }
            };

            const headerIcon = document.getElementById('page-title-icon');
            if (headerIcon && titles[id].i) headerIcon.className = titles[id].i;
            document.getElementById('page-title-text').innerText = titles[id].t;
            document.getElementById('page-subtitle-text').innerText = titles[id].st;

            const headerTools = document.querySelector('.header-tools');
            if (id === 'properties') {
                headerTools.innerHTML = `<button class="btn btn-primary" style="width: auto;" onclick="openAddPropertyModal()"><i class="fas fa-plus"></i> Add Property</button>`;
            } else if (id === 'tenants') {
                headerTools.innerHTML = `<button class="btn btn-primary" style="width: auto;" onclick="openAddTenantModal()"><i class="fas fa-plus"></i> Add Tenant</button>`;
            } else if (id === 'finance') {
                headerTools.innerHTML = `
                    <div style="display: flex; gap: 10px;">
                        <button class="btn btn-outline" style="width: auto;" onclick="openExpenseModal()"><i class="fas fa-receipt"></i> Add Expense</button>
                        <button class="btn btn-primary" style="width: auto;" onclick="openManualPaymentModal()"><i class="fas fa-plus"></i> Manual Payment</button>
                    </div>
                `;
            } else {
                headerTools.innerHTML = '';
            }

            if (id === 'properties') refreshProperties();
            if (id === 'tenants') refreshTenants();
            if (id === 'finance') {
                refreshFinanceHub();
                refreshDashboard();
            }
            if (id === 'logs') refreshLogs();
            if (id === 'dashboard' || id === 'support') refreshDashboard();
        }

        // --- Lightbox with Zoom & Pan ---
        let currentScale = 1;
        let isDragging = false;
        let startX, startY;
        let translateX = 0, translateY = 0;
        let activeMedia = null;

        function openLightbox(type, src) {
            const el = document.getElementById('lightbox-content');
            const controls = document.getElementById('lightbox-controls');
            currentScale = 1;
            translateX = 0;
            translateY = 0;
            
            if (type === 'photo') {
                el.innerHTML = `<img id="zoom-img" src="${src}" alt="Full size" style="transform: translate(0px, 0px) scale(1);">`;
                activeMedia = document.getElementById('zoom-img');
                controls.style.display = 'flex';
                setupDragAndDrop();
            } else {
                el.innerHTML = `<video src="${src}" controls autoplay style="max-width:90vw; max-height:90vh; border-radius:12px;"></video>`;
                activeMedia = null;
                controls.style.display = 'none';
            }
            document.getElementById('lightbox').style.display = 'flex';
        }

        function zoomMedia(delta) {
            if (!activeMedia) return;
            currentScale += delta;
            if (currentScale < 0.5) currentScale = 0.5;
            if (currentScale > 5) currentScale = 5;
            updateMediaTransform();
        }

        function resetZoom() {
            if (!activeMedia) return;
            currentScale = 1;
            translateX = 0;
            translateY = 0;
            updateMediaTransform();
        }

        function updateMediaTransform() {
            if (activeMedia) {
                activeMedia.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
            }
        }

        function setupDragAndDrop() {
            if(!activeMedia) return;
            
            // Mouse Wheel Zoom
            activeMedia.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                zoomMedia(delta);
            }, { passive: false });

            // Drag Panning
            activeMedia.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return; // Left click only
                isDragging = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                activeMedia.style.cursor = 'grabbing';
            });

            // Global listeners for dragging to handle mouse leaving the image
            if (!window._lightboxEventsAdded) {
                window.addEventListener('mousemove', (e) => {
                    if (!isDragging || !activeMedia) return;
                    e.preventDefault();
                    translateX = e.clientX - startX;
                    translateY = e.clientY - startY;
                    updateMediaTransform();
                });

                window.addEventListener('mouseup', () => {
                    isDragging = false;
                    if (activeMedia) activeMedia.style.cursor = 'grab';
                });
                window._lightboxEventsAdded = true;
            }
        }


        function closeLightbox() {
            document.getElementById('lightbox').style.display = 'none';
            document.getElementById('lightbox-content').innerHTML = '';
            document.getElementById('lightbox-controls').style.display = 'none';
            activeMedia = null;
        }

        // --- Properties Management ---
        function openAddPropertyModal() {
            document.getElementById('modal-title').innerText = 'Add Property';
            document.getElementById('modal-subtitle').innerText = 'Fill in the details to add a new property.';
            document.getElementById('submit-btn').innerText = 'Create Property';
            document.getElementById('prop-id').value = '';
            document.getElementById('property-form').reset();
            document.getElementById('property-modal').style.display = 'flex';
        }

        function closePropertyModal() {
            document.getElementById('property-modal').style.display = 'none';
        }

        // --- Tenants Management ---
        async function openAddTenantModal() {
            document.getElementById('tenant-modal-title').innerText = 'Add Tenant';
            document.getElementById('tenant-submit-btn').innerText = 'Add Tenant';
            document.getElementById('tenant-original-unit').value = '';
            document.getElementById('tenant-form').reset();

            try {
                const [propRes, tenRes] = await Promise.all([
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { credentials: 'include' })
                ]);
                const properties = await propRes.json();
                const tenants = await tenRes.json();
                const select = document.getElementById('tenant-property');
                select.innerHTML = properties.map(p => {
                    const maxUnits = parseInt(p.units) || 0;
                    const occupied = tenants.filter(t => String(t.propertyId) === String(p.id)).length;
                    const isFull = maxUnits > 0 && occupied >= maxUnits;
                    return `<option value="${p.id}" ${isFull ? 'disabled' : ''}>${esc(p.name)}${isFull ? ' (Full)' : ''}${maxUnits > 0 ? ` — ${occupied}/${maxUnits}` : ''}</option>`;
                }).join('');
                // If the first option is disabled, find first non-disabled
                const firstEnabled = select.querySelector('option:not([disabled])');
                if (firstEnabled) firstEnabled.selected = true;
            } catch (e) {
                console.error('Failed to load properties for dropdown', e);
            }

            document.getElementById('tenant-modal').style.display = 'flex';
        }

        function closeTenantModal() {
            document.getElementById('tenant-modal').style.display = 'none';
        }

        document.getElementById('tenant-form').onsubmit = async (e) => {
            e.preventDefault();
            const originalUnit = document.getElementById('tenant-original-unit').value;
            const unit = document.getElementById('tenant-unit').value;

            const data = {
                unit: unit,
                name: `${document.getElementById('tenant-fname').value} ${document.getElementById('tenant-lname').value}`.trim(),
                email: document.getElementById('tenant-email').value,
                phone: document.getElementById('tenant-phone').value,
                propertyId: document.getElementById('tenant-property').value,
                status: document.getElementById('tenant-status').value,
                leaseAmount: document.getElementById('tenant-lease-amount').value,
                moveInDate: document.getElementById('tenant-move-in-date').value,
                advancePayment: document.getElementById('tenant-advance').value,
                securityDeposit: document.getElementById('tenant-deposit').value,
                leaseEndDate: document.getElementById('tenant-lease-end').value,
                remarks: document.getElementById('tenant-remarks').value,
                telegramId: null,
                rent_due_day: parseInt(document.getElementById('tenant-due-day').value) || 1
            };

            if (originalUnit) {
                try {
                    const existingRes = await fetch(`${API_URL}/tenants?t=${Date.now()}`, {
                        credentials: 'include'
                    });
                    const tenantsList = await existingRes.json();
                    const existingT = tenantsList.find(t => t.unit === originalUnit);
                    if (existingT && existingT.telegramId) data.telegramId = existingT.telegramId;
                    // Removed: if (existingT && existingT.rent_due_day) data.rent_due_day = existingT.rent_due_day;
                    // This was overwriting the new value from the form with the old value from the DB.

                    openConfirmModal('Save Changes', 'Are you sure you want to update this tenant?', 'info', async () => {
                        try {
                            const res = await fetch(`${API_URL}/tenants/${originalUnit}`, {
                                method: 'PUT', credentials: 'include',
                                headers: { 
                                    ...csrfHeaders(),
                                },
                                body: JSON.stringify(data)
                            });
                            if (res.ok) {
                                openConfirmModal('Updated!', 'Tenant details have been updated.', 'success');
                                closeTenantModal();
                                refreshTenants();
                                // If we're viewing a property detail, refresh it immediately
                                const activeSection = document.querySelector('.content-section.active');
                                if (activeSection && activeSection.id === 'property-detail-section' && window._currentDetailPropertyId) {
                                    showPropertyDetail(window._currentDetailPropertyId);
                                }
                            } else {
                                const err = await res.json();
                                openConfirmModal('Error', err.error || 'Failed to update tenant.', 'danger');
                            }
                        } catch (err) { console.error('Update error:', err); }
                    });
                } catch (e) { console.error(e); }
            } else {
                try {
                    const res = await fetch(`${API_URL}/tenants`, {
                        method: 'POST', credentials: 'include',
                        headers: { 
                            ...csrfHeaders(),
                        },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        openConfirmModal('Created!', 'Tenant has been added.', 'success');
                        closeTenantModal();
                        refreshTenants();
                    } else {
                        const err = await res.json();
                        openConfirmModal('Error', err.error || 'Failed to add tenant.', 'danger');
                    }
                } catch (err) { console.error('Create error:', err); }
            }
        };

        async function editTenant(unit) {
            try {
                const [tenantRes, propRes] = await Promise.all([
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { credentials: 'include' })
                ]);
                const tenants = await tenantRes.json();
                const properties = await propRes.json();

                const t = tenants.find(ten => ten.unit === unit);
                if (!t) return;

                document.getElementById('tenant-modal-title').innerText = 'Edit Tenant';
                document.getElementById('tenant-submit-btn').innerText = 'Save Changes';
                document.getElementById('tenant-original-unit').value = t.unit;

                const nameParts = (t.name || '').split(' ');
                document.getElementById('tenant-fname').value = nameParts[0] || '';
                document.getElementById('tenant-lname').value = nameParts.slice(1).join(' ') || '';

                document.getElementById('tenant-email').value = t.email || '';
                document.getElementById('tenant-phone').value = t.phone || '';
                document.getElementById('tenant-unit').value = t.unit || '';
                document.getElementById('tenant-status').value = t.status || 'Active';
                document.getElementById('tenant-due-day').value = t.rent_due_day || 1;
                document.getElementById('tenant-lease-amount').value = t.leaseAmount || '';
                document.getElementById('tenant-move-in-date').value = t.moveInDate || '';
                document.getElementById('tenant-advance').value = t.advancePayment || '';
                document.getElementById('tenant-deposit').value = t.securityDeposit || '';
                document.getElementById('tenant-lease-end').value = t.leaseEndDate || '';
                document.getElementById('tenant-remarks').value = t.remarks || '';

                const select = document.getElementById('tenant-property');
                select.innerHTML = properties.map(p => {
                    const isCurrent = String(p.id) === String(t.propertyId);
                    const maxUnits = parseInt(p.units) || 0;
                    // For edit: count tenants in that property excluding the tenant being edited
                    const occupied = tenants.filter(ten => String(ten.propertyId) === String(p.id) && ten.unit !== t.unit).length;
                    const isFull = !isCurrent && maxUnits > 0 && occupied >= maxUnits;
                    return `<option value="${p.id}" ${isCurrent ? 'selected' : ''} ${isFull ? 'disabled' : ''}>${esc(p.name)}${isFull ? ' (Full)' : ''}${maxUnits > 0 ? ` — ${occupied + (isCurrent ? 1 : 0)}/${maxUnits}` : ''}</option>`;
                }).join('');

                document.getElementById('tenant-modal').style.display = 'flex';
            } catch (err) { console.error('Edit tenant lookup error:', err); }
        }

        async function deleteTenant(unit) {
            openConfirmModal('Delete Tenant', 'Are you sure you want to remove this tenant?', 'danger', async () => {
                try {
                    const res = await fetch(`${API_URL}/tenants/${unit}`, { 
                        method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }
                    });
                    if (res.ok) {
                        openConfirmModal('Deleted!', 'Tenant has been removed.', 'success');
                        refreshTenants();
                    } else {
                        const err = await res.json();
                        openConfirmModal('Error', err.error || 'Failed to delete tenant.', 'danger');
                    }
                } catch (err) { console.error('Delete tenant error:', err); }

            });
        }


        async function changeLogsPage(delta) {
            currentLogsPage += delta;
            await refreshLogs(currentLogsPage);
        }

        async function refreshLogs(page = 1) {
            currentLogsPage = page;
            const res = await fetch(`${API_URL}/audit-log?page=${page}&limit=${ITEMS_PER_PAGE}`, { credentials: 'include' });
            if (!res.ok) return;
            const { data, total, page: p, totalPages } = await res.json();

            const tbody = document.getElementById('logs-table-body');
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px; color: var(--text-muted);">No logs found.</td></tr>';
            } else {
                tbody.innerHTML = data.map(log => {
                    const date = new Date(log.timestamp);
                    const actionClass = log.action === 'delete' ? 'text-danger' : log.action === 'create' ? 'text-success' : 'text-info';
                    const icon = log.action === 'delete' ? 'fa-trash' : log.action === 'create' ? 'fa-plus' : 'fa-edit';
                    
                    return `
                        <tr>
                            <td>
                                <div style="font-weight: 500;">${date.toLocaleDateString()}</div>
                                <div style="font-size: 0.75rem; color: var(--text-muted);">${date.toLocaleTimeString()}</div>
                            </td>
                            <td>
                                <span class="badge ${actionClass}" style="text-transform: capitalize;">
                                    <i class="fas ${icon}" style="margin-right: 4px;"></i> ${log.action}
                                </span>
                            </td>
                            <td>
                                <span style="font-family: var(--font-mono); font-size: 0.85rem; background: var(--off-white); padding: 2px 6px; border-radius: 4px;">${log.resource}</span>
                            </td>
                            <td>
                                <div style="font-size: 0.85rem; color: var(--text-main); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title='${JSON.stringify(log.details)}'>
                                    ${Object.entries(log.details).map(([k,v]) => `<strong>${k}</strong>: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            document.getElementById('logs-pagination-info').innerText = `Showing ${data.length} of ${total} logs`;
            document.getElementById('logs-prev-btn').disabled = (p <= 1);
            document.getElementById('logs-next-btn').disabled = (p >= totalPages);
        }

        async function refreshTenants() {
            try {
                const [tenantRes, propRes] = await Promise.all([
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { credentials: 'include' })
                ]);
                const tenants = await tenantRes.json();
                const properties = await propRes.json();

                // Store globally for sorting
                window.tenantData = tenants;
                window.propertyData = properties;
                renderTenantsTable();
            } catch (err) { console.error('Refresh tenants error:', err); }
        }

        let currentSort = { key: 'name', dir: 'asc' };

        function sortTenants(key) {
            if (currentSort.key === key) {
                currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.key = key;
                currentSort.dir = 'asc';
            }

            // Update icons
            document.querySelectorAll('.sort-icon').forEach(icon => {
                icon.className = 'fas fa-sort sort-icon';
            });
            const activeIcon = document.getElementById(`sort-${key}`);
            if (activeIcon) {
                activeIcon.className = currentSort.dir === 'asc' ? 'fas fa-sort-up sort-icon' : 'fas fa-sort-down sort-icon';
            }

            renderTenantsTable();
        }

        function renderTenantsTable() {
            const tbody = document.getElementById('tenants-table-body');
            if (!tbody || !window.tenantData) return;
            tbody.innerHTML = '';

            let sorted = [...window.tenantData];
            const dirMultiplier = currentSort.dir === 'asc' ? 1 : -1;

            sorted.sort((a, b) => {
                let valA = a[currentSort.key];
                let valB = b[currentSort.key];

                if (currentSort.key === 'propertyId') {
                    const pA = (window.propertyData || []).find(p => String(p.id) === String(a.propertyId));
                    const pB = (window.propertyData || []).find(p => String(p.id) === String(b.propertyId));
                    valA = pA ? pA.name.toLowerCase() : 'unassigned';
                    valB = pB ? pB.name.toLowerCase() : 'unassigned';
                } else if (currentSort.key === 'moveInDate') {
                    valA = valA ? new Date(valA).getTime() : 0;
                    valB = valB ? new Date(valB).getTime() : 0;
                } else {
                    valA = String(valA || '').toLowerCase();
                    valB = String(valB || '').toLowerCase();
                }

                if (valA < valB) return -1 * dirMultiplier;
                if (valA > valB) return 1 * dirMultiplier;
                return 0;
            });


            const totalPages = Math.ceil(sorted.length / ITEMS_PER_PAGE);
            if (currentTenantsPage > totalPages && totalPages > 0) currentTenantsPage = totalPages;
            
            const startIndex = (currentTenantsPage - 1) * ITEMS_PER_PAGE;
            const paginatedTenants = sorted.slice(startIndex, startIndex + ITEMS_PER_PAGE);

            paginatedTenants.forEach(t => {

                const prop = (window.propertyData || []).find(p => String(p.id) === String(t.propertyId)) || { name: 'Unassigned' };
                const statusClass = (t.status || 'Active') === 'Active' ? 'status-pill-success' : 'status-pill-inactive';

                tbody.innerHTML += `
                    <tr>
                        <td style="display: flex; align-items: center; gap: 10px;">
                            <div style="width: 32px; height: 32px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--text-muted);">
                                <i class="fas fa-user"></i>
                            </div>
                            <div style="font-weight: 500;">${esc(t.name)}</div>
                        </td>
                        <td style="color: var(--text-muted); font-size: 0.9rem;">${esc(t.email) || '-'}</td>
                        <td style="color: var(--text-muted); font-size: 0.9rem;">${esc(t.phone) || '-'}</td>
                        <td style="color: var(--text-muted); font-size: 0.9rem;">${esc(prop.name)}</td>
                        <td style="color: var(--text-muted); font-size: 0.9rem;">${t.moveInDate ? new Date(t.moveInDate).toLocaleDateString() : '-'}</td>
                        <td style="color: var(--text-muted); font-size: 0.9rem; text-align: center;">Day ${t.rent_due_day || 1}</td>
                        <td>
                            <span class="status-pill ${statusClass}" style="font-size: 0.75rem;">${t.status || 'Active'}</span>
                        </td>
                        <td>
                            ${t.telegramId
                        ? '<span style="color:var(--success); font-size: 0.85rem; font-weight:600;"><i class="fas fa-check-circle"></i> Linked</span>'
                        : `<span style="font-family:monospace; font-weight:bold; background:var(--bg); padding:4px 8px; border-radius:4px; font-size:0.9rem; color:var(--text); letter-spacing:1px; border: 1px solid var(--border);">${esc(t.linkCode) || '-'}</span>`
                    }
                        </td>
                        <td style="text-align: right;">
                            <button class="btn-outline" style="width: auto; height: 32px; padding: 0 12px; border: none; font-size: 0.9rem;" onclick="editTenant('${esc(t.unit)}')">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn-outline" style="width: 32px; height: 32px; padding: 0; border: none; color: var(--danger); font-size: 0.9rem;" onclick="deleteTenant('${esc(t.unit)}')">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </td>
                    </tr>
                `;

            });

            renderPagination('tenants-pagination', currentTenantsPage, totalPages, (page) => {
                currentTenantsPage = page;
                renderTenantsTable();
            });
        }


        // Pagination containers that should be centre-aligned (grid/table views)
        const CENTRE_ALIGNED_PAGINATION = new Set(['properties-pagination', 'tenants-pagination']);

        function renderPagination(containerId, currentPage, totalPages, onPageChange) {
            let container = document.getElementById(containerId);
            if (!container) {
                // If container doesn't exist, create it (e.g. at bottom of grid/table)
                const parentId = containerId === 'properties-pagination' ? 'properties-grid' : 'tenants-table-body';
                const parentElem = document.getElementById(parentId);
                if (parentElem) {
                    const wrap = document.createElement('div');
                    wrap.id = containerId;
                    wrap.style.width = '100%';
                    wrap.style.display = 'flex';
                    wrap.style.justifyContent = 'center';
                    wrap.style.padding = '20px 0';
                    wrap.style.gap = '10px';
                    if (parentId === 'properties-grid') {
                        parentElem.parentNode.appendChild(wrap);
                    } else if (parentId === 'tenants-table-body') {
                        parentElem.parentNode.parentNode.appendChild(wrap);
                    }
                    container = wrap;
                } else {
                    return;
                }
            }

            container.innerHTML = '';
            if (totalPages <= 1) return;

            // Right-align for card-based tables; centre for properties/tenants grid
            container.style.display = 'flex';
            container.style.gap = '8px';
            container.style.marginTop = '16px';
            if (CENTRE_ALIGNED_PAGINATION.has(containerId)) {
                container.style.justifyContent = 'center';
                container.style.padding = '20px 0';
            } else {
                container.style.justifyContent = 'flex-end';
                container.style.padding = '8px 0 0 0';
            }

            const createBtn = (text, page, disabled, active) => {
                const btn = document.createElement('button');
                btn.className = `btn btn-outline ${active ? 'active' : ''}`;
                btn.innerText = text;
                btn.style.width = 'auto';
                btn.style.padding = '8px 16px';
                if (disabled) {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    btn.style.cursor = 'not-allowed';
                } else {
                    btn.onclick = () => onPageChange(page);
                }
                if(active) {
                    btn.style.background = 'var(--primary)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'var(--primary)';
                }
                return btn;
            };

            container.appendChild(createBtn('Prev', currentPage - 1, currentPage === 1, false));
            
            for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
                    container.appendChild(createBtn(i, i, false, i === currentPage));
                } else if (i === currentPage - 2 || i === currentPage + 2) {
                    const dots = document.createElement('span');
                    dots.innerText = '...';
                    dots.style.padding = '8px';
                    container.appendChild(dots);
                }
            }

            container.appendChild(createBtn('Next', currentPage + 1, currentPage === totalPages, false));
        }

        // --- Custom Confirmation & Notification logic ---

        let confirmCallback = null;
        function openConfirmModal(title, msg, type, callback) {
            document.getElementById('confirm-title').innerText = title;
            document.getElementById('confirm-msg').innerText = msg;
            const icon = document.getElementById('confirm-icon');
            const btn = document.getElementById('confirm-btn');
            const cancelBtn = btn.previousElementSibling;

            cancelBtn.style.display = callback ? 'block' : 'none';
            btn.innerText = callback ? 'Proceed' : 'Close';

            if (type === 'danger') {
                icon.style.background = 'rgba(239, 68, 68, 0.1)';
                icon.style.color = 'var(--danger)';
                icon.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
                btn.style.background = 'var(--danger)';
                btn.style.color = '#fff';
            } else if (type === 'success') {
                icon.style.background = 'rgba(16, 185, 129, 0.1)';
                icon.style.color = '#10b981';
                icon.innerHTML = '<i class="fas fa-check-circle"></i>';
                btn.style.background = '#10b981';
                btn.style.color = '#fff';
            } else {
                icon.style.background = 'rgba(59, 130, 246, 0.1)';
                icon.style.color = '#3b82f6';
                icon.innerHTML = '<i class="fas fa-info-circle"></i>';
                btn.style.background = '#3b82f6';
                btn.style.color = '#fff';
            }

            confirmCallback = callback;
            document.getElementById('confirm-modal').style.display = 'flex';
        }

        function closeConfirmModal() {
            document.getElementById('confirm-modal').style.display = 'none';
        }

        document.getElementById('confirm-btn').onclick = () => {
            if (confirmCallback) confirmCallback();
            closeConfirmModal();
        };

        document.getElementById('property-form').onsubmit = async (e) => {
            e.preventDefault();
            const id = document.getElementById('prop-id').value;
            const data = {
                name: document.getElementById('prop-name').value,
                address: document.getElementById('prop-address').value,
                city: document.getElementById('prop-city').value,
                state: document.getElementById('prop-state').value,
                zip: document.getElementById('prop-zip').value,
                type: document.getElementById('prop-type').value,
                units: document.getElementById('prop-units').value,
                status: document.getElementById('prop-status').value,
                description: document.getElementById('prop-desc').value
            };

            if (id) {
                openConfirmModal('Save Changes', 'Are you sure you want to update this property?', 'info', async () => {
                    try {
                        const res = await fetch(`${API_URL}/properties/${id}`, {
                            method: 'PUT', credentials: 'include',
                            headers: { 
                                ...csrfHeaders(),
                            },
                            body: JSON.stringify(data)
                        });
                        if (res.ok) {
                            openConfirmModal('Updated!', 'Building details have been updated successfully.', 'success');
                            closePropertyModal();
                            showPropertyDetail(id);
                        } else {
                            const err = await res.json();
                            openConfirmModal('Error', err.error || 'Failed to update property.', 'danger');
                        }
                    } catch (err) { console.error('Update error:', err); }
                });
            } else {
                openConfirmModal('Create Property', 'Are you sure you want to add this new property?', 'info', async () => {
                    try {
                        const res = await fetch(`${API_URL}/properties`, {
                            method: 'POST', credentials: 'include',
                            headers: { 
                                ...csrfHeaders(),
                            },
                            body: JSON.stringify(data)
                        });
                        if (res.ok) {
                            openConfirmModal('Created!', 'Property has been added to your portfolio.', 'success');
                            closePropertyModal();
                            refreshProperties();
                        }
                    } catch (err) { console.error('Create error:', err); }
                });
            }
        };

        async function editProperty(id) {
            try {
                const res = await fetch(`${API_URL}/properties?t=${Date.now()}`, {
                    credentials: 'include'
                });
                const properties = await res.json();
                const p = properties.find(prop => prop.id == id);
                if (!p) return;

                document.getElementById('modal-title').innerText = 'Edit Property';
                document.getElementById('modal-subtitle').innerText = 'Update the details for this property.';
                document.getElementById('submit-btn').innerText = 'Update Property';

                document.getElementById('prop-id').value = p.id;
                document.getElementById('prop-name').value = p.name;
                document.getElementById('prop-address').value = p.address;
                document.getElementById('prop-city').value = p.city;
                document.getElementById('prop-state').value = p.state;
                document.getElementById('prop-zip').value = p.zip;
                document.getElementById('prop-type').value = p.type;
                document.getElementById('prop-units').value = p.units;
                document.getElementById('prop-status').value = p.status;
                document.getElementById('prop-desc').value = p.description || '';

                document.getElementById('property-modal').style.display = 'flex';
            } catch (err) { console.error('Edit lookup error:', err); }
        }

        async function deleteProperty(id) {
            openConfirmModal('Delete Property', 'Are you sure you want to delete this building? This action is permanent.', 'danger', async () => {
                try {
                    const res = await fetch(`${API_URL}/properties/${id}`, { 
                        method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }
                    });
                    if (res.ok) {
                        openConfirmModal('Deleted!', 'Building has been removed from the portfolio.', 'success');
                        showSection('properties');
                    } else {
                        const err = await res.json();
                        openConfirmModal('Error', err.error || 'Failed to delete property.', 'danger');
                    }
                } catch (err) { console.error('Delete error:', err); }

            });
        }



        function renderPropertiesGrid() {
            const grid = document.getElementById('properties-grid');
            if (!grid || !window.propertyData) return;
            grid.innerHTML = '';

            const totalPages = Math.ceil(window.propertyData.length / ITEMS_PER_PAGE);
            if (currentPropertiesPage > totalPages && totalPages > 0) currentPropertiesPage = totalPages;
            
            const startIndex = (currentPropertiesPage - 1) * ITEMS_PER_PAGE;
            const paginatedProperties = window.propertyData.slice(startIndex, startIndex + ITEMS_PER_PAGE);

            paginatedProperties.forEach(p => {
                const pTenants = (window.tenantData || []).filter(t => String(t.propertyId) === String(p.id));
                const tCount = pTenants.length;
                const maxUnits = parseInt(p.units) || 0;
                const isFull = maxUnits > 0 && tCount >= maxUnits;
                const occupancyColor = isFull ? 'var(--danger)' : tCount > 0 ? 'var(--success)' : 'var(--text-muted)';

                grid.innerHTML += `
                <div class="card" onclick="showPropertyDetail('${p.id}')" style="cursor: pointer;">
                    <!-- Card content same as before but truncated for python script insertion -->
                    <div class="card-body">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                            <div style="display:flex; align-items:center; gap:10px;">
                                <div style="width: 40px; height: 40px; border-radius: 10px; background: rgba(255,165,0,0.1); display: flex; align-items: center; justify-content: center; color: var(--primary);">
                                    <i class="fas fa-building"></i>
                                </div>
                                <h4 style="margin:0; font-size:1.1rem; font-weight:700;">${esc(p.name)}</h4>
                            </div>
                            <div style="display:flex; gap:8px;">
                                <span class="status-pill pill-info" style="font-size: 0.7rem;">${esc(p.type)}</span>
                                <span class="status-pill pill-success" style="font-size: 0.7rem;">${esc(p.status)}</span>
                            </div>
                        </div>
                        <div class="card-meta" style="margin-bottom:15px; font-size: 0.85rem;">
                            <i class="fas fa-map-marker-alt"></i> ${esc(p.address)}, ${esc(p.city)}, ${p.state} ${p.zip}
                        </div>
                        <div style="display:flex; gap:15px; border-top:1px solid var(--border); padding-top:15px; margin-top:15px; font-size: 0.8rem; color: var(--text-muted);">
                            <div style="display:flex; align-items:center; gap:5px;">
                                <i class="fas fa-door-open"></i> ${esc(p.units)} units
                            </div>
                            <div style="display:flex; align-items:center; gap:5px; color:${occupancyColor}; font-weight: ${isFull ? '600' : '400'};">
                                <i class="fas fa-user-friends"></i> ${tCount}/${maxUnits} occupied${isFull ? ' (Full)' : ''}
                            </div>
                        </div>
                    </div>
                </div>`;
            });

            renderPagination('properties-pagination', currentPropertiesPage, totalPages, (page) => {
                currentPropertiesPage = page;
                renderPropertiesGrid();

            });
        }


        async function refreshProperties() {
            try {
                const [propRes, tenantRes] = await Promise.all([
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { credentials: 'include' })
                ]);
                const properties = await propRes.json();
                const tenants = await tenantRes.json();

                window.propertyData = properties;
                window.tenantData = tenants;
                renderPropertiesGrid();
                // skipping old render loop

            } catch (err) { console.error('Refresh properties error:', err); }
        }

        async function showPropertyDetail(id) {
            window._currentDetailPropertyId = id; // remember for post-edit refresh
            try {
                const [propRes, tenantRes] = await Promise.all([
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { credentials: 'include' })
                ]);
                const properties = await propRes.json();
                const tenants = await tenantRes.json();

                const p = properties.find(prop => prop.id == id);
                if (!p) return;

                const pTenants = tenants.filter(t => String(t.propertyId) === String(p.id));
                const activeTenants = pTenants.length;
                const activeLeases = pTenants.length;

                showSection('property-detail');
                const content = document.getElementById('detail-content');

                content.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px;">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div>
                                <h2 style="font-size: 1.35rem; font-weight: 700; display: flex; align-items: center; gap: 10px; margin: 0;">
                                    ${esc(p.name)}
                                    <div style="display: flex; gap: 8px; margin-left: 10px;">
                                        <span class="status-pill pill-info" style="font-size: 0.75rem;">${esc(p.type)}</span>
                                        <span class="status-pill pill-success" style="font-size: 0.75rem;">${esc(p.status)}</span>
                                    </div>
                                </h2>
                            </div>
                        </div>
                        <div style="display: flex; gap: 12px;">
                            <button class="btn btn-outline" style="width: auto; border-radius: 10px;" onclick="editProperty('${p.id}')">
                                <i class="fas fa-edit"></i> Edit
                            </button>
                            <button class="btn" style="width: auto; border-radius: 10px; background: var(--danger); color: #fff;" onclick="deleteProperty('${p.id}')">
                                <i class="fas fa-trash-alt"></i> Delete
                            </button>
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 30px; margin-bottom: 24px;">
                        <div class="card" style="padding: 30px;">
                            <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 25px;">Property Details</h3>
                            <div style="display: flex; flex-direction: column; gap: 20px;">
                                <div style="display: flex; align-items: center; gap: 12px; color: var(--text-muted);">
                                    <i class="fas fa-map-marker-alt" style="width: 20px;"></i>
                                    <div>
                                        <div style="font-size: 0.95rem; color: var(--text-main); font-weight: 500;">${esc(p.address)}</div>
                                        <div style="font-size: 0.85rem;">${esc(p.city)}, ${p.state} ${p.zip}</div>
                                    </div>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; color: var(--text-muted);">
                                    <i class="fas fa-door-open" style="width: 20px;"></i>
                                    <div style="font-size: 0.95rem; color: var(--text-main); font-weight: 500;">${esc(p.units)} Units</div>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; color: var(--text-muted);">
                                    <i class="fas fa-calendar-alt" style="width: 20px;"></i>
                                    <div style="font-size: 0.95rem; color: var(--text-main); font-weight: 500;">Added ${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Unknown Date'}</div>
                                </div>
                                <div style="margin-top: 10px; padding: 15px; background: var(--bg); border-radius: 10px; border: 1px solid var(--border);">
                                    <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">${esc(p.description) || 'No description provided.'}</div>
                                </div>
                            </div>
                        </div>

                        <div style="display: flex; flex-direction: column; gap: 24px;">
                            <div class="card" style="padding: 24px; display: flex; align-items: center; gap: 20px;">
                                <div class="stat-icon-lg bg-info">
                                    <i class="fas fa-user-friends"></i>
                                </div>
                                <div>
                                    <div style="font-size: 1.5rem; font-weight: 800;">${activeTenants}</div>
                                    <div style="font-size: 0.85rem; color: var(--text-muted);">Active Tenant${activeTenants !== 1 ? 's' : ''}</div>
                                </div>
                            </div>
                            <div class="card" style="padding: 24px; display: flex; align-items: center; gap: 20px;">
                                <div class="stat-icon-lg bg-success">
                                    <i class="fas fa-door-open"></i>
                                </div>
                                <div>
                                    <div style="font-size: 1.5rem; font-weight: 800;">${activeTenants}/${parseInt(p.units) || 0}</div>
                                    <div style="font-size: 0.85rem; color: var(--text-muted);">Units Occupied</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Tenants in this Property -->
                    <div class="card" style="padding: 24px;">
                        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                            <div style="width: 28px; height: 28px; border-radius: 8px; background: rgba(43, 122, 255, 0.1); color: var(--primary); display: flex; align-items: center; justify-content: center; font-size: 0.85rem;">
                                <i class="fas fa-user-friends"></i>
                            </div>
                            <h3 style="font-size: 1rem; font-weight: 600; color: var(--text-main);">Tenants Leasing in This Property</h3>
                            <span class="status-pill pill-info" style="font-size: 0.75rem;">${pTenants.length} tenant${pTenants.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div style="overflow-x: auto;">
                            ${pTenants.length === 0 ? `
                                <div style="padding: 30px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">
                                    <i class="fas fa-user-slash" style="font-size: 1.5rem; margin-bottom: 10px; display: block; opacity: 0.4;"></i>
                                    No tenants assigned to this property.
                                </div>
                            ` : `
                                <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
                                    <thead>
                                        <tr>
                                            <th style="text-align: left;">Tenant</th>
                                            <th style="text-align: left;">Unit</th>
                                            <th style="text-align: left;">Lease Amount</th>
                                            <th style="text-align: left;">Move-in Date</th>
                                            <th style="text-align: left;">Due Day</th>
                                            <th style="text-align: left;">Status</th>
                                            <th style="text-align: right;"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${pTenants.map(t => {
                                            const currencySymbol = window.appSettings.currency || '₱';
                                            const statusClass = t.status === 'Active' ? 'pill-success' : 'pill-warning';
                                            const moveIn = t.moveInDate ? new Date(t.moveInDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
                                            return `
                                            <tr style="border-bottom: 1px solid var(--border);">
                                                <td style="padding: 12px 0; font-weight: 600;">${esc(t.name)}</td>
                                                <td style="padding: 12px 8px; color: var(--text-muted);">Unit ${esc(t.unit)}</td>
                                                <td style="padding: 12px 8px; font-weight: 600; color: var(--success); font-family: var(--font-mono);">
                                                    ${currencySymbol}${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                </td>
                                                <td style="padding: 12px 8px; color: var(--text-muted);">${moveIn}</td>
                                                <td style="padding: 12px 8px; color: var(--text-muted); text-align: center;">Day ${t.rent_due_day || 1}</td>
                                                <td style="padding: 12px 8px;">
                                                    <span class="status-pill ${statusClass}" style="font-size: 0.75rem;">${esc(t.status || 'Active')}</span>
                                                </td>
                                                <td style="padding: 12px 0; text-align: right;">
                                                    <button class="btn btn-outline" style="width: auto; padding: 5px 12px; font-size: 0.8rem; border-radius: 8px;" onclick="editTenant('${esc(t.unit)}')">
                                                        <i class="fas fa-edit"></i> Edit
                                                    </button>
                                                </td>
                                            </tr>`;
                                        }).join('')}
                                    </tbody>
                                </table>
                            `}
                        </div>
                    </div>
                `;
            } catch (err) { console.error('Show detail error:', err); }
        }

        // --- Helper: Render Media ---
        function renderMedia(fileId, mediaType) {
            const src = `${API_URL}/media/${fileId}`;
            return `
                <div class="media-container" onclick="openLightbox('${mediaType}', '${src}')">
                    <div class="media-type-badge"><i class="fas fa-${mediaType === 'video' ? 'video' : 'camera'}"></i> ${mediaType.toUpperCase()}</div>
                    ${mediaType === 'video' ? `<video src="${src}" muted preload="metadata"></video>` : `<img src="${src}" alt="Media" loading="lazy">`}
                </div>`;
        }

        // --- Data Refresh ---
        async function refreshDashboard() {
            try {
                const today = new Date();
                const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
                const fetchOpts = { credentials: 'include' };

                // Check auth first with a single request to avoid redirect loops
                const authCheck = await fetch(`${API_URL}/tenants`, fetchOpts);
                if (authCheck.status === 401) {
                    window.location.replace('/login');
                    return;
                }
                const rawTenants = await authCheck.json();

                const [rawTickets, rawPayments, rawSettings, rawProperties] = await Promise.all([
                    fetch(`${API_URL}/tickets`, fetchOpts).then(r => r.ok ? r.json() : []),
                    fetch(`${API_URL}/payments`, fetchOpts).then(r => r.ok ? r.json() : []),
                    fetch(`${API_URL}/settings`, fetchOpts).then(r => r.ok ? r.json() : {}),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, fetchOpts).then(r => r.ok ? r.json() : [])
                ]);

                // Defensive: ensure arrays are arrays, settings is an object
                const tenants = Array.isArray(rawTenants) ? rawTenants : [];
                const tickets = Array.isArray(rawTickets) ? rawTickets : [];
                const payments = Array.isArray(rawPayments) ? rawPayments : [];
                const settings = (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) ? rawSettings : {};
                const properties = Array.isArray(rawProperties) ? rawProperties : [];

                window.appSettings = settings;
                window.tenantData = tenants;
                window.propertyData = properties;

                // Update Stats
                const statProps = document.getElementById('dash-total-properties');
                const statTenants = document.getElementById('dash-total-tenants');
                const statLeases = document.getElementById('dash-active-leases');
                const statRevenue = document.getElementById('dash-monthly-revenue');

                if (statProps) statProps.innerText = properties.length;
                if (statTenants) statTenants.innerText = tenants.length;

                const activeLeases = tenants.filter(t => t.status !== 'Inactive').length;
                if (statLeases) statLeases.innerText = activeLeases;

                const verifiedPayments = payments.filter(p => p.status === 'verified');

                // Revenue based on actually verified payments for the current month only
                const currentMonthRevenuePayments = verifiedPayments.filter(p => new Date(p.timestamp).getTime() >= currentMonthStart);
                const totalRevenue = currentMonthRevenuePayments.reduce((acc, p) => acc + (parseFloat(p.amount) || 0), 0);
                const currencySymbol = settings.currency || '₱';
                if (statRevenue) statRevenue.innerText = `${currencySymbol}${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

                // Update Occupancy
                let totalUnits = 0;
                properties.forEach(p => totalUnits += parseInt(p.units || 1));
                const occupancyRate = totalUnits > 0 ? ((activeLeases / totalUnits) * 100).toFixed(1) : 0;

                const occText = document.getElementById('dash-occupancy-text');
                const occBar = document.getElementById('dash-occupancy-bar');
                if (occText) occText.innerText = `${occupancyRate}%`;
                if (occBar) occBar.style.width = `${occupancyRate}%`;

                // Filter Overdue Tenants
                const overdueTenants = tenants.filter(t => {
                    if (t.status === 'Inactive') return false;
                    const dueDay = t.rent_due_day || 1;
                    const gracePeriod = 1; // User requested 1 day past due date
                    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
                    const overdueThreshold = new Date(dueDate.getTime() + (gracePeriod * 24 * 60 * 60 * 1000));
                    
                    // Has this tenant paid for the current month?
                    const hasPaid = verifiedPayments.some(p => p.unit === t.unit && new Date(p.timestamp).getTime() >= currentMonthStart);
                    
                    // Is today past the overdue threshold?
                    return !hasPaid && today > overdueThreshold;
                });

                // Update Overdue Payments Stat
                const overduePill = document.getElementById('dash-overdue-count-pill');
                if (overduePill) {
                    overduePill.innerText = `${overdueTenants.length} Unpaid`;
                    overduePill.style.display = overdueTenants.length > 0 ? 'inline-block' : 'none';
                }

                // Render Overdue Payments List
                const overdueListContainer = document.getElementById('dash-overdue-list');
                if (overdueListContainer) {
                    if (overdueTenants.length === 0) {
                        overdueListContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">No overdue payments.</div>';
                    } else {
                        overdueListContainer.innerHTML = `
                            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                                <thead>
                                    <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted);">
                                        <th style="padding-bottom: 12px; font-weight: 600;">Tenant</th>
                                        <th style="padding-bottom: 12px; font-weight: 600;">Property</th>
                                        <th style="padding-bottom: 12px; font-weight: 600;">Due Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${overdueTenants.slice(0, 3).map(t => {
                                        const pName = t.propertyId ? ((properties.find(prop => String(prop.id) === String(t.propertyId)) || {}).name || 'Unassigned') : 'Unassigned';
                                        const dueDate = new Date(today.getFullYear(), today.getMonth(), t.rent_due_day || 1);
                                        return `
                                        <tr style="border-bottom: 1px solid var(--border);">
                                            <td style="padding: 10px 0; font-weight: 600;">${esc(t.name)}</td>
                                            <td style="padding: 10px 0; color: var(--text-muted);">${esc(pName)}</td>
                                            <td style="padding: 10px 0; color: var(--danger); font-weight: 600;">
                                                <i class="fas fa-exclamation-triangle"></i> ${dueDate.toLocaleDateString(undefined, {month:'short', day:'numeric'})}
                                            </td>
                                        </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `;
                    }
                }
                // Re-reading user request: "switch the position of recent payments and upcoming payments so that its uniform to view."
                // In Row 3: Upcoming is now Left, Recent is now Right.
                // Row 2: "Pending Payments" -> "Overdue Payments".
                
                // Render Recent Payments (Now on the Right side of Row 3)
                const recentBody = document.getElementById('dash-recent-payments');
                if (recentBody) {
                    const displayPayments = verifiedPayments.slice().sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
                    if (displayPayments.length === 0) {
                        recentBody.innerHTML = '<div style="flex:1;text-align:center;">No recent payments.</div>';
                        recentBody.style.display = 'flex';
                    } else {
                        recentBody.style.display = 'block';
                        recentBody.innerHTML = `
                            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                                <thead>
                                    <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted);">
                                        <th style="padding-bottom: 15px; font-weight: 600;">Tenant</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Property</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Amount</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${displayPayments.slice(0, 3).map(p => {
                                        const t = tenants.find(ten => String(ten.unit) === String(p.unit)) || { name: p.tenantName || 'Unknown' };
                                        const pName = t.propertyId ? ((properties.find(prop => String(prop.id) === String(t.propertyId)) || {}).name || 'Unassigned') : 'Unassigned';
                                        return `
                                         <tr style="border-bottom: 1px solid var(--border);">
                                            <td style="padding: 12px 0; font-weight: 600;">${esc(t.name)}</td>
                                            <td style="padding: 12px 0; color: var(--text-muted);">${esc(pName)}</td>
                                            <td style="padding: 12px 0; font-weight: 600; color: var(--success);">${currencySymbol}${(parseFloat(p.amount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                            <td style="padding: 12px 0; color: var(--text-muted);"><i class="far fa-calendar-alt"></i> ${new Date(p.timestamp).toLocaleDateString()}</td>
                                        </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `;
                    }
                }

                const pendingPayments = payments.filter(p => p.status !== 'verified');

                // Populate Pending Verification card
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
                        const recent3 = pendingPayments.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 3);
                        pendVerifList.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:0.88rem;">
                            <thead>
                                <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted);">
                                    <th style="padding-bottom: 10px; font-weight: 600;">Tenant</th>
                                    <th style="padding-bottom: 10px; font-weight: 600;">Unit</th>
                                    <th style="padding-bottom: 10px; font-weight: 600; text-align: right;">Submitted</th>
                                </tr>
                            </thead>
                            <tbody>
                            ${recent3.map(p => {
                                const pt = tenants.find(ten => ten.unit === p.unit) || { name: 'Unknown' };
                                const submittedDate = p.timestamp ? new Date(p.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
                                const submittedTime = p.timestamp ? new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                                return `<tr style="border-bottom: 1px solid var(--border);">
                                    <td style="padding:10px 4px; font-weight:600;">${esc(pt.name)}</td>
                                    <td style="padding:10px 4px; color:var(--text-muted);">Unit ${esc(p.unit)}</td>
                                    <td style="padding:10px 4px; text-align:right; color:var(--text-muted); font-size:0.82rem;">
                                        <div>${submittedDate}</div>
                                        <div style="color:var(--text-muted); opacity:0.7;">${submittedTime}</div>
                                    </td>
                                </tr>`;
                            }).join('')}
                            </tbody>
                        </table>
                        ${pendingPayments.length > 3 ? `<div style="text-align:center; padding:8px; color:var(--text-muted); font-size:0.8rem;">+${pendingPayments.length - 3} more pending</div>` : ''}`;
                    }
                }

                // Render Upcoming Payments (Now on the Left side of Row 3)
                const upcomingBody = document.getElementById('dash-upcoming-payments');
                if (upcomingBody) {
                    upcomingBody.innerHTML = '';
                    
                    // Logic: Show from the 11th. Exclude paid, Exclude overdue.
                    const isAfter11th = today.getDate() >= 11;
                    
                    let upcomingList = [];
                    if (isAfter11th) {
                        upcomingList = tenants.filter(t => {
                            if (t.status === 'Inactive') return false;
                            
                            // 1. Is overdue?
                            const isOverdue = overdueTenants.some(ot => ot.unit === t.unit);
                            if (isOverdue) return false;
                            
                            // 2. Has paid for current month?
                            const hasPaid = verifiedPayments.some(p => p.unit === t.unit && new Date(p.timestamp).getTime() >= currentMonthStart);
                            if (hasPaid) return false;
                            
                            return true;
                        });
                    }

                    if (!isAfter11th) {
                        upcomingBody.innerHTML = '<tr><td colspan="4" style="padding: 15px; text-align: center; color: var(--text-muted);">Upcoming payments will show starting on the 11th.</td></tr>';
                    } else if (upcomingList.length === 0) {
                        upcomingBody.innerHTML = '<tr><td colspan="4" style="padding: 15px; text-align: center; color: var(--text-muted);">No upcoming payments for this period.</td></tr>';
                    } else {
                        upcomingBody.innerHTML = upcomingList.slice(0, 3).map(t => {
                            const pName = (properties.find(p => String(p.id) === String(t.propertyId)) || {}).name || 'Unassigned';
                            const dueDate = new Date(today.getFullYear(), today.getMonth(), t.rent_due_day || 1);
                            return `
                            <tr style="border-bottom: 1px solid var(--border);">
                                <td style="padding: 12px 0; font-weight: 600;">${esc(t.name)}</td>
                                <td style="padding: 12px 0; color: var(--text-muted);">${esc(pName)}</td>
                                <td style="padding: 12px 0; font-weight: 600; color: var(--warning);">${currencySymbol}${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                <td style="padding: 12px 0;">
                                    <span class="status-pill pill-warning" style="font-size: 0.85rem;"><i class="fas fa-calendar-alt"></i> ${dueDate.toLocaleDateString()}</span>
                                </td>
                            </tr>
                            `;
                        }).join('');
                    }
                }

                // Render Support Overview (Dashboard)
                const pendingTickets = tickets.filter(tk => tk.status !== 'closed');
                const recentResolvedTickets = tickets.filter(tk => tk.status === 'closed').sort((a,b) => b.timestamp - a.timestamp);

                const dashPendingSupport = document.getElementById('dash-pending-support');
                if (dashPendingSupport) {
                    if (pendingTickets.length === 0) {
                        dashPendingSupport.innerHTML = '<div style="flex:1;text-align:center;">No pending support tickets.</div>';
                        dashPendingSupport.style.display = 'flex';
                    } else {
                        dashPendingSupport.style.display = 'block';
                        dashPendingSupport.innerHTML = `
                            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                                <thead>
                                    <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted);">
                                        <th style="padding-bottom: 15px; font-weight: 600;">Unit</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Issue</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${pendingTickets.slice(0, 3).map(tk => {
                                        return `
                                        <tr style="border-bottom: 1px solid var(--border);">
                                            <td style="padding: 12px 0; font-weight: 600;">Unit ${tk.unit}</td>
                                            <td style="padding: 12px 10px 12px 0; color: var(--text-main); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tk.issue}">${tk.issue}</td>
                                            <td style="padding: 12px 0; color: var(--text-muted);">${new Date(tk.timestamp).toLocaleDateString()}</td>
                                        </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `;
                    }
                }

                const dashRecentSupport = document.getElementById('dash-recent-support');
                if (dashRecentSupport) {
                    if (recentResolvedTickets.length === 0) {
                        dashRecentSupport.innerHTML = '<div style="flex:1;text-align:center;">No recently resolved tickets.</div>';
                        dashRecentSupport.style.display = 'flex';
                    } else {
                        dashRecentSupport.style.display = 'block';
                        dashRecentSupport.innerHTML = `
                            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                                <thead>
                                    <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted);">
                                        <th style="padding-bottom: 15px; font-weight: 600;">Unit</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Issue</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Date</th>
                                        <th style="padding-bottom: 15px; font-weight: 600;">Resolved</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${recentResolvedTickets.slice(0, 3).map(tk => {
                                        return `
                                        <tr style="border-bottom: 1px solid var(--border);">
                                            <td style="padding: 12px 0; font-weight: 600;">Unit ${tk.unit}</td>
                                            <td style="padding: 12px 10px 12px 0; color: var(--text-main); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tk.issue}">${tk.issue}</td>
                                            <td style="padding: 12px 0; color: var(--text-muted);"><i class="far fa-calendar-alt"></i> ${new Date(tk.timestamp).toLocaleDateString()}</td>
                                            <td style="padding: 12px 0; color: var(--text-muted);"><span class="status-pill pill-success" style="font-size: 0.75rem;"><i class="fas fa-check"></i> Done</span></td>
                                        </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `;
                    }
                }

                // --- Render Payments ---
                const payGrid = document.getElementById('payments-list');
                if (payGrid) {
                    payGrid.innerHTML = pendingPayments.length > 0 ? '' : '<p style="color:var(--text-muted); grid-column: 1/-1; text-align: center; padding: 40px;">No pending payments to verify.</p>';
                    pendingPayments.forEach(p => {
                        const t = tenants.find(ten => ten.unit === p.unit) || { name: 'Unknown' };
                        payGrid.innerHTML += `
                        <div class="card" style="height: 100%;">
                            <div class="card-body" style="height: 100%; display: flex; flex-direction: column; justify-content: space-between;">
                                <div>
                                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                                        <div style="display:flex; align-items:center; gap:10px;">
                                            <div class="stat-icon bg-success">
                                                <i class="fas fa-receipt"></i>
                                            </div>
                                            <h4 style="margin:0; font-size:1.1rem; font-weight:700;">UNIT ${esc(p.unit)}</h4>
                                        </div>
                                        <span class="status-pill pill-warning" style="font-size: 0.70rem;">Pending Review</span>
                                    </div>
                                    ${p.fileId ? `<div style="margin: 10px 0;">${renderMedia(p.fileId, p.mediaType || 'photo')}</div>` : ''}
                                    <div class="card-title" style="margin-bottom: 5px; font-size: 1.05rem;">${esc(t.name)}</div>
                                    <div class="card-meta" style="margin-bottom: 15px;"><i class="fas fa-clock"></i> Submitted: ${new Date(p.timestamp).toLocaleString()}</div>
                                </div>
                                <div style="display: flex; align-items: center; gap: 10px; margin-top: 20px;">
                                    <button class="btn btn-primary" style="flex: 1;" onclick="verifyPayment('${esc(p.unit)}', '${p.id || ''}')">
                                        <i class="fas fa-check-double"></i> Verify
                                    </button>
                                    <button style="background: transparent; border: none; color: var(--danger); font-size: 1.2rem; cursor: pointer; padding: 10px; transition: opacity 0.2s; outline: none;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'" onclick="deletePayment('${p.id}', '${esc(t.name)}')" title="Delete Payment">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </div>
                        </div>`;
                    });
                }

                // --- Render Support ---
                const tickGrid = document.getElementById('tickets-list');
                const resolvedSection = document.getElementById('resolved-tickets-section');
                const resolvedBody = document.getElementById('resolved-tickets-body');

                if (tickGrid) {
                    const openTickets = tickets.filter(tk => tk.status !== 'closed');
                    const closedTickets = tickets.filter(tk => tk.status === 'closed').sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

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
                                <div style="display: flex; flex-direction: column; gap: 10px; margin: 12px 0;">
                                    ${tk.media && tk.media.length > 0 ? tk.media.map(m => renderMedia(m.fileId, m.type)).join('') : (tk.fileId ? renderMedia(tk.fileId, tk.mediaType || 'photo') : '')}
                                </div>
                                <p style="font-size:0.95rem; line-height:1.6; color:var(--text-main); margin-bottom:20px;">${tk.issue}</p>
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
                    // Store closed tickets data for sorting + pagination
                    window._closedTickets = closedTickets;
                    window._tenants = tenants;
                    if (resolvedSection && resolvedBody) {
                        if (closedTickets.length === 0) {
                            resolvedSection.style.display = 'none';
                        } else {
                            resolvedSection.style.display = 'block';
                            // Re-apply current sort state so polling doesn't reset user's sort/page
                            applyResolvedSort();
                        }
                    }
                }

                // Settings
                // Settings - Skip updating if the user is currently typing/focusing on them
                const focusedElement = document.activeElement;
                const settingsIds = ['remind-days', 'currency', 'fixer-id', 'start-text', 'rules-text', 'clearance-text'];
                
                if (document.getElementById('remind-days')) {
                    if (!settingsIds.includes(focusedElement.id)) {
                        document.getElementById('remind-days').value = settings.rent_reminder_days_before || 5;
                        document.getElementById('currency').value = settings.currency || 'PHP';
                        document.getElementById('fixer-id').value = settings.fixer_id || '';
                        document.getElementById('start-text').value = settings.start_text || 'Welcome to Landlord HQ. Enter /help for more commands.';
                        document.getElementById('rules-text').value = settings.rules_text || '📝 **Condo House Rules:**\n\n1. No loud music after 10PM.\n2. Keep common areas clean.';
                        document.getElementById('clearance-text').value = settings.clearance_text || '📦 **Move-out Clearance Process:**\n\n1. Settle all outstanding utility bills.\n2. Submit the Clearance Form to the Admin office.\n3. Send a photo of the signed form here for verification.';
                    }
                }
            } catch (err) { console.error('Data refresh error:', err); }
        }

        // --- Resolved Tickets Rendering & Sorting ---
        function renderResolvedRows(closedTickets, tenants) {
            const resolvedBody = document.getElementById('resolved-tickets-body');
            if (!resolvedBody) return;
            resolvedBody.innerHTML = closedTickets.map(tk => {
                const t = tenants.find(ten => String(ten.unit) === String(tk.unit)) || { name: 'Unknown' };
                const date = new Date(tk.timestamp);
                const hasMedia = (tk.media && tk.media.length > 0) || tk.fileId;
                let mediaHtml = '-';
                if (tk.media && tk.media.length > 0) {
                    const m = tk.media[0];
                    const src = `${API_URL}/media/${m.fileId}`;
                    mediaHtml = `<button class="btn-icon" onclick="openLightbox('${m.type || 'photo'}', '${src}')" title="View Attachment" style="background: rgba(239,68,68,0.1); color: var(--danger); padding: 5px; border-radius: 6px; cursor: pointer; border: none;"><i class="fas fa-${(m.type || 'photo') === 'video' ? 'video' : 'image'}"></i>${tk.media.length > 1 ? ' +' + (tk.media.length - 1) : ''}</button>`;
                } else if (tk.fileId) {
                    const src = `${API_URL}/media/${tk.fileId}`;
                    mediaHtml = `<button class="btn-icon" onclick="openLightbox('${tk.mediaType || 'photo'}', '${src}')" title="View Attachment" style="background: rgba(239,68,68,0.1); color: var(--danger); padding: 5px; border-radius: 6px; cursor: pointer; border: none;"><i class="fas fa-${(tk.mediaType || 'photo') === 'video' ? 'video' : 'image'}"></i></button>`;
                }
                return `
                <tr style="border-bottom: 1px solid var(--border);" data-timestamp="${tk.timestamp}" data-unit="${esc(String(tk.unit))}" data-tenant="${esc(t.name)}" data-issue="${esc(tk.issue)}">
                    <td style="padding: 12px 16px; color: var(--text-muted); white-space: nowrap;">
                        <div style="font-weight: 500; color: var(--text-main);">${date.toLocaleDateString()}</div>
                        <div style="font-size: 0.78rem;">${date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                    </td>
                    <td style="padding: 12px 16px; font-weight: 600;">Unit ${esc(String(tk.unit))}</td>
                    <td style="padding: 12px 16px;">${esc(t.name)}</td>
                    <td style="padding: 12px 16px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(tk.issue)}">${esc(tk.issue)}</td>
                    <td style="padding: 12px 16px; text-align: center;">${mediaHtml}</td>
                </tr>`;
            }).join('');
        }

        // Track current sort state
        window._resolvedSortCol = 'date';
        window._resolvedSortDir = 'desc';
        window._sortedClosedTickets = [];

        // Render one page of the sorted resolved tickets
        function renderResolvedPage() {
            const all = window._sortedClosedTickets || [];
            const tenants = window._tenants || [];
            const resolvedBody = document.getElementById('resolved-tickets-body');
            if (!resolvedBody) return;

            const totalPages = Math.ceil(all.length / ITEMS_PER_PAGE);
            if (currentResolvedPage > totalPages && totalPages > 0) currentResolvedPage = totalPages;
            const start = (currentResolvedPage - 1) * ITEMS_PER_PAGE;
            const pageData = all.slice(start, start + ITEMS_PER_PAGE);

            renderResolvedRows(pageData, tenants);

            renderPagination('resolved-pagination', currentResolvedPage, totalPages, (page) => {
                currentResolvedPage = page;
                renderResolvedPage();
            });
        }

        // Core sort + render (used by both header clicks and polling refresh)
        function applyResolvedSort() {
            const tickets = window._closedTickets;
            const tenants = window._tenants;
            if (!tickets || !tenants) return;

            const col = window._resolvedSortCol;
            const dir = window._resolvedSortDir === 'asc' ? 1 : -1;
            const sorted = [...tickets].sort((a, b) => {
                if (col === 'date') return dir * (new Date(a.timestamp) - new Date(b.timestamp));
                if (col === 'unit') return dir * String(a.unit).localeCompare(String(b.unit), undefined, {numeric: true});
                if (col === 'tenant') {
                    const tA = (tenants.find(t => String(t.unit) === String(a.unit)) || {name: ''}).name;
                    const tB = (tenants.find(t => String(t.unit) === String(b.unit)) || {name: ''}).name;
                    return dir * tA.localeCompare(tB);
                }
                if (col === 'issue') return dir * (a.issue || '').localeCompare(b.issue || '');
                return 0;
            });

            window._sortedClosedTickets = sorted;
            renderResolvedPage();

            // Update header icons
            document.querySelectorAll('#resolved-tickets-table thead th[data-sort]').forEach(th => {
                const icon = th.querySelector('i');
                if (th.dataset.sort === col) {
                    icon.className = window._resolvedSortDir === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
                    icon.style.opacity = '1';
                } else {
                    icon.className = 'fas fa-sort';
                    icon.style.opacity = '0.4';
                }
            });
        }

        // Header click handler: toggle direction, reset to page 1, then apply
        function sortResolvedTickets(col) {
            if (window._resolvedSortCol === col) {
                window._resolvedSortDir = window._resolvedSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                window._resolvedSortCol = col;
                window._resolvedSortDir = col === 'date' ? 'desc' : 'asc';
            }
            currentResolvedPage = 1; // reset to page 1 on sort change
            applyResolvedSort();
        }

        // --- Verifications ---
        async function verifyPayment(unit, paymentId) {
            const tenant = (window.tenantData || []).find(t => String(t.unit) === String(unit));
            const amountInput = document.getElementById('verify-amount');
            
            // Pre-fill with lease amount if available
            if (tenant && tenant.leaseAmount) {
                amountInput.value = tenant.leaseAmount;
            } else {
                amountInput.value = '';
            }

            document.getElementById('verify-payment-id').value = paymentId;
            document.getElementById('verify-payment-unit').value = unit;
            document.getElementById('verify-payment-modal').style.display = 'flex';
        }

        function closeVerifyPaymentModal() {
            document.getElementById('verify-payment-modal').style.display = 'none';
        }

        document.getElementById('verify-payment-form').onsubmit = async (e) => {
            e.preventDefault();
            const paymentId = document.getElementById('verify-payment-id').value;
            const unit = document.getElementById('verify-payment-unit').value;
            const amount = document.getElementById('verify-amount').value;

            openConfirmModal('Verify Payment', 'Are you sure you want to verify this payment? The tenant will be notified.', 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/payments/${paymentId}/verify`, {
                        method: 'POST', credentials: 'include',
                        headers: { 
                            ...csrfHeaders(),
                        },
                        body: JSON.stringify({ unit, amount })
                    });
                    
                    if (res.ok) {
                        openConfirmModal('Verified!', 'Payment verified and notification sent to tenant.', 'success');
                        closeVerifyPaymentModal();
                        refreshFinanceHub();
                        refreshDashboard();
                    } else {
                        const err = await res.json();
                        openConfirmModal('Error', err.error || 'Failed to verify payment.', 'danger');
                    }
                } catch (err) {
                    console.error(err);
                    openConfirmModal('Error', 'An error occurred during verification.', 'danger');
                }
            });
        };





        async function handleTicketCheck(checkbox, id, field) {
            const repChk = document.getElementById(`chk-rep-${id}`);
            const resChk = document.getElementById(`chk-res-${id}`);

            if (!repChk || !resChk) return;

            // "Issue Resolved" checkbox → close ticket (single atomic call, server sets reported=true too)
            if (field === 'status' && checkbox.checked) {
                checkbox.checked = false; // revert visually; re-render will show correct state after save
                openConfirmModal(
                    'Close & Lock Ticket?',
                    'Mark this issue as resolved? It will move to the Resolved Tickets table and cannot be edited.',
                    'danger',
                    async () => {
                        await updateTicketStatus(id, 'status', 'closed');
                    }
                );
                return;
            }

            // "Issue Resolved" unchecked → reopen (if already open it's a no-op but handle gracefully)
            if (field === 'status' && !checkbox.checked) {
                await updateTicketStatus(id, 'status', 'open');
                return;
            }

            // "Reported to Fixer" checkbox
            if (field === 'reported') {
                await updateTicketStatus(id, 'reported', checkbox.checked);

                // If checking (not unchecking), trigger fixer notification
                if (checkbox.checked) {
                    fetch(`${API_URL}/tickets/${id}/forward`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: csrfHeaders()
                    })
                    .then(res => res.json())
                    .then(data => {
                        if (!data.success) console.error('Fixer notification failed:', data.error);
                    })
                    .catch(e => console.error('Fixer notification failed:', e));
                }
            }
        }

        async function updateTicketStatusNoRefresh(id, field, value) {
            try {
                const updates = {};
                updates[field] = value;
                await fetch(`${API_URL}/tickets/${id}`, {
                    method: 'PUT', credentials: 'include',
                    headers: { 
                        ...csrfHeaders(),
                    },
                    body: JSON.stringify(updates)
                });
            } catch (err) { console.error('Error updating ticket without refresh:', err); }
        }

        async function updateTicketStatus(id, field, value) {
            try {
                const updates = {};
                updates[field] = value;
                const res = await fetch(`${API_URL}/tickets/${id}`, {
                    method: 'PUT', credentials: 'include',
                    headers: { 
                        ...csrfHeaders(),
                    },
                    body: JSON.stringify(updates)
                });
                
                if (res.ok) {
                    refreshDashboard();
                } else {
                    console.error('Failed to update ticket status');
                }
            } catch (err) {
                console.error('Error updating ticket:', err);
            }
        }

        async function forwardFixer(unit, issue) {
            openConfirmModal('Forwarded!', `Forwarding Unit ${unit} issue to fixer...\n\nIssue: ${issue}`, 'success');
        }

        async function saveSettings() {
            const settings = {
                rent_reminder_days_before: parseInt(document.getElementById('remind-days').value),
                currency: document.getElementById('currency').value,
                fixer_id: document.getElementById('fixer-id').value,
                start_text: document.getElementById('start-text').value,
                rules_text: document.getElementById('rules-text').value,
                clearance_text: document.getElementById('clearance-text').value
            };
            openConfirmModal('Save Settings', 'Are you sure you want to update the system settings?', 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/settings`, {
                        method: 'POST', credentials: 'include',
                        headers: { 
                            ...csrfHeaders(),
                        },
                        body: JSON.stringify(settings)
                    });
                    if (res.ok) openConfirmModal('Saved!', 'Core Settings Updated & Saved', 'success');
                } catch (err) { console.error(err); }
            });
        }

        // --- Finance Hub Logic ---
        async function refreshFinanceHub() {
            try {
                const [payRes, expRes, sumRes] = await Promise.all([
                    fetch(`${API_URL}/payments?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/expenses?t=${Date.now()}`, { credentials: 'include' }),
                    fetch(`${API_URL}/finance/summary?t=${Date.now()}`, { credentials: 'include' })
                ]);
                
                const payments = await payRes.json();
                const expenses = await expRes.json();
                const summary = await sumRes.json();

                renderPaymentsHistory(payments, window.tenantData || [], window.propertyData || []);
                renderExpenses(expenses);
                renderFinanceUpcoming(window.tenantData || [], window.propertyData || [], payments);
                renderFinanceOverdue(window.tenantData || [], window.propertyData || [], payments);
                updateFinanceSummary(summary);
            } catch (err) { console.error('Finance refresh error:', err); }
        }

        function renderFinanceUpcoming(tenants, properties, payments) {
            const tbody = document.getElementById('finance-upcoming-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            const currencySymbol = window.appSettings.currency || '₱';
            const getOrdinal = (n) => {
                const s = ["th", "st", "nd", "rd"], v = (n || 0) % 100;
                return (s[(v - 20) % 10] || s[v] || s[0]) || "th";
            };

            const now = new Date();
            const currentMonth = now.getMonth();
            const currentYear = now.getFullYear();

            // Filter logic similar to dashboard but for the separate finance view
            const upcoming = tenants.filter(t => {
                const isPaid = payments.some(p => 
                    String(p.unit) === String(t.unit) && 
                    p.status === 'verified' && 
                    new Date(p.timestamp).getMonth() === currentMonth &&
                    new Date(p.timestamp).getFullYear() === currentYear
                );
                
                const dueDate = new Date();
                dueDate.setDate(parseInt(t.rent_due_day || 1));
                const isOverdue = now > dueDate;

                return t.status === 'Active' && !isPaid && !isOverdue;
            });

            if (upcoming.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted)">No upcoming receivables for the current period.</td></tr>';
                return;
            }

            upcoming.forEach(t => {
                const prop = properties.find(p => String(p.id) === String(t.propertyId)) || {};
                tbody.innerHTML += `
                    <tr>
                        <td>${esc(t.name)}</td>
                        <td>
                            <div style="font-weight:500">${esc(prop.name) || 'Unassigned'}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted)">Unit ${esc(t.unit)}</div>
                        </td>
                        <td style="font-weight:600; font-family:var(--font-mono)">${currencySymbol}${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, {minimumFractionDigits:2})}</td>
                        <td style="color:var(--text-muted); font-size:0.9rem">Every ${t.rent_due_day}${getOrdinal(t.rent_due_day)}</td>
                        <td style="text-align:right">
                            <span class="status-pill pill-warning">Upcoming</span>
                        </td>
                    </tr>
                `;
            });
        }

        function renderPaymentsHistory(payments, tenants, properties) {
            const currencySymbol = window.appSettings.currency || '₱';
            const history = payments.filter(p => p.status === 'verified').sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            window._sortedHistory = history;
            window._historyTenants = tenants;
            window._historyProperties = properties;
            currentHistoryPage = 1;
            renderHistoryPage();
        }

        function renderHistoryPage() {
            const tbody = document.getElementById('payments-history-body');
            if (!tbody) return;
            const currencySymbol = window.appSettings.currency || '₱';
            const history = window._sortedHistory || [];
            const tenants = window._historyTenants || [];
            const properties = window._historyProperties || [];

            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted)">No transaction history found.</td></tr>';
                renderPagination('history-pagination', 1, 0, () => {});
                return;
            }

            const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE);
            if (currentHistoryPage > totalPages) currentHistoryPage = totalPages;
            const start = (currentHistoryPage - 1) * ITEMS_PER_PAGE;
            const pageData = history.slice(start, start + ITEMS_PER_PAGE);

            tbody.innerHTML = '';
            pageData.forEach(p => {
                const dateObj = new Date(p.timestamp);
                const dateStr = dateObj.toLocaleDateString();
                const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const src = p.fileId ? `${API_URL}/media/${p.fileId}` : null;
                const receiptHtml = src ? `<button class="btn-icon" onclick="openLightbox('${p.mediaType || 'photo'}', '${src}')" title="View Receipt" style="background: rgba(43, 122, 255, 0.1); color: var(--primary); padding: 5px; border-radius: 6px; cursor: pointer;"><i class="fas fa-receipt"></i></button>` : '-';
                let property = properties.find(prop => String(prop.id) === String(p.propertyId));
                if (!property) {
                    const t = tenants.find(ten => String(ten.unit) === String(p.unit));
                    if (t && t.propertyId) property = properties.find(prop => String(prop.id) === String(t.propertyId));
                }
                const pName = property ? property.name : (p.propertyName || 'Unassigned');
                tbody.innerHTML += `
                    <tr>
                        <td>${esc(p.tenantName) || 'Tenant'}</td>
                        <td>
                            <div style="font-weight:500">${esc(pName)}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted)">Unit ${esc(p.unit)}</div>
                        </td>
                        <td style="font-weight:600; color:var(--success); font-family:var(--font-mono)">${currencySymbol}${(parseFloat(p.amount) || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                        <td>
                            <div style="font-size:0.85rem">${dateStr}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted)">${timeStr}</div>
                        </td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                ${receiptHtml}
                                <span class="status-pill pill-info" style="font-size:0.65rem; padding: 2px 6px;">${esc(p.method) || (p.type === 'manual' ? 'Manual' : 'Telegram')}</span>
                            </div>
                        </td>
                        <td style="text-align: right;">
                            <button class="btn-outline" style="width: 32px; height: 32px; padding: 0; border: none; color: var(--danger); cursor: pointer;" onclick="deletePayment('${p.id}', '${esc(p.tenantName)}')">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
            renderPagination('history-pagination', currentHistoryPage, totalPages, (page) => {
                currentHistoryPage = page;
                renderHistoryPage();
            });
        }

        function renderExpenses(expenses) {
            const sorted = expenses.slice().sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            window._sortedExpenses = sorted;
            currentExpensePage = 1;
            renderExpensePage();
        }

        function renderExpensePage() {
            const tbody = document.getElementById('expenses-body');
            if (!tbody) return;
            const currencySymbol = window.appSettings.currency || '₱';
            const expenses = window._sortedExpenses || [];

            if (expenses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted)">No expenses recorded.</td></tr>';
                renderPagination('expense-pagination', 1, 0, () => {});
                return;
            }

            const totalPages = Math.ceil(expenses.length / ITEMS_PER_PAGE);
            if (currentExpensePage > totalPages) currentExpensePage = totalPages;
            const start = (currentExpensePage - 1) * ITEMS_PER_PAGE;
            const pageData = expenses.slice(start, start + ITEMS_PER_PAGE);

            tbody.innerHTML = '';
            pageData.forEach(e => {
                tbody.innerHTML += `
                    <tr>
                        <td>${esc(e.category)}</td>
                        <td style="font-weight:600; color:var(--danger); font-family:var(--font-mono)">${currencySymbol}${e.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--text-muted); font-size:0.9rem">${esc(e.description) || '—'}</td>
                        <td style="color:var(--text-muted); font-size:0.85rem">
                            <div>${new Date(e.timestamp).toLocaleDateString()}</div>
                            <div style="font-size:0.75rem; opacity:0.7;">${new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        </td>
                        <td style="text-align: right;">
                            <button class="btn-outline" style="width: 32px; height: 32px; padding: 0; border: none; color: var(--danger); cursor: pointer;" onclick="deleteExpense('${e.id}', '${esc(e.category)}')">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
            renderPagination('expense-pagination', currentExpensePage, totalPages, (page) => {
                currentExpensePage = page;
                renderExpensePage();
            });
        }

        function renderFinanceOverdue(tenants, properties, payments) {
            const tbody = document.getElementById('finance-overdue-body');
            const pill = document.getElementById('finance-overdue-pill');
            if (!tbody) return;
            const currencySymbol = window.appSettings.currency || '₱';

            const today = new Date();
            const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
            const verifiedPayments = payments.filter(p => p.status === 'verified');

            const overdue = tenants.filter(t => {
                if (t.status === 'Inactive') return false;
                const dueDay = parseInt(t.rent_due_day || 1);
                const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
                const overdueThreshold = new Date(dueDate.getTime() + 24 * 60 * 60 * 1000);
                const hasPaid = verifiedPayments.some(p => p.unit === t.unit && new Date(p.timestamp).getTime() >= currentMonthStart);
                return !hasPaid && today > overdueThreshold;
            });

            if (pill) {
                pill.innerText = `${overdue.length} Unpaid`;
                pill.style.display = overdue.length > 0 ? 'inline-block' : 'none';
            }

            if (overdue.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted)">No overdue payments.</td></tr>';
                return;
            }

            tbody.innerHTML = '';
            overdue.forEach(t => {
                const prop = properties.find(p => String(p.id) === String(t.propertyId)) || {};
                const dueDate = new Date(today.getFullYear(), today.getMonth(), t.rent_due_day || 1);
                tbody.innerHTML += `
                    <tr>
                        <td style="font-weight:600">${esc(t.name)}</td>
                        <td>
                            <div style="font-weight:500">${esc(prop.name) || 'Unassigned'}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted)">Unit ${esc(t.unit)}</div>
                        </td>
                        <td style="font-weight:600; color:var(--danger); font-family:var(--font-mono)">${currencySymbol}${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, {minimumFractionDigits:2})}</td>
                        <td style="color:var(--danger); font-weight:600;">
                            <i class="fas fa-exclamation-triangle"></i> ${dueDate.toLocaleDateString(undefined, {month:'short', day:'numeric'})}
                        </td>
                    </tr>
                `;
            });
        }

        // --- Finance Actions ---
        async function deletePayment(id, name) {
            openConfirmModal('Delete Payment', `Are you sure you want to delete the payment log for ${name || 'this tenant'}? This will also deduct the amount from your total collection.`, 'danger', async () => {
                try {
                    const res = await fetch(`${API_URL}/payments/${id}`, {
                        method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }
                    });
                    if (res.ok) {
                        openConfirmModal('Deleted!', 'Payment record has been removed.', 'success');
                        refreshFinanceHub();
                        refreshDashboard();
                    }
                } catch (err) { console.error(err); }
            });
        }

        async function deleteExpense(id, category) {
            openConfirmModal('Delete Expense', `Are you sure you want to delete the expense record: ${category}?`, 'danger', async () => {
                try {
                    const res = await fetch(`${API_URL}/expenses/${id}`, {
                        method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }
                    });
                    if (res.ok) {
                        openConfirmModal('Deleted!', 'Expense record has been removed.', 'success');
                        refreshFinanceHub();
                        refreshDashboard();
                    }
                } catch (err) { console.error(err); }
            });
        }

        // Track sort direction per table type
        window._finSortDir = { history: 'desc', expenses: 'desc', upcoming: 'asc' };

        function sortFinanceTable(type, column) {
            const dir = window._finSortDir[type] || 'desc';
            const nextDir = dir === 'desc' ? 'asc' : 'desc';
            window._finSortDir[type] = nextDir;

            function compareVals(a, b, col) {
                if (col === 'amount') {
                    return (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0);
                }
                if (col === 'timestamp' || col === 'dueDate') {
                    return new Date(a.timestamp || a.dueDate || 0) - new Date(b.timestamp || b.dueDate || 0);
                }
                const aStr = String(a[col] || '').toLowerCase();
                const bStr = String(b[col] || '').toLowerCase();
                return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
            }

            if (type === 'history') {
                window._sortedHistory = (window._sortedHistory || []).slice().sort((a, b) => {
                    const r = compareVals(a, b, column);
                    return nextDir === 'desc' ? -r : r;
                });
                currentHistoryPage = 1;
                renderHistoryPage();
            } else if (type === 'expenses') {
                window._sortedExpenses = (window._sortedExpenses || []).slice().sort((a, b) => {
                    const r = compareVals(a, b, column);
                    return nextDir === 'desc' ? -r : r;
                });
                currentExpensePage = 1;
                renderExpensePage();
            } else if (type === 'upcoming') {
                // Upcoming is not paginated, just re-render via refreshFinanceHub data
                const tbody = document.getElementById('finance-upcoming-body');
                if (!tbody) return;
                const rows = Array.from(tbody.querySelectorAll('tr'));
                rows.sort((a, b) => {
                    const aVal = a.cells[column === 'amount' ? 2 : column === 'dueDate' ? 3 : column === 'property' ? 1 : 0]?.innerText.trim() || '';
                    const bVal = b.cells[column === 'amount' ? 2 : column === 'dueDate' ? 3 : column === 'property' ? 1 : 0]?.innerText.trim() || '';
                    if (column === 'amount') {
                        return nextDir === 'desc'
                            ? parseFloat(bVal.replace(/[^0-9.-]+/g,"")) - parseFloat(aVal.replace(/[^0-9.-]+/g,""))
                            : parseFloat(aVal.replace(/[^0-9.-]+/g,"")) - parseFloat(bVal.replace(/[^0-9.-]+/g,""));
                    }
                    return nextDir === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                });
                tbody.innerHTML = '';
                rows.forEach(r => tbody.appendChild(r));
            }
        }

        function updateFinanceSummary(summary) {
            const currencySymbol = window.appSettings.currency || '₱';
            document.getElementById('total-collected').innerText = `${currencySymbol}${summary.totalCollected.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            document.getElementById('total-expenses').innerText = `${currencySymbol}${summary.totalExpenses.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            document.getElementById('net-profit').innerText = `${currencySymbol}${summary.netProfit.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        }

        async function openManualPaymentModal() {
            const select = document.getElementById('payment-tenant');
            // Optimization: Use local tenantData if available to avoid extra fetch
            if (window.tenantData && window.tenantData.length > 0) {
                select.innerHTML = window.tenantData.filter(t => t.status === 'Active').map(t => 
                    `<option value="${esc(t.unit)}">${esc(t.name)} (UNIT-${esc(t.unit)})</option>`
                ).join('');
            } else {
                try {
                    const res = await fetch(`${API_URL}/tenants?t=${Date.now()}`, {
                        credentials: 'include'
                    });
                    const tenants = await res.json();
                    window.tenantData = tenants; // cache it
                    select.innerHTML = tenants.filter(t => t.status === 'Active').map(t => 
                        `<option value="${esc(t.unit)}">${esc(t.name)} (UNIT-${esc(t.unit)})</option>`
                    ).join('');
                } catch (e) { console.error(e); }
            }
            
            document.getElementById('payment-form').reset();
            document.getElementById('payment-modal').style.display = 'flex';
        }

        function closePaymentModal() {
            document.getElementById('payment-modal').style.display = 'none';
        }

        function openExpenseModal() {
            document.getElementById('expense-form').reset();
            document.getElementById('expense-modal').style.display = 'flex';
        }

        function closeExpenseModal() {
            document.getElementById('expense-modal').style.display = 'none';
        }

        document.getElementById('payment-form').onsubmit = async (e) => {
            e.preventDefault();
            const unit = document.getElementById('payment-tenant').value;
            const tenant = window.tenantData.find(t => t.unit === unit);
            
            const data = {
                unit: unit,
                tenantName: tenant ? tenant.name : 'Unknown',
                propertyId: tenant ? tenant.propertyId : null,
                amount: parseFloat(document.getElementById('payment-amount').value),
                method: document.getElementById('payment-method').value,
                notes: document.getElementById('payment-notes').value
            };

            const currencySymbol = document.getElementById('currency')?.value || '₱'; // Fallback to current settings UI
            openConfirmModal('Log Payment', `Log a manual payment of ${currencySymbol}${data.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} for ${data.tenantName}?`, 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/payments`, {
                        method: 'POST', credentials: 'include',
                        headers: { 
                            ...csrfHeaders(),
                        },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        openConfirmModal('Success', 'Manual payment logged successfully.', 'success');
                        closePaymentModal();
                        refreshFinanceHub();
                        refreshDashboard();
                    }
                } catch (err) { console.error(err); }
            });
        };

        document.getElementById('expense-form').onsubmit = async (e) => {
            e.preventDefault();
            const data = {
                category: document.getElementById('expense-category').value,
                amount: parseFloat(document.getElementById('expense-amount').value),
                description: document.getElementById('expense-desc').value
            };

            const currencySymbol = document.getElementById('currency')?.value || '₱';
            openConfirmModal('Log Expense', `Log an expense of ${currencySymbol}${data.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} for ${data.category}?`, 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/expenses`, {
                        method: 'POST', credentials: 'include',
                        headers: { 
                            ...csrfHeaders(),
                        },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        openConfirmModal('Success', 'Expense logged successfully.', 'success');
                        closeExpenseModal();
                        refreshFinanceHub();
                        refreshDashboard();
                    }
                } catch (err) { console.error(err); }
            });
        };

        // Initialize App
        async function init() {
            try {
                // Sequential load to ensure data is available for calculating dashboard metrics
                await refreshProperties();
                await refreshTenants();
                await refreshDashboard();
            } catch (err) {
                console.error("Initial load refresh failed:", err);
            }
        }

        // Run init on load
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
        
        // Live Clock Initializer
        function updateLiveClock() {
            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
            const el = document.getElementById('live-time');
            if (el) el.innerText = timeStr;
            const elD = document.getElementById('live-date');
            if (elD) elD.innerText = dateStr;
            // Header date/time (top-right corner)
            const hDate = document.getElementById('header-date');
            const hTime = document.getElementById('header-time');
            if (hDate) hDate.innerText = dateStr;
            if (hTime) hTime.innerText = timeStr;
        }
        setInterval(updateLiveClock, 1000);
        updateLiveClock();

        // Smart background refresh — only polls data relevant to the currently active section.
        // Reads active section from the DOM (same source used by the search filter) to avoid
        // introducing redundant state. Skips expensive fetches when on static tabs (Settings/Docs/Logs).
        function smartRefresh() {
            const activeId = document.querySelector('.content-section.active')?.id;
            if (activeId === 'dashboard-section' || activeId === 'support-section') {
                refreshDashboard();
            } else if (activeId === 'finance-section') {
                refreshFinanceHub();
                refreshDashboard(); // keeps stat cards in sync
            }
            // properties, tenants, settings, docs, logs: no background refresh needed
        }
        setInterval(smartRefresh, 10000);
