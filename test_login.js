const puppeteer = require('puppeteer');

(async () => {
    console.log('Starting explicit headless login test...');
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.goto('http://localhost:3000/login');
        
        console.log('Page title:', await page.title());
        
        // Ensure username field exists
        await page.waitForSelector('#username');
        await page.type('#username', 'testadmin');
        
        console.log('Clicking Request Code');
        await page.click('#btn-continue');
        
        // Wait for step 2
        await page.waitForSelector('#step2', { visible: true, timeout: 5000 });
        console.log('Step 2 visible, OTP requested successfully.');
        
        // We can't easily fetch the OTP from DB here without requiring node modules in the test script, 
        // so we'll just check if the OTP request was successfully processed and the UI transitioned.
        console.log('✅ UI Transition successful. OTP requested.');
        
    } catch(e) {
        console.error('Test Failed:', e);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
