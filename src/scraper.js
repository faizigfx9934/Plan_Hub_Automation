// PlanHub Scraper - Stable Fleet Version
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { SEL } from './selectors.js';
import { logger } from './logger.js';
import * as telemetry from './telemetry.js';
import { ensureVpn } from './vpn.js';

// Configuration
const RUN_FOREVER = process.env.RUN_FOREVER === 'true';
const MAX_RUNTIME_MS = 8.5 * 60 * 60 * 1000;
const START_TIME = Date.now();
const PROGRESS_FILE = 'data/progress.json';

const OUTPUT_DIR = `runs/${new Date().toISOString().split('T')[0]}`;
fs.mkdirSync(`${OUTPUT_DIR}`, { recursive: true });

const SCREENSHOTS_DIR = 'screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// State Persistence
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (data.dayOffset !== undefined) {
        // Calculate if we need to resume from a past date
        const savedDate = new Date(data.timestamp);
        const today = new Date();
        const diffDays = Math.floor((today - savedDate) / (1000 * 60 * 60 * 24));
        
        // If we saved offset 4 yesterday, and today is 1 day later, 
        // we should now be at offset 3 relative to today to hit the same target date.
        const resumeOffset = data.dayOffset - diffDays;
        logger.info(`📈 Resuming from progress.json (Saved Offset: ${data.dayOffset}, Adjusted: ${resumeOffset})`);
        return resumeOffset;
      }
    } catch (err) {
      logger.fail('Failed to parse progress.json, starting fresh');
    }
  }
  return null;
}

function saveProgress(offset) {
  const data = {
    dayOffset: offset,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
  logger.ok(`💾 Progress saved: dayOffset ${offset}`);
}

function loadPreviousData() {
  const previousData = new Set();
  const runsDir = 'runs';
  if (!fs.existsSync(runsDir)) return previousData;
  const runFolders = fs.readdirSync(runsDir);
  for (const folder of runFolders) {
    const jsonPath = `${runsDir}/${folder}/data.json`;
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        data.forEach(entry => {
          const key = `${entry.project}|||${entry.company}`;
          previousData.add(key);
        });
      } catch (err) {}
    }
  }
  logger.info(`Loaded ${previousData.size} previously scraped companies for dedup`);
  return previousData;
}

let PREVIOUS_SCRAPES = loadPreviousData();

async function login(page) {
  logger.step('Login');
  await page.goto('https://access.planhub.com/signin');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.PLANHUB_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PLANHUB_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/supplier\.planhub\.com/, { timeout: 60000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  logger.ok('Logged in');
}

async function ensureLoggedIn(page, returnUrl = 'https://supplier.planhub.com/project/list') {
  const url = page.url();
  if (!/signin|login|access\.planhub\.com/i.test(url)) return false;
  logger.fail('⚠️ Session expired mid-run — re-authenticating');
  await login(page);
  await page.context().storageState({ path: 'session.json' });
  if (returnUrl) {
    await page.goto(returnUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }
  return true;
}

async function setDateFilter(page, dayOffset = 0) {
  logger.step(`Setting date filter: today+${dayOffset}`);
  await page.goto('https://supplier.planhub.com/project/list', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await ensureLoggedIn(page);

  await page.waitForSelector('text=/search/i', { timeout: 30000 });
  await page.getByLabel('Search (2)').getByRole('button').filter({ hasText: /^$/ }).click();
  await page.waitForTimeout(1000);

  for (let i = 0; i < 8; i++) {
    const customTab = page.getByText('Custom', { exact: true });
    if (await customTab.isVisible().catch(() => false)) break;
    await page.locator(SEL.dateFilter.paginateArrow).click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await page.getByText('Custom').click();
  await page.waitForTimeout(1500);

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + dayOffset);
  const endDate = new Date(startDate);

  const clickCalendarDay = async (d) => {
    const targetMonth = d.toLocaleString('en-US', { month: 'long' });
    const targetYear = d.getFullYear().toString();
    const ariaLabel = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Navigate to correct month/year
    for (let i = 0; i < 12; i++) {
      const period = await page.locator('button.mat-calendar-period-button').innerText().catch(() => '');
      if (period.toUpperCase().includes(targetMonth.toUpperCase()) && period.includes(targetYear)) break;
      
      const nextBtn = page.locator('button.mat-calendar-next-button');
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(600);
      } else {
        break;
      }
    }

    const btn = page.locator(`button[aria-label="${ariaLabel}"]`).first();
    await btn.waitFor({ state: 'attached', timeout: 5000 });
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };

  await clickCalendarDay(startDate);
  await page.waitForTimeout(800);
  await clickCalendarDay(endDate);
  await page.waitForTimeout(1000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  logger.ok(`Filter set to single day window (Offset: ${dayOffset})`);
}

async function getProjectsOnCurrentPage(page) {
  await page.waitForSelector('table tr', { timeout: 10000 });
  const rows = await page.locator('table tbody tr').all();
  const projects = [];
  for (const row of rows) {
    const name = await row.innerText().catch(() => '');
    if (name.trim()) projects.push(name.trim().split('\n')[0]);
  }
  return projects;
}

async function scrapeProject(page, projectName) {
  logger.step(`Scraping project: ${projectName}`);
  logger.setContext(projectName);

  const [projectPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('table').getByText(projectName).first().click().then(async () => {
      await page.getByRole('button', { name: 'View Project Details' }).click();
    }),
  ]);

  await projectPage.waitForLoadState('domcontentloaded');
  await projectPage.waitForTimeout(3000);

  if (/signin|login|access\.planhub\.com/i.test(projectPage.url())) {
    await projectPage.close().catch(() => {});
    await ensureLoggedIn(page);
    return [];
  }

  let fullProjectName = projectName;
  let bidDueDate = '';
  try {
    const headerText = await projectPage.locator('body').innerText();
    const nameMatch = headerText.match(/Project Name:\s*([^\n]+)/i);
    if (nameMatch) fullProjectName = nameMatch[1].trim();
    const dateMatch = headerText.match(/Bid Due Date\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
    if (dateMatch) bidDueDate = dateMatch[1].replace(/\//g, '-');
  } catch (err) {}

  const safeProjectName = fullProjectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
  
  // Smart Folder Matching: Check if we already have a folder for this project 
  // (matches either exact name or name with date in parentheses)
  let projectFolderName = bidDueDate ? `${safeProjectName} (${bidDueDate})` : safeProjectName;
  const existingFolders = fs.readdirSync(SCREENSHOTS_DIR);
  const matchedFolder = existingFolders.find(f => f === safeProjectName || f.startsWith(`${safeProjectName} (`));
  
  if (matchedFolder) {
    projectFolderName = matchedFolder;
    // Optimization: If we found a date this time but the old folder didn't have one, rename it!
    if (bidDueDate && matchedFolder === safeProjectName) {
      const newName = `${safeProjectName} (${bidDueDate})`;
      try {
        fs.renameSync(path.join(SCREENSHOTS_DIR, matchedFolder), path.join(SCREENSHOTS_DIR, newName));
        projectFolderName = newName;
        logger.info(`📝 Updated project folder name with bid date: ${newName}`);
      } catch (e) {}
    }
  }

  const projectScreenshotsDir = path.join(SCREENSHOTS_DIR, projectFolderName);
  fs.mkdirSync(projectScreenshotsDir, { recursive: true });

  await projectPage.getByRole('button', { name: 'Subcontractors' }).click();
  await projectPage.waitForTimeout(2500);

  let totalPages = 1;
  const pageText = await projectPage.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageText.match(/Page \d+ of (\d+)/);
  if (pageMatch) totalPages = parseInt(pageMatch[1]);

  const companyData = [];
  for (let subPage = 1; subPage <= totalPages; subPage++) {
    logger.step(`📄 Subcontractors page ${subPage}/${totalPages}`);
    
    await projectPage.evaluate(() => {
      const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], mat-dialog-content');
      scrollables.forEach(el => { el.scrollTop = el.scrollHeight; });
    });
    await projectPage.waitForTimeout(1500);
    
    const companyElements = await projectPage.locator('[class*="company"], [class*="subcontractor"] a').all();
    const companiesOnThisPage = [];
    for (const el of companyElements) {
      const name = await el.innerText().catch(() => '');
      if (name.trim()) companiesOnThisPage.push(name.trim());
    }
    
    for (const companyName of companiesOnThisPage) {
      const dedupKey = `${projectName}|||${companyName}`;
      if (PREVIOUS_SCRAPES.has(dedupKey)) continue;

      try {
        const [companyPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 15000 }),
          projectPage.getByText(companyName).first().click({ modifiers: ['ControlOrMeta'] }),
        ]);

        await companyPage.waitForLoadState('domcontentloaded');
        await companyPage.waitForTimeout(2000);

        const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
        const screenshotPath = `${projectScreenshotsDir}/${safeFileName}.png`;
        
        await companyPage.screenshot({ path: screenshotPath, fullPage: true });
        
        const bodyText = await companyPage.locator('body').innerText().catch(() => '');
        const record = {
          project: projectName,
          company: companyName,
          email: bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null,
          phone: bodyText.match(/(\+?\d[\d\s().-]{9,})/)?.[0] || null,
          screenshot: screenshotPath,
          scrapedAt: new Date().toISOString(),
          isNew: true,
        };
        companyData.push(record);
        PREVIOUS_SCRAPES.add(dedupKey);
        await companyPage.close();
        logger.ok(`✓ ${companyName}`);
      } catch (err) {
        logger.fail(`Failed ${companyName}: ${err.message}`);
      }
    }
    
    if (subPage < totalPages) {
      const goToPageInput = projectPage.locator('input[type="number"]').first();
      await goToPageInput.fill(String(subPage + 1));
      await goToPageInput.press('Enter');
      await projectPage.waitForTimeout(3000);
    }
  }

  await projectPage.close();
  logger.setContext('Idle');
  return companyData;
}

async function paginate(page) {
  const nextBtn = page.getByRole('button', { name: /next/i });
  if (await nextBtn.isVisible().catch(() => false) && await nextBtn.isEnabled()) {
    await nextBtn.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

async function main() {
  logger.step('PlanHub Scraper Pro');
  
  // 1. Verify VPN Connectivity
  if (!ensureVpn()) {
    logger.fail('FATAL: VPN is required but disconnected. Aborting run.');
    if (telemetry.isEnabled()) {
       await telemetry.reportError('VPN Disconnected');
    }
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const sessionPath = 'session.json';
  const contextOpts = { viewport: { width: 1920, height: 1080 } };
  if (fs.existsSync(sessionPath)) contextOpts.storageState = sessionPath;

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  let stopHeartbeat = () => {};

  try {
    if (!fs.existsSync(sessionPath)) {
      await login(page);
      await context.storageState({ path: sessionPath });
    } else {
      await page.goto('https://supplier.planhub.com/project/list');
      await ensureLoggedIn(page);
    }

    // Initialize Telemetry
    stopHeartbeat = telemetry.startHeartbeat();
    telemetry.setStatus('running');

    // Load Resume Progress or Start Offset
    const resumeOffset = loadProgress();
    const configOffset = parseInt(process.env.START_DATE_OFFSET ?? '4', 10);
    let dayOffset = resumeOffset !== null ? resumeOffset : configOffset;

    const allData = [];
    const quarantine = [];

    // Main Work Loop
    while (RUN_FOREVER || (Date.now() - START_TIME < MAX_RUNTIME_MS)) {
      logger.step(`📅 Date Target: today+${dayOffset}`);
      await setDateFilter(page, dayOffset);
      
      let pageNum = 1;
      do {
        logger.step(`📄 Project List Page ${pageNum}`);
        const projects = await getProjectsOnCurrentPage(page);
        
        for (const projectName of projects) {
          try {
            const data = await scrapeProject(page, projectName);
            allData.push(...data);
            fs.writeFileSync(`${OUTPUT_DIR}/data.json`, JSON.stringify(allData, null, 2));
          } catch (err) {
            logger.fail(`❌ Failed: ${projectName} - ${err.message}`);
            quarantine.push({ project: projectName, error: err.message, dateRange: `today+${dayOffset}` });
            fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
          }
        }
        pageNum++;
      } while (await paginate(page));

      // Successfully finished a full day's work
      saveProgress(dayOffset);
      
      // Advance to next day
      dayOffset++;
      logger.info('🔄 Day complete. Advancing...');
      await page.waitForTimeout(5000);
    }

    logger.ok('🏁 Run complete.');
    await telemetry.reportRunComplete({ companiesScraped: allData.length, quarantined: quarantine.length });

  } catch (err) {
    logger.fail(`Fatal Error: ${err.message}`);
    if (telemetry.isEnabled()) {
      await telemetry.reportError(err.message);
    }
  } finally {
    if (telemetry.isEnabled()) {
      await telemetry.reportStopping();
    }
    stopHeartbeat();
    await browser.close().catch(() => {});
  }
}

process.on('SIGINT', async () => {
  logger.info('\n🛑 Stopping... notifying dashboard');
  await telemetry.reportStopping().catch(() => {});
  process.exit(0);
});

main();