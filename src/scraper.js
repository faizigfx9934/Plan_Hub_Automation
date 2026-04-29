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

const DATA_DIR = 'data';
fs.mkdirSync(DATA_DIR, { recursive: true });

let COMPANY_ZIP_CODE = null;

// State Persistence
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (data.dayOffset !== undefined) {
        const savedDate = new Date(data.timestamp);
        const today = new Date();
        const diffDays = Math.floor((today - savedDate) / (1000 * 60 * 60 * 24));
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
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
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

async function getCompanyZipCode(page) {
  if (COMPANY_ZIP_CODE) return COMPANY_ZIP_CODE;
  
  logger.step('Fetching company ZIP code from account settings');
  await page.goto('https://supplier.planhub.com/project/list', { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page);

  await page.getByRole(SEL.account.profileImage.role, { name: SEL.account.profileImage.name }).click();
  await page.waitForTimeout(800);
  await page.getByRole(SEL.account.myAccount.role, { name: SEL.account.myAccount.name }).click();
  await page.waitForTimeout(1500);
  await page.getByRole(SEL.account.companySettingsButton.role, { name: SEL.account.companySettingsButton.name }).click();
  await page.waitForTimeout(1000);
  await page.getByRole(SEL.account.viewCompanySettingsLink.role, { name: SEL.account.viewCompanySettingsLink.name }).click();
  await page.waitForTimeout(2500);

  const zipInput = page.getByRole(SEL.account.zipCodeInput.role, { name: SEL.account.zipCodeInput.name }).first();
  await zipInput.waitFor({ state: 'visible', timeout: 15000 });
  const zipCode = (await zipInput.inputValue().catch(() => '')).trim();
  if (!zipCode) {
    throw new Error('Could not read company ZIP code from Company Settings');
  }

  COMPANY_ZIP_CODE = zipCode;
  logger.ok(`Company ZIP detected: ${COMPANY_ZIP_CODE}`);
  return COMPANY_ZIP_CODE;
}

async function setDateFilter(page, dayOffset = 0) {
  logger.step(`Setting date and ZIP filters: today+${dayOffset}`);
  
  // 1. Fetch ZIP from settings
  const zipCode = await getCompanyZipCode(page);
  
  // 2. Return to project list (FORCE reload for clean state between days)
  await page.goto('https://supplier.planhub.com/project/list', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await ensureLoggedIn(page);

  // 3. Open Search Filters
  logger.info('   Opening search filters...');
  const searchBtn = page.getByLabel(/Search \(\d+\)/).getByRole('button').filter({ hasText: /^$/ }).first();
  await searchBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await searchBtn.click().catch(async () => {
     // Fallback: search by icon if label fails
     await page.locator('button:has(.mat-icon:text("search"))').first().click().catch(() => {});
  });
  await page.waitForTimeout(500);

  // 4. Navigate to "Custom" tab in date carousel
  logger.info('   Selecting "Custom" date tab...');
  for (let i = 0; i < 8; i++) {
    const customTab = page.getByText('Custom', { exact: true });
    if (await customTab.isVisible().catch(() => false)) break;
    await page.locator(SEL.dateFilter.paginateArrow).click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.getByText('Custom').click();
  await page.waitForTimeout(1000);

  // 5. Set Date (today + dayOffset)
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + dayOffset);
  
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
    await btn.waitFor({ state: 'attached', timeout: 10000 });
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };
  
  await clickCalendarDay(targetDate);
  await page.waitForTimeout(800);
  await clickCalendarDay(targetDate); // Start and End are same
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  // 6. Paste ZIP Code from account settings
  logger.info(`   Applying ZIP filter: ${zipCode}`);
  const zipFilter = page.getByRole(SEL.account.zipCodeInput.role, { name: SEL.account.zipCodeInput.name }).first();
  await zipFilter.click();
  await zipFilter.fill(zipCode);
  await zipFilter.press('Tab');
  await page.waitForTimeout(500);

  // 7. Set Distance (200 miles)
  const distanceField = page.locator(SEL.dateFilter.distanceField).filter({
    has: page.locator('mat-label').filter({ hasText: /^Distance$/ }),
  }).first();
  await distanceField.locator(SEL.dateFilter.distanceTrigger).click();
  await page.locator(SEL.dateFilter.distanceOption).filter({ hasText: /^\s*200(\s*miles)?\s*$/i }).first().click();
  
  logger.ok(`Filter set: ${targetDate.toLocaleDateString()} | ZIP ${zipCode} | 200 miles`);
}

async function getProjectsOnCurrentPage(page) {
  logger.info('⏳ Waiting for project list to refresh...');
  // Wait for any previous table content to be replaced or the loading state to finish
  await page.waitForTimeout(3000); 
  
  await page.waitForSelector('table tr', { timeout: 10000 }).catch(() => {});
  
  // Check for empty list message ONLY after we've given it time to load
  const emptyMessage = await page.locator('text=/No results found|Nothing found/i').first().isVisible().catch(() => false);
  if (emptyMessage) {
    logger.info('   Confirmed: No projects found for this filter.');
    return [];
  }

  let rows = await page.locator('table tbody tr').all();
  logger.info(`   Found ${rows.length} raw rows.`);
  
  // Immediate re-check if empty (only 1s wait)
  if (rows.length === 0) {
    await page.waitForTimeout(1000);
    rows = await page.locator('table tbody tr').all();
  }

  const projects = [];
  for (const row of rows) {
    const rowText = await row.innerText().catch(() => '');
    const cells = await row.locator('td').all();
    if (!cells.length) continue;

    const firstCellText = (await cells[0].innerText().catch(() => '')).trim();
    const nameCell = cells.find((_, index) => index > 0) || cells[0];
    const projectCellText = await nameCell.innerText().catch(() => rowText);
    const name = projectCellText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^lock$/i.test(line))[0];
    
    if (!name) continue;

    const locked = /^lock$/i.test(firstCellText) || /unlock/i.test(firstCellText);
    projects.push({ name, locked });
  }
  return projects;
}

function isLockedProjectText(text = '') {
  return /\blocked\b/i.test(text)
    || /unlock this project/i.test(text)
    || /upgrade to unlock/i.test(text)
    || /purchase .*unlock/i.test(text)
    || /to unlock/i.test(text);
}

async function waitWhileFleetPaused(page) {
  while (telemetry.isPaused()) {
    telemetry.setStatus('paused');
    logger.info('Fleet pause is enabled from the panel. Waiting before continuing...');
    await page.waitForTimeout(5000);
  }
}

async function collectCompanyEntries(projectPage) {
  const companyElements = await projectPage.locator(SEL.company.row).all();
  const companyNames = [];
  for (const companyElement of companyElements) {
    const name = await companyElement.innerText().catch(() => '');
    if (!name.trim()) continue;
    companyNames.push(name.trim());
  }
  return companyNames;
}

async function scrapeProject(page, projectInfo) {
  const projectName = typeof projectInfo === 'string' ? projectInfo : projectInfo.name;
  const knownLocked = typeof projectInfo === 'object' && Boolean(projectInfo.locked);

  if (knownLocked) {
    logger.info(`Skipping locked project: ${projectName}`);
    return [];
  }

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
    logger.fail('⚠️  Project tab hit signin — re-authenticating, skipping this project');
    await projectPage.close().catch(() => {});
    await ensureLoggedIn(page);
    return [];
  }

  let fullProjectName = projectName;
  let bidDueDate = '';
  try {
    const headerText = await projectPage.locator('body').innerText();
    if (isLockedProjectText(headerText)) {
      logger.info(`Skipping locked project after opening: ${projectName}`);
      await projectPage.close().catch(() => {});
      return [];
    }
    const nameMatch = headerText.match(/Project Name:\s*([^\n]+)/i);
    if (nameMatch) fullProjectName = nameMatch[1].trim();
    const dateMatch = headerText.match(/Bid Due Date\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
    if (dateMatch) bidDueDate = dateMatch[1].replace(/\//g, '-');
  } catch (err) {}

  const safeProjectName = fullProjectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
  const projectFolderName = bidDueDate ? `${safeProjectName} (${bidDueDate})` : safeProjectName;
  const projectScreenshotsDir = path.join(SCREENSHOTS_DIR, projectFolderName);
  fs.mkdirSync(projectScreenshotsDir, { recursive: true });

  // 3. Click on "Subcontractors" tab
  logger.info('   Opening Subcontractors tab...');
  const subTab = projectPage.locator('button, .mat-tab-label, .mat-mdc-tab').filter({ hasText: /^Subcontractors$/i }).first();
  await subTab.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await subTab.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await subTab.click().catch(async () => {
    await subTab.evaluate(el => el.click());
  });
  await projectPage.waitForTimeout(3000);

  // 4. Scroll internal containers to trigger loading (Crucial for subprojects list)
  await projectPage.evaluate(() => {
    const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], .mat-dialog-content, [class*="container"]');
    scrollables.forEach(el => {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    });
  });
  await projectPage.waitForTimeout(1500);

  let totalPages = 1;
  const pageText = await projectPage.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageText.match(/Page \d+ of (\d+)/);
  if (pageMatch) totalPages = parseInt(pageMatch[1]);

  const companyData = [];
  for (let subPage = 1; subPage <= totalPages; subPage++) {
    await waitWhileFleetPaused(projectPage);
    logger.step(`📄 Subcontractors page ${subPage}/${totalPages}`);
    
    await projectPage.evaluate(() => {
      const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], mat-dialog-content');
      scrollables.forEach(el => { el.scrollTop = el.scrollHeight; });
    });
    await projectPage.waitForTimeout(1500);
    
    const companiesOnThisPage = await collectCompanyEntries(projectPage);
    logger.info(`   Found ${companiesOnThisPage.length} companies on page ${subPage}`);
    
    for (const companyName of companiesOnThisPage) {
      const dedupKey = `${projectName}|||${companyName}`;
      if (PREVIOUS_SCRAPES.has(dedupKey)) continue;

      let companyPage = null;
      try {
        logger.info(`Opening ${companyName}...`);
        
        // Strategy 1: Try direct URL extraction (faster, avoids timeouts)
        const escapedName = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const anchor = projectPage.locator('a').filter({ hasText: new RegExp(`^\\s*${escapedName}(\\s|$)`, 'i') }).first();
        const href = await anchor.getAttribute('href').catch(() => null);

        if (href) {
          const absoluteUrl = href.startsWith('http') ? href : new URL(href, projectPage.url()).href;
          companyPage = await page.context().newPage();
          await companyPage.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          // Strategy 2: Ctrl+Click fallback
          const [openedPage] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 15000 }),
            projectPage.getByText(companyName).first().click({ modifiers: ['ControlOrMeta'] }),
          ]);
          companyPage = openedPage;
        }

        await companyPage.waitForLoadState('domcontentloaded');
        await companyPage.waitForTimeout(5000); 

        const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
        const screenshotPath = `${projectScreenshotsDir}/${safeFileName}.png`;
        
        await companyPage.screenshot({ path: screenshotPath, fullPage: true });
        
        const bodyText = await companyPage.locator('body').innerText().catch(() => '');
        const record = {
          projectFolder: projectScreenshotsDir,
          project: fullProjectName,
          bidDate: bidDueDate,
          company: companyName,
          email: bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null,
          phone: bodyText.match(/(\+?\d[\d\s().-]{9,})/)?.[0] || null,
          website: null,
          screenshot: screenshotPath,
          sourceFile: 'scraper.js',
          scraped_at: Date.now(),
          isNew: true,
        };
        companyData.push(record);
        PREVIOUS_SCRAPES.add(dedupKey);
        
        const currentTotal = (global.scrapedTodayCount || 0) + 1;
        global.scrapedTodayCount = currentTotal;
        telemetry.setCompaniesToday(currentTotal);
        
        await companyPage.close();
        logger.ok(`✓ ${companyName}`);
        telemetry.reportCompanies([record]);
      } catch (err) {
        logger.fail(`Failed ${companyName}: ${err.message}`);
        if (companyPage) await companyPage.close().catch(() => {});
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

async function paginate(page, nextPageNumber) {
  let success = false;

  const pageLabel = await page.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageLabel.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (pageMatch) {
    const totalPages = parseInt(pageMatch[2], 10);
    if (nextPageNumber > totalPages) {
      logger.info(`Project list has only ${totalPages} page(s); stopping pagination`);
      return false;
    }
  }

  // Try numeric page input
  try {
    const goToPageInput = page.locator('input[type="number"]').first();
    if (await goToPageInput.isVisible().catch(() => false)) {
      await goToPageInput.click();
      await goToPageInput.fill(String(nextPageNumber));
      await goToPageInput.press('Enter');
      await page.waitForTimeout(2500);
      success = true;
      logger.info(`Moving to project list page ${nextPageNumber}`);
    }
  } catch (err) {}

  if (!success) {
    try {
      const nextBtn = page.getByRole('button', { name: /next/i });
      if (await nextBtn.isVisible().catch(() => false) && await nextBtn.isEnabled()) {
        await nextBtn.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);
        success = true;
      }
    } catch (err) {}
  }

  if (!success) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const nextBtn = buttons.find(b =>
          !b.disabled && (
            /next/i.test((b.getAttribute('aria-label') || '')) ||
            /next/i.test((b.textContent || '')) ||
            (b.textContent || '').includes('arrow_forward_ios')
          )
        );
        if (!nextBtn) return false;
        nextBtn.scrollIntoView({ block: 'center', inline: 'center' });
        nextBtn.click();
        return true;
      });
      if (clicked) {
        await page.waitForTimeout(2500);
        success = true;
      }
    } catch (err) {}
  }

  return success;
}

async function main() {
  try {
    logger.step('PlanHub Scraper Pro');
    
    // 1. Verify VPN Connectivity
    logger.info('Checking VPN Status...');
    if (!ensureVpn()) {
      logger.fail('FATAL: VPN is required but disconnected. Aborting run.');
      if (telemetry.isEnabled()) {
         await telemetry.reportError('VPN Disconnected');
      }
      return;
    }

    logger.info('Launching Browser...');
    const browser = await chromium.launch({ headless: false, slowMo: 50 });
    const sessionPath = 'session.json';
    const contextOpts = { viewport: null }; // Remove fixed viewport for smaller screens
    if (fs.existsSync(sessionPath)) contextOpts.storageState = sessionPath;

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    let stopHeartbeat = () => {};

    try {
      logger.info('Checking Session...');
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
    const configOffset = 4; // User requested 4-day gap instead of 8
    let dayOffset = resumeOffset !== null ? resumeOffset : configOffset;

    const allData = [];
    const quarantine = [];
    global.scrapedTodayCount = 0; // Initialize global counter

    // Main Work Loop
    while (RUN_FOREVER || (Date.now() - START_TIME < MAX_RUNTIME_MS)) {
      let dayHasErrors = false;
      
      // 1. Select the Date Filter (now includes ZIP fetching and pasting)
      logger.step(`📅 Date Target: today+${dayOffset}`);
      try {
        await setDateFilter(page, dayOffset);
      } catch (err) {
        logger.fail(`❌ Filter set failed: ${err.message}`);
        dayHasErrors = true;
      }
      
      if (!dayHasErrors) {
        // 2. Scrape Projects
        let pageNum = 1;
        do {
          logger.step(`📄 Project List Page ${pageNum}`);
          const projects = await getProjectsOnCurrentPage(page);
          
          if (projects.length === 0) {
            logger.info(`ℹ️  No projects found on page ${pageNum}. Advancing date...`);
            break; // Exit the page loop immediately to change the date
          }

          for (const projectInfo of projects) {
            const projectName = typeof projectInfo === 'string' ? projectInfo : projectInfo.name;
            const isLocked = typeof projectInfo === 'object' && !!projectInfo.locked;

            if (isLocked) {
              logger.info(`Skipping locked project: ${projectName}`);
              continue;
            }

            try {
              const data = await scrapeProject(page, projectName);
              allData.push(...data);
              fs.writeFileSync(`${OUTPUT_DIR}/data.json`, JSON.stringify(allData, null, 2));
            } catch (err) {
              logger.fail(`❌ Failed: ${projectName} - ${err.message}`);
              dayHasErrors = true; // Mark day as failed if a project fails
              quarantine.push({ project: projectName, error: err.message, dateRange: `today+${dayOffset}` });
              fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
            }
          }
          pageNum++;
        } while (await paginate(page, pageNum));
      }

      // ONLY save progress if the ENTIRE day was processed without critical failures
      if (!dayHasErrors) {
        saveProgress(dayOffset);
        dayOffset++;
        logger.info('🔄 Day complete. Advancing...');
      } else {
        logger.fail(`⚠️ Skipping progress save for day +${dayOffset} due to errors. It will be retried next run.`);
        // Note: We DO NOT dayOffset++ here. The loop will restart on the same day.
        // To avoid infinite retry loops on a "stubborn" error, we'll add a short wait.
        await page.waitForTimeout(10000);
      }
      // Proceed immediately to next date without extra delay
    }

    logger.ok('🏁 Run complete.');
    await telemetry.reportRunComplete({ companiesScraped: allData.length, quarantined: quarantine.length });

    } finally {
      if (telemetry.isEnabled()) {
        await telemetry.reportStopping();
      }
      stopHeartbeat();
      await browser.close().catch(() => {});
    }
  } catch (globalErr) {
    logger.fail(`CRITICAL STARTUP ERROR: ${globalErr.message}`);
    console.error(globalErr);
  }
}

process.on('SIGINT', async () => {
  logger.info('\n🛑 Stopping... notifying dashboard');
  await telemetry.reportStopping().catch(() => {});
  process.exit(0);
});

main();