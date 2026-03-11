const cron = require('node-cron');
const db = require('./database');
const { addDays, getDate, setDate, addMonths, isBefore, format, startOfDay } = require('date-fns');

const setupReminders = (bot) => {
    // Run daily at 9:00 AM Manila Time
    cron.schedule('0 9 * * *', () => {
        console.log('⏰ Checking for rent reminders and overdue payments...');

        const tenants = db.get('tenants').value() || [];
        const today = startOfDay(new Date());

        tenants.forEach(tenant => {
            if (tenant.telegramId && tenant.rent_due_day) {
                // 1. Rent Reminders
                const adminSettings = db.get('settings').find({ adminId: tenant.adminId }).value() || {};
                const reminderDays = adminSettings.rent_reminder_days_before || 5;

                let nextDueDate = setDate(today, tenant.rent_due_day);
                if (isBefore(nextDueDate, addDays(today, 1))) {
                    nextDueDate = setDate(addMonths(today, 1), tenant.rent_due_day);
                }

                const sendReminderDate = addDays(today, reminderDays);

                if (getDate(sendReminderDate) === getDate(nextDueDate) && sendReminderDate.getMonth() === nextDueDate.getMonth()) {
                    const amountText = tenant.leaseAmount ? `\n\nAmount Due: **₱${tenant.leaseAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}**` : '';
                    bot.telegram.sendMessage(
                        tenant.telegramId,
                        `📌 **Friendly Rent Reminder**\n\nHi ${tenant.name}, just a heads up that your rent for **Unit ${tenant.unit}** is due in ${reminderDays} days on **${format(nextDueDate, 'MMMM do, yyyy')}**. ${amountText}\n\nPlease prepare your payment. Thank you!`,
                        { parse_mode: 'Markdown' }
                    ).catch(err => console.error(`Failed to send reminder to ${tenant.name}:`, err));
                }

                // 2. Overdue Check (3 days after due date)
                const gracePeriod = 3;
                const overdueTargetDate = addDays(setDate(today, tenant.rent_due_day), gracePeriod);
                
                if (getDate(today) === getDate(overdueTargetDate) && today.getMonth() === overdueTargetDate.getMonth()) {
                    // Check if a verified payment exists for this month
                    const currentMonthStart = setDate(today, 1).getTime();
                    const payments = db.get('payments').filter({ unit: tenant.unit, status: 'verified' }).value() || [];
                    const hasPaid = payments.some(p => new Date(p.timestamp).getTime() >= currentMonthStart);

                    if (!hasPaid) {
                        bot.telegram.sendMessage(
                            tenant.telegramId,
                            `⚠️ **Overdue Rent Notice**\n\nHi ${tenant.name}, our records show that rent for **Unit ${tenant.unit}** is now ${gracePeriod} days overdue. Please settle this as soon as possible. \n\nIf you've already paid, please send your receipt using **/payment**. Thank you!`,
                            { parse_mode: 'Markdown' }
                        ).catch(err => console.error(`Failed to send overdue notice to ${tenant.name}:`, err));
                        
                        // Optionally flag in DB
                        db.get('tenants').find({ unit: tenant.unit, adminId: tenant.adminId }).assign({ isOverdue: true }).write();
                    } else {
                        db.get('tenants').find({ unit: tenant.unit, adminId: tenant.adminId }).assign({ isOverdue: false }).write();
                    }
                }
            }
        });
    }, {
        scheduled: true,
        timezone: "Asia/Manila" // Explicitly setting timezone to Philippines Time as per previous config hints
    });

    console.log('📅 Scheduler initialized: Automatic rent reminders active (Asia/Manila timezone).');
};

module.exports = { setupReminders };
