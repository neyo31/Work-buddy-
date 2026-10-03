const puppeteer = require('puppeteer');
require('dotenv').config();

async function loginUser() {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    // Replace with your website's login URL
    await page.goto('https://your-website-url.com/login');
    
    // Replace with the actual selectors for your SID and password inputs
    await page.type('#sid-input-selector', process.env.USER_SID);
    await page.type('#password-input-selector', process.env.USER_PASSWORD);
    
    // Replace with the actual selector for your login submit button
    await page.click('#submit-button-selector');
    
    await page.waitForNavigation();
    
    console.log("Logged in successfully");
    
    // Close the browser or return the page for subsequent steps
    await browser.close();
}

loginUser();
