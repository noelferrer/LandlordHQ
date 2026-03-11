        // Security: Redirect to login if unauthenticated
        if (!localStorage.getItem('landlordhq_token')) {
            window.location.replace('/login');
        }
        
        // Logout handler
        function logout() {
            localStorage.removeItem('landlordhq_token');
            window.location.replace('/login');
        }
        const API_URL = '/api';

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
        
        const ITEMS_PER_PAGE = 10;
        let currentPropertiesPage = 1;
        let currentTenantsPage = 1;

        // --- Navigation ---
        function showSection(id, el) {
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById(`${id}-section`).classList.add('active');
            
            // Special handling for unified Financials: always show payments-section when in finance
            if (id === 'finance') {
                document.getElementById('payments-section').classList.add('active');
            }

            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            if (el) el.classList.add('active');

            const titles = {
                dashboard: { i: 'fas fa-th-large', t: 'Dashboard', st: 'Real-time unit pulse and occupancy grid' },
                properties: { i: 'fas fa-building', t: 'Properties', st: 'Building-level management and oversight' },
                'property-detail': { i: 'fas fa-building', t: 'Property Details', st: 'Portfolio in-depth view' },
                tenants: { i: 'fas fa-user-friends', t: 'Tenants', st: 'Manage all tenant records' },
                support: { t: 'Support Hub', st: 'Manage tenant tickets and maintenance requests', i: 'fas fa-headset' },
                finance: { t: 'Financial Hub', st: 'Real-time revenue, expenses, and transaction logs', i: 'fas fa-chart-pie' },
                settings: { i: 'fas fa-cog', t: 'System Configuration', st: 'Customize reminder logic and bot behavior' },
                docs: { i: 'fas fa-book', t: 'Command Documentation', st: 'Reference guide for available Telegram tenant commands' }
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
                const res = await fetch(`${API_URL}/properties?t=${Date.now()}`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
                });
                const properties = await res.json();
                const select = document.getElementById('tenant-property');
                select.innerHTML = properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
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
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
                    });
                    const tenantsList = await existingRes.json();
                    const existingT = tenantsList.find(t => t.unit === originalUnit);
                    if (existingT && existingT.telegramId) data.telegramId = existingT.telegramId;
                    if (existingT && existingT.rent_due_day) data.rent_due_day = existingT.rent_due_day;

                    openConfirmModal('Save Changes', 'Are you sure you want to update this tenant?', 'info', async () => {
                        try {
                            const res = await fetch(`${API_URL}/tenants/${originalUnit}`, {
                                method: 'PUT',
                                headers: { 
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
                                },
                                body: JSON.stringify(data)
                            });
                            if (res.ok) {
                                openConfirmModal('Updated!', 'Tenant details have been updated.', 'success');
                                closeTenantModal();
                                refreshTenants();
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
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
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
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } })
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
                select.innerHTML = properties.map(p =>
                    `<option value="${p.id}" ${String(p.id) === String(t.propertyId) ? 'selected' : ''}>${esc(p.name)}</option>`
                ).join('');

                document.getElementById('tenant-modal').style.display = 'flex';
            } catch (err) { console.error('Edit tenant lookup error:', err); }
        }

        async function deleteTenant(unit) {
            openConfirmModal('Delete Tenant', 'Are you sure you want to remove this tenant?', 'danger', async () => {
                try {
                    const res = await fetch(`${API_URL}/tenants/${unit}`, { 
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
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


        async function refreshTenants() {
            try {
                const [tenantRes, propRes] = await Promise.all([
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } })
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
                let valA = String(a[currentSort.key] || '').toLowerCase();
                let valB = String(b[currentSort.key] || '').toLowerCase();

                if (currentSort.key === 'propertyId') {
                    const pA = (window.propertyData || []).find(p => String(p.id) === String(a.propertyId));
                    const pB = (window.propertyData || []).find(p => String(p.id) === String(b.propertyId));
                    valA = pA ? pA.name.toLowerCase() : 'unassigned';
                    valB = pB ? pB.name.toLowerCase() : 'unassigned';
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


        function renderPagination(containerId, currentPage, totalPages, onPageChange) {
            let container = document.getElementById(containerId);
            if (!container) {
                // If container doesn't exist, we might need to create it (e.g. at bottom of grid/table)
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
                            method: 'PUT',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
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
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
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
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
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
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
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
                const lCount = pTenants.length;

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
                            <div style="display:flex; align-items:center; gap:5px;">
                                <i class="fas fa-user-friends"></i> ${tCount} tenants
                            </div>
                            <div style="display:flex; align-items:center; gap:5px;">
                                <i class="fas fa-file-contract"></i> ${lCount} leases
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
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } })
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
            try {
                const [propRes, tenantRes] = await Promise.all([
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/tenants?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } })
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

                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 30px;">
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
                                    <div style="font-size: 0.95rem; color: var(--text-main); font-weight: 500;">Added ${new Date(Number(p.id)).toLocaleDateString()}</div>
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
                                    <div style="font-size: 0.85rem; color: var(--text-muted);">Active Tenant</div>
                                </div>
                            </div>
                            <div class="card" style="padding: 24px; display: flex; align-items: center; gap: 20px;">
                                <div class="stat-icon-lg bg-success">
                                    <i class="fas fa-file-signature"></i>
                                </div>
                                <div>
                                    <div style="font-size: 1.5rem; font-weight: 800;">${activeLeases}</div>
                                    <div style="font-size: 0.85rem; color: var(--text-muted);">Active Lease</div>
                                </div>
                            </div>
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
                const authHeaders = { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` };

                // Check auth first with a single request to avoid redirect loops
                const authCheck = await fetch(`${API_URL}/tenants`, { headers: authHeaders });
                if (authCheck.status === 401) {
                    localStorage.removeItem('landlordhq_token');
                    window.location.replace('/login');
                    return;
                }
                const rawTenants = await authCheck.json();

                const [rawTickets, rawPayments, rawSettings, rawProperties] = await Promise.all([
                    fetch(`${API_URL}/tickets`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
                    fetch(`${API_URL}/payments`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
                    fetch(`${API_URL}/settings`, { headers: authHeaders }).then(r => r.ok ? r.json() : {}),
                    fetch(`${API_URL}/properties?t=${Date.now()}`, { headers: authHeaders }).then(r => r.ok ? r.json() : [])
                ]);

                // Defensive: ensure arrays are arrays, settings is an object
                const tenants = Array.isArray(rawTenants) ? rawTenants : [];
                const tickets = Array.isArray(rawTickets) ? rawTickets : [];
                const payments = Array.isArray(rawPayments) ? rawPayments : [];
                const settings = (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) ? rawSettings : {};
                const properties = Array.isArray(rawProperties) ? rawProperties : [];

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
                if (statRevenue) statRevenue.innerText = `₱${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
                    const gracePeriod = 3;
                    const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
                    const overdueThreshold = new Date(dueDate.getTime() + (gracePeriod * 24 * 60 * 60 * 1000));
                    
                    // Has this tenant paid for the current month?
                    const hasPaid = verifiedPayments.some(p => p.unit === t.unit && new Date(p.timestamp).getTime() >= currentMonthStart);
                    
                    // Is today past the overdue threshold?
                    return !hasPaid && today > overdueThreshold;
                });

                // Update Overdue Payments Stat
                const overdueStat = document.getElementById('dash-overdue-payments');
                if (overdueStat) overdueStat.innerText = overdueTenants.length;

                // Render Overdue Payments (In place of what was pending)
                const overdueBody = document.getElementById('dash-recent-payments'); // WE NEED TO BE CAREFUL: OVERDUE is now on the left? No, user said switch Recent and Upcoming.
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
                                            <td style="padding: 12px 0; font-weight: 600; color: var(--success);">₱${(parseFloat(p.amount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
                                <td style="padding: 12px 0; font-weight: 600; color: var(--warning);">₱${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
                                    ${pendingTickets.slice(0, 5).map(tk => {
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
                                    ${recentResolvedTickets.slice(0, 5).map(tk => {
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
                                    <div class="card-title" style="margin-bottom: 5px; font-size: 1.05rem;">${esc(t.name)}</div>
                                    <div class="card-meta" style="margin-bottom: 15px;"><i class="fas fa-clock"></i> Submitted: ${new Date(p.timestamp).toLocaleString()}</div>
                                    ${p.fileId ? renderMedia(p.fileId, p.mediaType || 'photo') : ''}
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
                if (tickGrid) {
                    tickGrid.innerHTML = tickets.length > 0 ? '' : '<p style="color:var(--text-muted); grid-column: 1/-1; text-align: center; padding: 40px;">No active support tickets.</p>';
                    tickets.forEach(tk => {
                        const t = tenants.find(ten => String(ten.unit) === String(tk.unit)) || { name: 'Unknown' };
                        tickGrid.innerHTML += `
                        <div class="card">
                            <div class="card-body">
                                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                                    <div class="unit-number">UNIT ${tk.unit}</div>
                                    <span class="status-pill ${tk.status === 'open' ? 'pill-danger' : 'pill-success'}">${tk.status === 'closed' ? 'Closed' : 'Open'}</span>
                                </div>
                                <div class="card-title">${esc(t.name)}</div>
                                <div class="card-meta"><i class="fas fa-clock"></i> ${new Date(tk.timestamp).toLocaleString()}</div>
                                <p style="font-size:0.95rem; line-height:1.6; color:var(--text-main); margin-bottom:20px;">${tk.issue}</p>
                                <div style="display: flex; flex-direction: column; gap: 10px;">
                                    ${tk.media && tk.media.length > 0 ? tk.media.map(m => renderMedia(m.fileId, m.type)).join('') : (tk.fileId ? renderMedia(tk.fileId, tk.mediaType || 'photo') : '')}
                                </div>
                                <div class="ticket-checklist" style="margin-top: 15px; border-top: 1px solid var(--border-color); padding-top: 15px; ${tk.reported && tk.status === 'closed' ? 'opacity: 0.5; pointer-events: none;' : ''}">
                                    <label style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px; cursor: pointer; color: var(--text-main);">
                                        <input type="checkbox" id="chk-rep-${tk.id}" ${tk.reported ? 'checked' : ''} onchange="handleTicketCheck(this, '${tk.id}', 'reported')" style="width: 18px; height: 18px; cursor: pointer;">
                                        Reported to Fixer
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-main);">
                                        <input type="checkbox" id="chk-res-${tk.id}" ${tk.status === 'closed' ? 'checked' : ''} onchange="handleTicketCheck(this, '${tk.id}', 'status')" style="width: 18px; height: 18px; cursor: pointer;">
                                        Issue Resolved (Done)
                                    </label>
                                </div>
                            </div>
                        </div>`;
                    });
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
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
                        },
                        body: JSON.stringify({ unit, amount })
                    });
                    
                    if (res.ok) {
                        openConfirmModal('Verified!', 'Payment verified and notification sent to tenant.', 'success');
                        closeVerifyPaymentModal();
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
            
            const isRep = repChk.checked;
            const isRes = resChk.checked;
            
            if (isRep && isRes) {
                let confirmed = false;
                openConfirmModal(
                    'Close & Lock Ticket?', 
                    'Are you sure you want to mark this issue as resolved? It will be permanently grayed out and you will not be able to edit it again.', 
                    'danger', 
                    async () => {
                        confirmed = true;
                        if (field === 'reported') {
                            await updateTicketStatusNoRefresh(id, 'status', 'closed');
                            await updateTicketStatus(id, 'reported', true);
                        } else {
                            await updateTicketStatusNoRefresh(id, 'reported', true);
                            await updateTicketStatus(id, 'status', 'closed');
                        }
                    }
                );
                
                const oldClose = closeConfirmModal;
                window.closeConfirmModal = function() {
                    if (!confirmed) checkbox.checked = false; // Revert the checkbox visually
                    window.closeConfirmModal = oldClose; // Restore original close function
                    oldClose();
                };
            } else {
                const val = field === 'status' ? (checkbox.checked ? 'closed' : 'open') : checkbox.checked;
                await updateTicketStatus(id, field, val);
            }
        }

        async function updateTicketStatusNoRefresh(id, field, value) {
            try {
                const updates = {};
                updates[field] = value;
                await fetch(`${API_URL}/tickets/${id}`, {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
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
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
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
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
                        },
                        body: JSON.stringify(settings)
                    });
                    if (res.ok) openConfirmModal('Saved!', 'Core Settings Updated & Saved', 'success');
                } catch (err) { console.error(err); }
            });
        }

        // Search Filter Logic
        document.getElementById('global-search').addEventListener('input', function(e) {
            const query = e.target.value.toLowerCase();
            const activeSection = document.querySelector('.content-section.active').id;

            if (activeSection === 'properties-section') {
                const cards = document.querySelectorAll('#properties-grid .card');
                cards.forEach(card => {
                    const text = card.innerText.toLowerCase();
                    card.style.display = text.includes(query) ? 'block' : 'none';
                });
            } else if (activeSection === 'tenants-section') {
                const rows = document.querySelectorAll('#tenants-table-body tr');
                rows.forEach(row => {
                    const text = row.innerText.toLowerCase();
                    row.style.display = text.includes(query) ? '' : 'none';
                });
            } else if (activeSection === 'support-section') {
                const tickets = document.querySelectorAll('#tickets-list .card');
                tickets.forEach(ticket => {
                    const text = ticket.innerText.toLowerCase();
                    ticket.style.display = text.includes(query) ? 'block' : 'none';
                });
            } else if (activeSection === 'payments-section') {
                const payments = document.querySelectorAll('#payments-list .card');
                payments.forEach(payment => {
                    const text = payment.innerText.toLowerCase();
                    payment.style.display = text.includes(query) ? 'block' : 'none';
                });
            }
        });

        // --- Finance Hub Logic ---
        async function refreshFinanceHub() {
            try {
                const [payRes, expRes, sumRes] = await Promise.all([
                    fetch(`${API_URL}/payments?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/expenses?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } }),
                    fetch(`${API_URL}/finance/summary?t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` } })
                ]);
                
                const payments = await payRes.json();
                const expenses = await expRes.json();
                const summary = await sumRes.json();

                renderPaymentsHistory(payments, window.tenantData || [], window.propertyData || []);
                renderExpenses(expenses);
                renderFinanceUpcoming(window.tenantData || [], window.propertyData || [], payments);
                updateFinanceSummary(summary);
            } catch (err) { console.error('Finance refresh error:', err); }
        }

        function renderFinanceUpcoming(tenants, properties, payments) {
            const tbody = document.getElementById('finance-upcoming-body');
            if (!tbody) return;
            tbody.innerHTML = '';

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
                        <td style="font-weight:600; font-family:var(--font-mono)">₱${(parseFloat(t.leaseAmount) || 0).toLocaleString(undefined, {minimumFractionDigits:2})}</td>
                        <td style="color:var(--text-muted); font-size:0.9rem">Every ${t.rent_due_day}${getOrdinal(t.rent_due_day)}</td>
                        <td style="text-align:right">
                            <span class="status-pill pill-warning">Upcoming</span>
                        </td>
                    </tr>
                `;
            });
        }

        function renderPaymentsHistory(payments, tenants, properties) {
            const tbody = document.getElementById('payments-history-body');
            if(!tbody) return;
            tbody.innerHTML = '';
            
            // Set explicit default sort flag so chronological toggle works correctly
            tbody.setAttribute('data-sort-dir', 'desc');
            
            // Only show verified payments or manual ones
            const history = payments.filter(p => p.status === 'verified').sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted)">No transaction history found.</td></tr>';
                return;
            }

            history.forEach(p => {
                const dateObj = new Date(p.timestamp);
                const dateStr = dateObj.toLocaleDateString();
                const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                const src = p.fileId ? `${API_URL}/media/${p.fileId}` : null;
                const receiptHtml = src ? `<button class="btn-icon" onclick="openLightbox('${p.mediaType || 'photo'}', '${src}')" title="View Receipt" style="background: rgba(43, 122, 255, 0.1); color: var(--primary); padding: 5px; border-radius: 6px; cursor: pointer;"><i class="fas fa-receipt"></i></button>` : '-';
                
                // Lookup property name via tenant lookup
                const t = tenants.find(ten => String(ten.unit) === String(p.unit));
                const pName = t && t.propertyId ? ((properties.find(prop => String(prop.id) === String(t.propertyId)) || {}).name || 'Unassigned') : 'Unassigned';
                
                tbody.innerHTML += `
                    <tr>
                        <td>${esc(p.tenantName) || 'Tenant'}</td>
                        <td>
                            <div style="font-weight:500">${esc(pName)}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted)">Unit ${esc(p.unit)}</div>
                        </td>
                        <td style="font-weight:600; color:var(--success); font-family:var(--font-mono)">₱${(parseFloat(p.amount) || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
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
        }

        function renderExpenses(expenses) {
            const tbody = document.getElementById('expenses-body');
            if(!tbody) return;
            tbody.innerHTML = '';
            
            // Set explicit default sort flag so chronological toggle works correctly
            tbody.setAttribute('data-sort-dir', 'desc');
            
            if (expenses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:30px; color:var(--text-muted)">No expenses recorded.</td></tr>';
                return;
            }

            expenses.slice().sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).forEach(e => {
                tbody.innerHTML += `
                    <tr>
                        <td>${esc(e.category)}</td>
                        <td style="font-weight:600; color:var(--danger); font-family:var(--font-mono)">₱${e.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--text-muted); font-size:0.9rem">${esc(e.description) || '—'}</td>
                        <td style="color:var(--text-muted); font-size:0.85rem">${new Date(e.timestamp).toLocaleDateString()}</td>
                        <td style="text-align: right;">
                            <button class="btn-outline" style="width: 32px; height: 32px; padding: 0; border: none; color: var(--danger); cursor: pointer;" onclick="deleteExpense('${e.id}', '${esc(e.category)}')">
                                <i class="fas fa-trash-alt"></i>
                            </button>
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
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
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
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
                    });
                    if (res.ok) {
                        openConfirmModal('Deleted!', 'Expense record has been removed.', 'success');
                        refreshFinanceHub();
                        refreshDashboard();
                    }
                } catch (err) { console.error(err); }
            });
        }

        function sortFinanceTable(type, column) {
            const tableMap = {
                'upcoming': 'finance-upcoming-body',
                'history': 'payments-history-body',
                'expenses': 'expenses-body'
            };
            const tbody = document.getElementById(tableMap[type]);
            if (!tbody) return;

            const rows = Array.from(tbody.querySelectorAll('tr'));
            if (rows.length <= 1) return;

            const isDesc = tbody.getAttribute('data-sort-dir') === 'desc';
            const colIndex = {
                'tenant': 0, 'property': 1, 'amount': (type === 'expenses' ? 1 : 2), 'dueDate': 3,
                'timestamp': 3, 'category': 0
            }[column] || 0;

            const sorted = rows.sort((a,b) => {
                let aVal = a.cells[colIndex].innerText.trim();
                let bVal = b.cells[colIndex].innerText.trim();

                // Numeric sort for amounts
                if (column === 'amount') {
                    aVal = parseFloat(aVal.replace(/[^0-9.-]+/g,""));
                    bVal = parseFloat(bVal.replace(/[^0-9.-]+/g,""));
                    return isDesc ? aVal - bVal : bVal - aVal;
                }

                // Date sort for dueDate/timestamp: converting values back to Dates for proper numerical mapping if possible.
                if (column === 'dueDate' || column === 'timestamp') {
                    // Try to parse as native dates instead of locale string comparison for strict correctness
                    const d1 = new Date(aVal);
                    const d2 = new Date(bVal);
                    if (!isNaN(d1) && !isNaN(d2)) {
                        return isDesc ? d1.getTime() - d2.getTime() : d2.getTime() - d1.getTime();
                    }
                    return isDesc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                }

                return isDesc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            });

            tbody.innerHTML = '';
            sorted.forEach(r => tbody.appendChild(r));
            tbody.setAttribute('data-sort-dir', isDesc ? 'asc' : 'desc');
        }

        function updateFinanceSummary(summary) {
            document.getElementById('total-collected').innerText = `₱${summary.totalCollected.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            document.getElementById('total-expenses').innerText = `₱${summary.totalExpenses.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            document.getElementById('net-profit').innerText = `₱${summary.netProfit.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
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
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}` }
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
                amount: parseFloat(document.getElementById('payment-amount').value),
                method: document.getElementById('payment-method').value,
                notes: document.getElementById('payment-notes').value
            };

            openConfirmModal('Log Payment', `Log a manual payment of ₱${data.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} for ${data.tenantName}?`, 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/payments`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
                        },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        openConfirmModal('Success', 'Manual payment logged successfully.', 'success');
                        closePaymentModal();
                        refreshFinanceHub();
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

            openConfirmModal('Log Expense', `Log an expense of ₱${data.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} for ${data.category}?`, 'info', async () => {
                try {
                    const res = await fetch(`${API_URL}/expenses`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('landlordhq_token')}`
                        },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        openConfirmModal('Success', 'Expense logged successfully.', 'success');
                        closeExpenseModal();
                        refreshFinanceHub();
                    }
                } catch (err) { console.error(err); }
            });
        };

        // Initialize App
        refreshDashboard();
        
        // Live Clock Initializer
        function updateLiveClock() {
            const now = new Date();
            document.getElementById('live-time').innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            document.getElementById('live-date').innerText = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
        }
        setInterval(updateLiveClock, 1000);
        updateLiveClock();

        setInterval(refreshDashboard, 10000);
