// PlanHub Scraper - Production Ready
// Based on recorded flow from codegen
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { SEL } from './selectors.js';
import { logger } from './logger.js';
import * as telemetry from './telemetry.js';

const START_TIME = Date.now();
const DEFAULT_MAX_RUNTIME_MS = 8.5 * 60 * 60 * 1000;

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const RUN_DATE = formatLocalDate();
const OUTPUT_DIR = `runs/${RUN_DATE}`;
fs.mkdirSync(`${OUTPUT_DIR}`, { recursive: true });
const OCR_DAILY_EXCEL = `${OUTPUT_DIR}/planhub_data.xlsx`;
const OCR_DAILY_JSON = `${OUTPUT_DIR}/ocr_daily_data.json`;

// Master screenshots folder - all screenshots go here regardless of date
const SCREENSHOTS_DIR = 'screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Load all previously scraped companies for deduplication
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
          // Create unique key: project + company name
          const key = `${entry.project}|||${entry.company}`;
          previousData.add(key);
        });
      } catch (err) {
        // Skip malformed JSON files
      }
    }
  }
  
  logger.info(`Loaded ${previousData.size} previously scraped companies for dedup`);
  return previousData;
}

let PREVIOUS_SCRAPES = loadPreviousData();
let COMPANY_ZIP_CODE = null;
const OCR_QUEUE = [];
const OCR_DRAIN_WAITERS = [];
let activeOcrJob = null;
let pausedTotalMs = 0;

function getElapsedRuntimeMs() {
  return Date.now() - START_TIME - pausedTotalMs;
}

function getConfiguredMaxRuntimeMs() {
  const configuredHours = Number(telemetry.state.remoteConfig.max_runtime_hours);
  if (Number.isFinite(configuredHours) && configuredHours > 0) {
    return configuredHours * 60 * 60 * 1000;
  }
  return DEFAULT_MAX_RUNTIME_MS;
}

async function waitWhileFleetPaused(page) {
  let pausedSince = null;

  while (telemetry.isPaused()) {
    if (pausedSince === null) {
      pausedSince = Date.now();
      telemetry.setStatus('paused');
      logger.info('Fleet pause is enabled from the panel. Waiting before continuing...');
    }
    await page.waitForTimeout(5000);
  }

  if (pausedSince !== null) {
    pausedTotalMs += Date.now() - pausedSince;
    telemetry.setStatus('running');
    logger.info('Fleet pause lifted. Resuming scrape.');
  }
}

function isLockedProjectText(text = '') {
  return /\blocked\b/i.test(text)
    || /unlock this project/i.test(text)
    || /upgrade to unlock/i.test(text)
    || /purchase .*unlock/i.test(text)
    || /to unlock/i.test(text);
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getPendingOcrImages(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => exts.has(name.slice(name.lastIndexOf('.')).toLowerCase()));
}

function resolveOcrDrainWaiters() {
  while (OCR_DRAIN_WAITERS.length) {
    const resolve = OCR_DRAIN_WAITERS.shift();
    resolve();
  }
}

function waitForOcrQueueToDrain() {
  if (!activeOcrJob && OCR_QUEUE.length === 0) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    OCR_DRAIN_WAITERS.push(resolve);
  });
}

function buildOcrRunnerCandidates(projectScreenshotsDir) {
  const sharedArgs = [
    '--folder', projectScreenshotsDir,
    '--no-prompt',
    '--output-excel', OCR_DAILY_EXCEL,
    '--aggregate-json', OCR_DAILY_JSON,
    '--run-date', RUN_DATE,
  ];

  const runners = [];
  const extractorExe = path.resolve('dist', 'PlanHubExtractor.exe');
  if (fs.existsSync(extractorExe)) {
    runners.push({
      command: extractorExe,
      args: sharedArgs,
    });
  }

  runners.push(
    {
      command: 'python',
      args: [
        'planhub_extractor.py',
        ...sharedArgs,
      ],
    },
    {
      command: 'py',
      args: [
        '-3',
        'planhub_extractor.py',
        ...sharedArgs,
      ],
    },
  );

  return runners;
}

function startNextOcrJob() {
  if (activeOcrJob) return;

  const nextJob = OCR_QUEUE.shift();
  if (!nextJob) {
    resolveOcrDrainWaiters();
    return;
  }

  const launchRunner = (runnerIndex = 0) => {
    const runner = nextJob.runners[runnerIndex];
    if (!runner) {
      logger.fail(`OCR failed for ${nextJob.projectName}: ${nextJob.lastFailure || 'all runners failed'}`);
      activeOcrJob = null;
      startNextOcrJob();
      return;
    }

    logger.step(`Running OCR for ${nextJob.projectName}`);
    const child = spawn(runner.command, runner.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });

    activeOcrJob = { child, projectName: nextJob.projectName };

    child.on('error', (err) => {
      nextJob.lastFailure = `${runner.command} ${runner.args.join(' ')} -> ${err.message}`;
    });

    child.on('close', (code) => {
      if (code === 0) {
        logger.ok(`OCR complete for ${nextJob.projectName}`);
        activeOcrJob = null;
        startNextOcrJob();
        return;
      }

      nextJob.lastFailure = `${runner.command} ${runner.args.join(' ')} -> exit code ${code ?? 'unknown'}`;
      activeOcrJob = null;
      launchRunner(runnerIndex + 1);
    });
  };

  launchRunner(0);
}

function enqueueOcrForProjectFolder(projectScreenshotsDir, projectName) {
  const pendingImages = getPendingOcrImages(projectScreenshotsDir);
  if (!pendingImages.length) {
    logger.info(`Skipping OCR for ${projectName} (no new screenshots in ${projectScreenshotsDir})`);
    return;
  }

  OCR_QUEUE.push({
    projectScreenshotsDir,
    projectName,
    runners: buildOcrRunnerCandidates(projectScreenshotsDir),
    lastFailure: null,
  });
  logger.info(`Queued OCR for ${projectName} (${pendingImages.length} image(s))`);
  startNextOcrJob();
}

function getPlanHubBlockMessage(text = '') {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (/blocked access from your country/i.test(normalized)) {
    return 'PlanHub is blocking this request by country. Connect through the expected US VPN path before scraping.';
  }

  if (/403 error/i.test(normalized) && /request could not be satisfied/i.test(normalized)) {
    return 'PlanHub returned the CloudFront 403 blocked-access page instead of the company profile.';
  }

  return null;
}

async function assertPlanHubAccessible(page, label) {
  const [title, bodyText, url] = await Promise.all([
    page.title().catch(() => ''),
    page.locator('body').innerText().catch(() => ''),
    Promise.resolve(page.url()),
  ]);

  const blockedMessage = getPlanHubBlockMessage(`${title}\n${bodyText}`);
  if (blockedMessage) {
    throw new Error(`${label}: ${blockedMessage} URL: ${url}`);
  }
}

function isRetryablePageError(err) {
  const message = err?.message || '';
  return /timeout|navigation|net::|target closed|page crashed|execution context was destroyed|ERR_/i.test(message);
}

async function retryImmediately(label, action, { attempts = 2, delayMs = 750 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isRetryablePageError(err)) {
        throw err;
      }
      logger.fail(`${label} failed: ${err.message}. Retrying immediately (${attempt + 1}/${attempts})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function gotoWithRetry(page, url, options = {}, label = `goto ${url}`) {
  const result = await retryImmediately(label, () =>
    page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded', ...options })
  );
  if (/planhub\.com/i.test(url)) {
    await assertPlanHubAccessible(page, label);
  }
  return result;
}

async function waitForURLWithRetry(page, urlOrRegex, options = {}, label = 'waitForURL') {
  return retryImmediately(label, () =>
    page.waitForURL(urlOrRegex, options)
  );
}

async function waitForLoadStateWithRetry(page, state = 'domcontentloaded', options = {}, label = `waitForLoadState ${state}`) {
  return retryImmediately(label, () =>
    page.waitForLoadState(state, options)
  );
}

async function waitForSelectorWithRetry(page, selector, options = {}, label = `waitForSelector ${selector}`) {
  return retryImmediately(label, () =>
    page.waitForSelector(selector, options)
  );
}

function normalizeCompanyName(rawText = '') {
  const lines = rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) return '';

  const name = lines[0];
  if (/^(company name|location|phone|email|website)$/i.test(name)) return '';
  return name;
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function openCompanyPage(projectPage, companyName) {
  const browserContext = projectPage.context();
  const escapedCompanyName = escapeRegex(companyName);

  // ── Strategy 1: extract href from an anchor and navigate directly ──────────
  // Ctrl+click only opens a new tab on real <a> tags. PlanHub's Angular/Material
  // components often render company names as <div>/<span> with JS click handlers,
  // so Ctrl+click fires the handler in the same tab but never emits a 'page' event.
  // That causes waitForEvent to burn its full 20s timeout — times 4 factories = stuck.
  // Instead, pull the href directly and open it in a fresh page ourselves.
  const anchorCandidates = [
    projectPage.locator('a').filter({ hasText: new RegExp(`^\\s*${escapedCompanyName}(\\s|$)`, 'i') }).first(),
    projectPage.locator(SEL.company.row).filter({ hasText: new RegExp(`^\\s*${escapedCompanyName}(\\s|$)`, 'i') }).locator('a').first(),
  ];

  for (const anchor of anchorCandidates) {
    try {
      if (!await anchor.count().catch(() => 0)) continue;
      const href = await anchor.getAttribute('href').catch(() => null);
      if (!href) continue;

      const absoluteUrl = href.startsWith('http')
        ? href
        : new URL(href, projectPage.url()).href;

      const companyPage = await browserContext.newPage();
      await gotoWithRetry(companyPage, absoluteUrl, {}, `Open company page: ${companyName}`);
      await companyPage.bringToFront().catch(() => {});
      await companyPage.waitForTimeout(1500);
      return companyPage;
    } catch (err) {
      // href strategy failed for this candidate — try next
    }
  }

  // ── Strategy 2: Ctrl+click fallback (works when the element IS a real <a>) ─
  const locatorFactories = [
    () => projectPage.getByText(companyName).first(),
    () => projectPage.locator('a').filter({ hasText: new RegExp(`^\\s*${escapedCompanyName}(\\s|$)`, 'i') }).first(),
    () => projectPage.locator(SEL.company.row).filter({ hasText: new RegExp(`^\\s*${escapedCompanyName}(\\s|$)`, 'i') }).first(),
    () => projectPage.getByText(new RegExp(escapedCompanyName, 'i')).first(),
  ];

  let lastError = null;
  for (const buildLocator of locatorFactories) {
    try {
      const companyTrigger = buildLocator();
      if (!await companyTrigger.count().catch(() => 0)) continue;

      await companyTrigger.scrollIntoViewIfNeeded().catch(() => {});

      const [companyPage] = await Promise.all([
        browserContext.waitForEvent('page', { timeout: 20000 }),
        companyTrigger.click({ modifiers: ['ControlOrMeta'] }),
      ]);

      await waitForLoadStateWithRetry(companyPage, 'domcontentloaded', {}, `Wait for company page load: ${companyName}`);
      await companyPage.bringToFront().catch(() => {});
      await companyPage.waitForTimeout(1500);
      return companyPage;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Company page did not open for ${companyName}${lastError ? `: ${lastError.message}` : ''}`);
}

async function getCompanyPageReadiness(companyPage) {
  return companyPage.evaluate(() => {
    const body = document.body;
    if (!body) {
      return {
        hasBody: false,
        bodyVisible: false,
        textLength: 0,
        loadingVisible: false,
        hasProfileSignals: false,
        hasContactSignals: false,
        url: location.href,
      };
    }

    const style = window.getComputedStyle(body);
    const rect = body.getBoundingClientRect();
    const bodyVisible = style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;

    const bodyText = (body.innerText || '').replace(/\s+/g, ' ').trim();
    const loadingSelectors = [
      '[role="progressbar"]',
      '.mat-progress-bar',
      '.mat-progress-spinner',
      '.mat-spinner',
      '.loading',
      '.loader',
      '[class*="loading"]',
      '[class*="spinner"]',
    ];

    const loadingVisible = loadingSelectors.some(selector =>
      [...document.querySelectorAll(selector)].some(el => {
        const elRect = el.getBoundingClientRect();
        const elStyle = window.getComputedStyle(el);
        return elRect.width > 0
          && elRect.height > 0
          && elStyle.display !== 'none'
          && elStyle.visibility !== 'hidden'
          && elStyle.opacity !== '0';
      })
    );

    return {
      hasBody: true,
      bodyVisible,
      textLength: bodyText.length,
      loadingVisible,
      hasProfileSignals: /general information|about|services provided|regions covered|message this business/i.test(bodyText),
      hasContactSignals: /email|phone|telephone number|website|address/i.test(bodyText),
      url: location.href,
    };
  }).catch(() => ({
    hasBody: false,
    bodyVisible: false,
    textLength: 0,
    loadingVisible: false,
    hasProfileSignals: false,
    hasContactSignals: false,
    url: companyPage.url(),
  }));
}

async function waitForCompanyPageReady(companyPage, companyName) {
  await waitForLoadStateWithRetry(companyPage, 'domcontentloaded', {}, `Wait for company page DOM: ${companyName}`);
  await companyPage.bringToFront().catch(() => {});
  await companyPage.waitForTimeout(1200);
  await companyPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await companyPage.waitForTimeout(1500);
  await assertPlanHubAccessible(companyPage, `Company page blocked for ${companyName}`);

  const deadline = Date.now() + 30000;
  let readiness = await getCompanyPageReadiness(companyPage);

  while (Date.now() < deadline) {
    const contentReady = readiness.bodyVisible
      && (readiness.hasProfileSignals || readiness.hasContactSignals || readiness.textLength > 250);
    if (contentReady) break;

    await companyPage.waitForTimeout(1000);
    readiness = await getCompanyPageReadiness(companyPage);
  }

  const contentReady = readiness.bodyVisible
    && (readiness.hasProfileSignals || readiness.hasContactSignals || readiness.textLength > 250);

  // Fallback: any visible page with minimal text — removed the brittle URL check
  // (/company-profile/ in the URL) since PlanHub routing varies and was blocking
  // virtually all screenshots.
  const fallbackReady = readiness.bodyVisible && readiness.textLength > 80;

  if (!contentReady && !fallbackReady) {
    throw new Error(`Company page never became screenshot-ready for ${companyName}`);
  }

  if (!contentReady && fallbackReady) {
    logger.info(`Proceeding with screenshot for ${companyName} (fallback: body visible, ${readiness.textLength} chars)`);
  }

  await companyPage.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await companyPage.waitForTimeout(1500);
}

async function login(page) {
  logger.step('Login');
  await gotoWithRetry(page, 'https://access.planhub.com/signin', {}, 'Open PlanHub sign-in');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.PLANHUB_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PLANHUB_PASSWORD);
  const signInSubmit = page.locator(SEL.auth.signInSubmit).first();
  if (await signInSubmit.isVisible().catch(() => false)) {
    await signInSubmit.click();
  } else {
    await page.getByRole('button', { name: 'Sign In', exact: true }).last().click();
  }
  await waitForURLWithRetry(page, /supplier\.planhub\.com/, { timeout: 60000 }, 'Wait for PlanHub dashboard');
  await waitForLoadStateWithRetry(page, 'domcontentloaded', {}, 'Wait for dashboard load');
  await page.waitForTimeout(2000);
  logger.ok('Logged in');
}

// Checks if the page got redirected to signin (session died mid-run).
// If so, re-logs in, re-saves the session, and navigates back to where we were.
// Returns true if a re-login happened, false if session was still valid.
async function ensureLoggedIn(page, returnUrl = 'https://supplier.planhub.com/project/list') {
  const url = page.url();
  const needsLogin = /signin|login|access\.planhub\.com/i.test(url);
  if (!needsLogin) return false;

  logger.fail('⚠️  Session expired mid-run — re-authenticating');
  await login(page);
  await page.context().storageState({ path: 'session.json' });
  logger.ok('Session refreshed and saved');

  if (returnUrl) {
    await gotoWithRetry(page, returnUrl, {}, 'Return after re-login');
    await page.waitForTimeout(2000);
  }
  return true;
}

async function openProjectSearchFilters(page) {
  await waitForSelectorWithRetry(page, 'text=/search/i', { timeout: 30000 }, 'Wait for project search filters');
  await page.waitForTimeout(1500);
  await page.getByLabel('Search (2)').getByRole('button').filter({ hasText: /^$/ }).click();
  await page.waitForTimeout(1000);
}

async function getCompanyZipCode(page) {
  if (COMPANY_ZIP_CODE) return COMPANY_ZIP_CODE;

  logger.step('Fetching company ZIP code from account settings');

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

async function applyDateZipAndDistanceFilters(page, dayOffset, zipCode) {
  await openProjectSearchFilters(page);

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
    const ariaLabel = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const btn = page.locator(`button[aria-label="${ariaLabel}"]`).first();
    await btn.waitFor({ state: 'attached', timeout: 10000 });
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };

  await clickCalendarDay(startDate);
  await page.waitForTimeout(500);
  await clickCalendarDay(endDate);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  const zipInput = page.getByRole('searchbox', { name: /Zip Code/i }).first();
  await zipInput.waitFor({ state: 'visible', timeout: 10000 });
  await zipInput.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await zipInput.click();
  await zipInput.press('ControlOrMeta+a');
  await zipInput.fill(zipCode);
  await zipInput.press('Tab').catch(() => {});
  await page.waitForTimeout(800);

  const distanceField = page.locator(SEL.dateFilter.distanceField).filter({
    has: page.locator('mat-label').filter({ hasText: /^Distance$/ }),
  }).first();
  await distanceField.waitFor({ state: 'visible', timeout: 10000 });
  await distanceField.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));

  const distanceTrigger = distanceField.locator(SEL.dateFilter.distanceTrigger).first();
  await distanceTrigger.click().catch(async () => {
    await distanceTrigger.evaluate(el => el.click());
  });
  await page.waitForTimeout(500);

  const distanceOptions = page.locator(SEL.dateFilter.distanceOption).filter({ hasText: /^\s*200(\s*miles)?\s*$/i });
  if (!await distanceOptions.first().isVisible().catch(() => false)) {
    await distanceTrigger.press('Space').catch(() => {});
    await page.waitForTimeout(300);
  }

  if (await distanceOptions.first().isVisible().catch(() => false)) {
    await distanceOptions.first().click();
  } else {
    throw new Error('Distance dropdown did not open after clicking the trigger');
  }
  await page.waitForTimeout(1000);

  return { startDate, endDate };
}

async function setDateFilter(page, dayOffset = 0) {
  logger.step(`Setting date filter for single day: today+${dayOffset}`);
  await page.goto('https://supplier.planhub.com/project/list', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // If session died, re-login and come back to project/list before continuing
  await ensureLoggedIn(page);

  await page.waitForSelector('text=/search/i', { timeout: 30000 });
  await page.waitForTimeout(2000);

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
  // Single-day window: start and end are the SAME date
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + dayOffset);
  const endDate = new Date(startDate);

  const formatMonthDay = (d) =>
    d.toLocaleString('en-US', { month: 'long', day: 'numeric' });

  // Click calendar day by aria-label. Use native DOM scroll + force click because
  // Material's cdk-overlay calendar reports elements as "outside viewport" even
  // when visible, making normal Playwright clicks time out.
  const clickCalendarDay = async (d) => {
    const ariaLabel = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const btn = page.locator(`button[aria-label="${ariaLabel}"]`).first();
    await btn.waitFor({ state: 'attached', timeout: 10000 });
    // Dispatch click via DOM — bypasses Playwright's viewport/actionability checks
    // which fail on Material cdk-overlay calendars.
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };

  await clickCalendarDay(startDate);
  await page.waitForTimeout(500);
  await clickCalendarDay(endDate);
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  logger.ok(`Filter set: ${formatMonthDay(startDate)} → ${formatMonthDay(endDate)}`);
}

async function setDateFilterWithZip(page, dayOffset = 0) {
  logger.step(`Setting date filter for single day: today+${dayOffset}`);
  await gotoWithRetry(page, 'https://supplier.planhub.com/project/list', {}, 'Open project list for date filter');
  await page.waitForTimeout(1500);

  await ensureLoggedIn(page);

  const formatMonthDay = (d) =>
    d.toLocaleString('en-US', { month: 'long', day: 'numeric' });

  const zipCode = await getCompanyZipCode(page);
  await gotoWithRetry(page, 'https://supplier.planhub.com/project/list', {}, 'Re-open project list after ZIP lookup');
  await waitForURLWithRetry(page, /supplier\.planhub\.com\/project\/list/, { timeout: 60000 }, 'Confirm project list URL');
  await page.waitForTimeout(2000);
  await ensureLoggedIn(page);

  const { startDate, endDate } = await applyDateZipAndDistanceFilters(page, dayOffset, zipCode);

  logger.ok(`Filter set: ${formatMonthDay(startDate)} -> ${formatMonthDay(endDate)} | ZIP ${zipCode} | 200 miles`);
}

async function getProjectsOnCurrentPage(page) {
  await waitForSelectorWithRetry(page, 'table tr', { timeout: 10000 }, 'Wait for project table rows');
  const rows = await page.locator('table tbody tr').all();
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

async function scrapeProject(page, projectInfo) {
  const projectName = typeof projectInfo === 'string' ? projectInfo : projectInfo.name;
  const knownLocked = typeof projectInfo === 'object' && Boolean(projectInfo.locked);

  if (knownLocked) {
    logger.info(`Skipping locked project: ${projectName}`);
    return [];
  }

  logger.step(`Scraping project: ${projectName}`);
  telemetry.setCurrentProject(projectName);

  const [projectPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('table').getByText(projectName).first().click().then(async () => {
      await page.getByRole('button', { name: 'View Project Details' }).click();
    }),
  ]);

  await waitForLoadStateWithRetry(projectPage, 'domcontentloaded', {}, `Wait for project page load: ${projectName}`);
  await projectPage.waitForTimeout(3000);

  // If the project tab got kicked to signin, recover on main page and skip this project.
  // Next iteration of the outer loop will proceed with the refreshed session.
  if (/signin|login|access\.planhub\.com/i.test(projectPage.url())) {
    logger.fail('⚠️  Project tab hit signin — re-authenticating, skipping this project');
    await projectPage.close().catch(() => {});
    await ensureLoggedIn(page);
    return [];
  }

  // Extract full project name and bid due date from the project page
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
  } catch (err) {
    logger.fail(`Could not extract project header: ${err.message}`);
  }

  // Clean folder name: strip only Windows-illegal chars, collapse whitespace
  const safeProjectName = fullProjectName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const projectFolderName = bidDueDate ? `${safeProjectName} (${bidDueDate})` : safeProjectName;
  const projectScreenshotsDir = `${SCREENSHOTS_DIR}/${projectFolderName}`;
  fs.mkdirSync(projectScreenshotsDir, { recursive: true });
  logger.info(`📁 Project folder: ${projectScreenshotsDir}`);

  await projectPage.getByRole('button', { name: 'Subcontractors' }).click();
  await projectPage.waitForTimeout(2500);

  // Find total pages from "Page X of Y" text
  let totalPages = 1;
  const pageText = await projectPage.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageText.match(/Page \d+ of (\d+)/);
  if (pageMatch) {
    totalPages = parseInt(pageMatch[1]);
    logger.info(`Found ${totalPages} subcontractor pages`);
  } else {
    logger.info(`Single subcontractor page detected`);
  }

  const companyData = [];
  let newCount = 0;
  let skippedCount = 0;
  let totalCompaniesFound = 0;
  
  // Process each page COMPLETELY before moving to next page
  for (let subPage = 1; subPage <= totalPages; subPage++) {
    await waitWhileFleetPaused(projectPage);
    logger.step(`📄 Processing subcontractor page ${subPage}/${totalPages}`);
    
    // Scroll internal containers to load company list
    await projectPage.evaluate(() => {
      const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], .mat-dialog-content, mat-dialog-content, [class*="container"]');
      scrollables.forEach(el => {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
    await projectPage.waitForTimeout(1500);
    
    // Collect companies on THIS page only
    const companiesOnThisPage = await collectCompanyEntries(projectPage);
    
    logger.info(`Found ${companiesOnThisPage.length} companies on page ${subPage}`);
    totalCompaniesFound += companiesOnThisPage.length;
    
    // Open each company on this page, screenshot, close, move to next company
    for (const companyName of companiesOnThisPage) {
      await waitWhileFleetPaused(projectPage);
      let companyPage = null;
      try {
        // Check if already scraped
        const dedupKey = `${projectName}|||${companyName}`;
        if (PREVIOUS_SCRAPES.has(dedupKey)) {
          logger.info(`⏭️  Skipping ${companyName} (already scraped)`);
          skippedCount++;
          continue;
        }

        logger.info(`Opening ${companyName}...`);

        await projectPage.bringToFront().catch(() => {});
        await projectPage.waitForTimeout(300);

        const [openedCompanyPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 15000 }),
          projectPage.getByText(companyName).first().click({ modifiers: ['ControlOrMeta'] }),
        ]);
        companyPage = openedCompanyPage;

        await companyPage.waitForLoadState('domcontentloaded');
        await companyPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await companyPage.waitForTimeout(1500);

        // ═══════════════════════════════════════════════════════════════
        // HIGH-QUALITY SCREENSHOT FOR OCR
        // ═══════════════════════════════════════════════════════════════
        const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const timestamp = RUN_DATE;
        const screenshotPath = `${projectScreenshotsDir}/${safeFileName}_${timestamp}.png`;
        const sourceFile = `${projectFolderName}/${path.basename(screenshotPath)}`;
        
        await companyPage.screenshot({ 
          path: screenshotPath, 
          fullPage: true,
          type: 'png',              // Force PNG (lossless compression)
          scale: 'device',          // Use device pixel ratio (2x on retina = 2x sharper text)
          animations: 'disabled',   // Disable animations for cleaner capture
        });
        
        logger.info(`📸 Screenshot saved (high-quality PNG for OCR)`);

        // Extract contact info
        const bodyText = await companyPage.locator('body').innerText().catch(() => '');
        const email = bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null;
        const phone = bodyText.match(/(\+?\d[\d\s().-]{9,})/)?.[0] || null;
        const website = bodyText.match(/https?:\/\/[^\s]+/)?.[0] || null;

        const record = {
          projectFolder: projectFolderName,
          project: fullProjectName,
          bidDate: bidDueDate,
          company: companyName,
          email,
          phone,
          website,
          screenshot: screenshotPath,
          sourceFile,
          scrapedAt: new Date().toISOString(),
          isNew: true,
        };
        companyData.push(record);

        newCount++;
        telemetry.incCompanies(1);
        // Upload this single company immediately so the panel updates in real time
        // (fire-and-forget — network failure does not block scraping)
        telemetry.reportCompanies([record]);

        await companyPage.close();
        await projectPage.bringToFront().catch(() => {});
        logger.ok(`✓ ${companyName} - done`);

      } catch (err) {
        await companyPage?.close().catch(() => {});
        await projectPage.bringToFront().catch(() => {});
        logger.fail(`Failed ${companyName}: ${err.message}`);
      }
    }
    
    logger.ok(`✅ Page ${subPage}/${totalPages} complete`);
    
    // If this was the last page, we're done
    if (subPage >= totalPages) {
      logger.info(`All ${totalPages} pages processed`);
      break;
    }
    
    // Navigate to next page using "Go to page" input
    let success = false;
    try {
      const goToPageInput = projectPage.locator('input[type="number"]').first();
      if (await goToPageInput.isVisible().catch(() => false)) {
        await goToPageInput.click();
        await goToPageInput.fill(String(subPage + 1));
        await goToPageInput.press('Enter');
        await projectPage.waitForTimeout(2500);
        success = true;
        logger.info(`➡️ Moving to page ${subPage + 1}`);
      }
    } catch (err) {
      logger.fail(`Go to page input failed: ${err.message}`);
    }
    
    // Fallback: JS click on arrow
    if (!success) {
      try {
        const clicked = await projectPage.evaluate(() => {
          const buttons = [...document.querySelectorAll('button')];
          const nextBtn = buttons.find(b => 
            b.textContent.includes('arrow_forward_ios') && !b.disabled
          );
          if (nextBtn) {
            nextBtn.scrollIntoView();
            nextBtn.click();
            return true;
          }
          return false;
        });
        if (clicked) {
          await projectPage.waitForTimeout(2500);
          success = true;
          logger.info(`➡️ Clicked next via JS fallback`);
        }
      } catch (err) {
        logger.fail(`JS click failed: ${err.message}`);
      }
    }
    
    if (!success) {
      logger.fail(`Could not navigate to page ${subPage + 1}, stopping`);
      break;
    }
  }

  logger.info(`📊 Total: ${totalCompaniesFound} companies across ${totalPages} pages`);

  await projectPage.close();
  enqueueOcrForProjectFolder(projectScreenshotsDir, projectFolderName);
  
  logger.info(`📊 ${projectName} summary: ${newCount} new, ${skippedCount} skipped`);
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

  // Main project list sometimes exposes a numeric page input instead of a labeled "Next" button.
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
  } catch (err) {
    logger.fail(`Main list go-to-page failed: ${err.message}`);
  }

  if (!success) {
    try {
      const nextBtn = page.getByRole('button', { name: /next/i });
      if (await nextBtn.isVisible().catch(() => false) && await nextBtn.isEnabled()) {
        await nextBtn.click();
        await waitForLoadStateWithRetry(page, 'domcontentloaded', {}, `Wait for main list page ${nextPageNumber} load`);
        await page.waitForTimeout(2000);
        success = true;
        logger.info(`Clicked main list next button to page ${nextPageNumber}`);
      }
    } catch (err) {
      logger.fail(`Main list next button failed: ${err.message}`);
    }
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
        logger.info(`Clicked main list next fallback to page ${nextPageNumber}`);
      }
    } catch (err) {
      logger.fail(`Main list JS fallback failed: ${err.message}`);
    }
  }

  return success;
}

async function main() {
  // Dropped slowMo from 500 → 50. slowMo adds that delay to EVERY playwright action
  // (clicks, fills, waits) which was the main reason company iteration felt slow.
  const browser = await chromium.launch({ headless: false, slowMo: 50 });

  const sessionPath = 'session.json';
  const contextOpts = {};
  if (fs.existsSync(sessionPath)) {
    contextOpts.storageState = sessionPath;
    logger.info('Reusing saved session');
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Declared outside try so finally can always clean it up
  let stopHeartbeat = () => {};

  try {
    if (!fs.existsSync(sessionPath)) {
      await login(page);
      await context.storageState({ path: sessionPath });
    } else {
      await gotoWithRetry(page, 'https://supplier.planhub.com/project/list', {}, 'Open project list from saved session');
      if (page.url().includes('signin')) {
        logger.info('Session expired, re-logging in');
        await login(page);
        await context.storageState({ path: sessionPath });
      }
    }

    // Starting offset: first day to scrape, relative to today.
    // Controlled via START_DATE_OFFSET in .env. Default 4 (so deploying on the 19th
    // starts on the 23rd — gives enough lead time to actually bid on the projects).
    const START_OFFSET = parseInt(process.env.START_DATE_OFFSET ?? '4', 10);
    let dayOffset = Number.isFinite(START_OFFSET) ? START_OFFSET : 4;

    stopHeartbeat = telemetry.startHeartbeat();
    await page.waitForTimeout(1000);
    await waitWhileFleetPaused(page);

    await setDateFilterWithZip(page, dayOffset);

    const allData = [];
    const quarantine = [];
    let pageNum = 1;
    let totalRanges = 0;

    await waitWhileFleetPaused(page);
    // Continuous loop: keep shifting date window forward until time limit
    while (getElapsedRuntimeMs() < getConfiguredMaxRuntimeMs()) {
      await waitWhileFleetPaused(page);

      totalRanges++;
      const elapsed = (getElapsedRuntimeMs() / 1000 / 60).toFixed(1);
      logger.step(`📅 Day #${totalRanges} — today+${dayOffset} (${elapsed} min elapsed)`);
      
      // Reset page counter for this date range
      pageNum = 1;

      do {
        await waitWhileFleetPaused(page);
        // Check time before processing each page
        if (getElapsedRuntimeMs() >= getConfiguredMaxRuntimeMs()) {
          logger.info('⏰ Time limit reached, stopping gracefully...');
          break;
        }

        logger.step(`Processing page ${pageNum}`);
        const projects = await getProjectsOnCurrentPage(page);
        const lockedProjects = projects.filter(project => project.locked).length;
        logger.info(`${projects.length} projects on page ${pageNum}${lockedProjects ? ` (${lockedProjects} locked)` : ''}`);

        for (const project of projects) {
          await waitWhileFleetPaused(page);
          // Check time before each project
          if (getElapsedRuntimeMs() >= getConfiguredMaxRuntimeMs()) {
            logger.info('⏰ Time limit reached, stopping gracefully...');
            break;
          }

          if (project.locked) {
            logger.info(`Skipping locked project on list page: ${project.name}`);
            continue;
          }

          const projectName = project.name;

          try {
            const data = await scrapeProject(page, project);
            allData.push(...data);
            ensureDir(OUTPUT_DIR);
            fs.writeFileSync(`${OUTPUT_DIR}/data.json`, JSON.stringify(allData, null, 2));
            // (Companies already uploaded live as each was scraped — no batch upload needed)
          } catch (err) {
            // One bad project must never kill an 8.5hr run.
            // Quarantine it, take a diagnostic screenshot, move on.
            logger.fail(`❌ Project failed: ${projectName} — ${err.message}`);
            const entry = {
              project: projectName,
              error: err.message,
              stack: err.stack,
              failedAt: new Date().toISOString(),
              dateRange: `today+${dayOffset}`,
            };
            quarantine.push(entry);
            ensureDir(OUTPUT_DIR);
            fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
            telemetry.reportQuarantine(entry);
            // Diagnostic screenshot of whatever state the main page is in
            ensureDir(OUTPUT_DIR);
            await page.screenshot({
              path: `${OUTPUT_DIR}/quarantine-${Date.now()}.png`,
              fullPage: true,
            }).catch(() => {});
            // Make sure we're back on project/list with a valid session before next iteration
            await gotoWithRetry(page, 'https://supplier.planhub.com/project/list', {}, 'Recover project list after project failure').catch(() => {});
            await ensureLoggedIn(page);
            await page.waitForTimeout(2000);
          }
        }

        pageNum++;
      } while (await paginate(page, pageNum) && getElapsedRuntimeMs() < getConfiguredMaxRuntimeMs());

      // Move to the next day
      dayOffset++;
      logger.info(`🔄 Advancing to next day: today+${dayOffset}...`);

      // Setting the date filter can fail (PlanHub DOM quirks). Don't let that kill the run —
      // retry once, and if it still fails, skip this day and try the next.
      try {
        await setDateFilterWithZip(page, dayOffset);
      } catch (err) {
        logger.fail(`⚠️  setDateFilter failed for day +${dayOffset}: ${err.message} — retrying once`);
        await page.waitForTimeout(3000);
        try {
          await setDateFilterWithZip(page, dayOffset);
        } catch (err2) {
          logger.fail(`❌ setDateFilter failed twice for day +${dayOffset}, skipping this day`);
          quarantine.push({
            project: '(date-filter)',
            error: err2.message,
            failedAt: new Date().toISOString(),
            dateRange: `today+${dayOffset}`,
          });
          ensureDir(OUTPUT_DIR);
          fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
          continue;
        }
      }

      // Small pause between date ranges
      await page.waitForTimeout(3000);
    }

    const csv = [
      'project,bid_date,company,email,phone,website,screenshot',
      ...allData.map(d =>
        [d.project, d.bidDate, d.company, d.email, d.phone, d.website, d.screenshot]
          .map(v => `"${(v || '').replace(/"/g, '""')}"`)
          .join(',')
      ),
    ].join('\n');
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(`${OUTPUT_DIR}/data.csv`, csv);
    
    // Write new-companies-only CSV (filtered)
    const newCompanies = allData.filter(d => d.isNew);
    if (newCompanies.length > 0) {
      const newCsv = [
        'project,bid_date,company,email,phone,website,screenshot',
        ...newCompanies.map(d =>
          [d.project, d.bidDate, d.company, d.email, d.phone, d.website, d.screenshot]
            .map(v => `"${(v || '').replace(/"/g, '""')}"`)
            .join(',')
        ),
      ].join('\n');
      ensureDir(OUTPUT_DIR);
      fs.writeFileSync(`${OUTPUT_DIR}/new-companies.csv`, newCsv);
    }

    logger.ok(`DONE — Processed ${totalRanges} date ranges in ${(getElapsedRuntimeMs() / 1000 / 60 / 60).toFixed(2)} hours`);
    if (activeOcrJob || OCR_QUEUE.length > 0) {
      logger.info('Waiting for background OCR jobs to finish updating the daily sheet...');
      await waitForOcrQueueToDrain();
    }
    logger.ok(`Total: ${allData.length} companies (${newCompanies.length} new)`);
    if (quarantine.length > 0) {
      logger.fail(`⚠️  ${quarantine.length} project(s) quarantined — see ${OUTPUT_DIR}/quarantine.json`);
    } else {
      logger.ok(`✓ Zero failed projects`);
    }
    logger.info(`Output: ${OUTPUT_DIR}/`);
    logger.info(`📄 data.csv = all companies | new-companies.csv = only new ones`);

    // Final run summary to telemetry backend
    await telemetry.reportRunComplete({
      companiesScraped: allData.length,
      newCompanies: newCompanies.length,
      dateRanges: totalRanges,
      quarantined: quarantine.length,
    });
  } catch (err) {
    logger.fail(`Fatal error: ${err.message}`);
    ensureDir(OUTPUT_DIR);
    await page.screenshot({ path: `${OUTPUT_DIR}/fatal-error.png`, fullPage: true }).catch(() => {});
    telemetry.setStatus('error');
    // Surface the crash in the admin Quarantine tab so you can see it happened.
    // Marked with the '(fatal)' project tag so it's distinguishable from a failed project.
    await telemetry.reportQuarantine({
      project: '(fatal)',
      error: err.message,
      stack: err.stack,
      dateRange: 'crashed',
    }).catch(() => {});
    // Non-zero exit — the launcher bat picks this up and restarts the scraper.
    // session.json + local dedup cache mean it resumes cleanly (skips already-scraped).
    process.exitCode = 1;
  } finally {
    if (activeOcrJob || OCR_QUEUE.length > 0) {
      logger.info('Waiting for background OCR jobs to drain before shutdown...');
      await waitForOcrQueueToDrain();
    }
    stopHeartbeat();
    await browser.close();
  }
}

main();
