const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../data/db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

const demoAdminId = 'demo-admin-uuid';

const prop1Id = uuidv4();
const prop2Id = uuidv4();

const initialData = {
    admins: [
        {
            id: demoAdminId,
            username: 'demo_admin',
            name: 'Demo Landlord',
            telegramId: '618340961'
        }
    ],
    sessions: [],
    otps: [],
    properties: [
        { 
            id: prop1Id, 
            adminId: demoAdminId, 
            name: 'Crystal Towers', 
            address: '123 Sapphire Ave', 
            city: 'Manila', 
            state: 'MM', 
            zip: '1000', 
            type: 'Residential', 
            units: 50, 
            status: 'Active', 
            description: 'Luxury high-rise with skyline views.' 
        },
        { 
            id: prop2Id, 
            adminId: demoAdminId, 
            name: 'Emerald Heights', 
            address: '456 Jade St', 
            city: 'Quezon City', 
            state: 'MM', 
            zip: '1100', 
            type: 'Commercial', 
            units: 20, 
            status: 'Active', 
            description: 'Modern office space in the heart of the city.' 
        }
    ],
    units: [
        { id: uuidv4(), adminId: demoAdminId, propertyId: prop1Id, unitNumber: '101', status: 'Occupied' },
        { id: uuidv4(), adminId: demoAdminId, propertyId: prop1Id, unitNumber: '102', status: 'Vacant' },
        { id: uuidv4(), adminId: demoAdminId, propertyId: prop2Id, unitNumber: '202', status: 'Occupied' }
    ],
    tenants: [
        { 
            unit: '101', 
            name: 'Alice Smith', 
            rent_due_day: 5, 
            leaseAmount: 15000, 
            adminId: demoAdminId, 
            telegramId: null, 
            linkCode: 'ALICE1',
            propertyId: prop1Id,
            email: 'alice@example.com',
            phone: '555-0101',
            status: 'Active',
            moveInDate: '2024-01-01'
        },
        { 
            unit: '202', 
            name: 'Bob Johnson', 
            rent_due_day: 15, 
            leaseAmount: 12000, 
            adminId: demoAdminId, 
            telegramId: null, 
            linkCode: 'BOB202',
            propertyId: prop2Id,
            email: 'bob@example.com',
            phone: '555-0202',
            status: 'Active',
            moveInDate: '2024-02-01'
        }
    ],
    tickets: [
        { id: uuidv4(), adminId: demoAdminId, unit: '101', tenantName: 'Alice Smith', issue: 'Faucet dripping in kitchen', status: 'open', timestamp: new Date().toISOString(), media: [] }
    ],
    payments: [
        { id: uuidv4(), adminId: demoAdminId, unit: '202', tenantName: 'Bob Johnson', amount: 12000, method: 'bank_transfer', status: 'verified', timestamp: new Date().toISOString(), type: 'manual' }
    ],
    expenses: [
        { id: uuidv4(), adminId: demoAdminId, category: 'Maintenance', amount: 500, description: 'Light bulb replacement', timestamp: new Date().toISOString() }
    ],
    rules: [
        { id: 1, category: "General", rule: "Swimming pool is open from 6:00 AM to 10:00 PM." },
        { id: 2, category: "General", rule: "Visitors must register at the lobby/reception." }
    ],
    settings: [
        { 
            adminId: demoAdminId, 
            rent_reminder_days_before: 3, 
            currency: 'PHP', 
            start_text: 'Welcome to the LandlordHQ Demo Bot!',
            rules_text: '📝 **Condo Rules:**\n1. Be kind.\n2. No loud music.',
            clearance_text: '📦 **Move-out:** Settle bills and submit form.'
        }
    ],
    invites: []
};

function reset() {
    console.log("🧹 Resetting Demo Database...");
    db.setState(initialData).write();
    console.log("✅ Demo Database initialized with sandbox data.");
}

if (require.main === module) {
    reset();
}

module.exports = reset;
