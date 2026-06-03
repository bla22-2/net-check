const fs = require("fs");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ======================================================
// SETTINGS
// ======================================================

const INPUT_FILE = "avai-net.txt";
const RESULTS_FILE = "results.txt";
const RESUME_FILE = "last-domain.txt";

const MIN_SCORE = 6;
const MIN_TLDS = 10;
const AUTO_PASS_TLDS = 20;

const WORKERS = 4;

const MIN_DELAY = 150;
const MAX_DELAY = 500;

const PAGE_RECYCLE_INTERVAL = 150;

// Stop 10 minutes before GitHub timeout (250 min) = 240 min = 4h
const MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay() {
  return Math.floor(
    Math.random() * (MAX_DELAY - MIN_DELAY + 1) + MIN_DELAY
  );
}

// ======================================================
// LOAD DOMAINS
// ======================================================

function loadAllDomains() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.log(`Missing input file: ${INPUT_FILE}`);
    process.exit(1);
  }
  return fs
    .readFileSync(INPUT_FILE, "utf8")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ======================================================
// RESUME LOGIC
// ======================================================

function findResumeIndex(names) {
  try {
    if (!fs.existsSync(RESUME_FILE)) return 0;
    const lastName = fs.readFileSync(RESUME_FILE, "utf8").trim();
    if (!lastName) return 0;
    const index = names.indexOf(lastName);
    if (index === -1) {
      console.log("Resume domain not found, starting from beginning.");
      return 0;
    }
    console.log(`Resuming after: ${lastName}`);
    return index + 1;
  } catch (err) {
    console.log("Resume failed:", err.message);
    return 0;
  }
}

// ======================================================
// SAVE RESUME POSITION
// ======================================================

function saveLastDomain(name) {
  try {
    fs.writeFileSync(RESUME_FILE, name, "utf8");
  } catch (err) {
    console.log("Resume save failed:", err.message);
  }
}

// ======================================================
// SAVE RESULTS
// ======================================================

function saveResult(domain, score, tlds, appraisal) {
  try {
    fs.appendFileSync(
      RESULTS_FILE,
      `${domain} | score: ${score} | tlds: ${tlds} | ${appraisal}\n`
    );
  } catch (err) {
    console.log("Result save failed:", err.message);
  }
}

// ======================================================
// LAUNCH BROWSER
// ======================================================

async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--js-flags=--max-old-space-size=256",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

// ======================================================
// CREATE A FRESH PAGE
// ======================================================

async function createPage(browser) {
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  );

  await page.setViewport({ width: 1366, height: 768 });

  await page.setRequestInterception(true);

  page.on("request", (req) => {
    const type = req.resourceType();
    if (
      type === "image" ||
      type === "stylesheet" ||
      type === "font" ||
      type === "media"
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto("https://www.atom.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch {}

  return page;
}

// ======================================================
// FETCH HTML
// ======================================================

async function fetchHtml(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    return await page.content();
  } catch {
    return null;
  }
}

// ======================================================
// EXTRACT DATA
// ======================================================

function extractDataFromHtml(html) {
  if (!html) return null;

  try {
    const scoreMatch = html.match(
      /id="chart_div_score"[^>]*data-str="([\d.]+)"/i
    );
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

    let tlds = 0;
    const tldSection = html.match(
      /Extensions Registered[\s\S]*?class="price">([^<]+)</i
    );
    if (tldSection) {
      tlds = parseInt(tldSection[1].replace(/[^\d]/g, "")) || 0;
    }

    let appraisal = "N/A";
    const appraisalSection = html.match(
      /Estimated Value[\s\S]*?\$([\d,]+)/i
    );
    if (appraisalSection) {
      appraisal = "$" + appraisalSection[1];
    }

    return { score, tlds, appraisal };
  } catch {
    return null;
  }
}

// ======================================================
// PROCESS DOMAIN
// ======================================================

async function processDomain(page, domain) {
  try {
    const url = `https://www.atom.com/domain-appraisal/${domain}`;
    const html = await fetchHtml(page, url);

    if (!html) return null;

    if (
      html.includes("Access denied") ||
      html.includes("captcha") ||
      html.includes("Cloudflare")
    ) {
      console.log(`⚠ BLOCKED -> ${domain}`);
      console.log("Sleeping 15 seconds...");
      await sleep(15000);
      return null;
    }

    return extractDataFromHtml(html);
  } catch {
    return null;
  }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  const names = loadAllDomains();
  console.log(`Loaded ${names.length} domains\n`);

  const startIndex = findResumeIndex(names);
  let currentIndex = startIndex;
  const startTime = Date.now();

  console.log(`Starting from index ${startIndex}\n`);

  // Shared browser reference — workers can trigger a relaunch
  let browser = await launchBrowser();
  let browserAlive = true;

  // Detect if browser crashes and relaunch it
  browser.on("disconnected", async () => {
    if (browserAlive) {
      console.log("\n⚠ BROWSER CRASHED — relaunching in 5 seconds...");
      browserAlive = false;
      await sleep(5000);
      try {
        browser = await launchBrowser();
        browserAlive = true;
        console.log("✅ Browser relaunched.\n");
      } catch (err) {
        console.log("❌ Browser relaunch failed:", err.message);
      }
    }
  });

  // ======================================================
  // CREATE INITIAL PAGES
  // ======================================================

  const pages = [];
  for (let i = 0; i < WORKERS; i++) {
    const page = await createPage(browser);
    pages.push(page);
    console.log(`Worker ${i + 1} ready`);
    await sleep(1000);
  }

  // ======================================================
  // SAFE QUEUE
  // ======================================================

  function getNextDomain() {
    if (currentIndex >= names.length) return null;
    const result = { index: currentIndex, name: names[currentIndex] };
    currentIndex++;
    return result;
  }

  // ======================================================
  // WORKER
  // ======================================================

  async function worker(workerId, initialPage) {
    let page = initialPage;
    let domainsProcessed = 0;

    while (true) {

      // ==========================================
      // RUNTIME LIMIT
      // ==========================================

      if (Date.now() - startTime >= MAX_RUNTIME_MS) {
        console.log(`\n[Worker ${workerId}] Runtime limit reached, stopping cleanly.`);
        return;
      }

      const item = getNextDomain();
      if (!item) {
        console.log(`[Worker ${workerId}] DONE`);
        return;
      }

      const { index, name } = item;
      const domain = `${name}.net`;

      console.log(`[Worker ${workerId}] ${index + 1}/${names.length} -> ${domain}`);

      // ==========================================
      // PAGE RECYCLING — fully safe, never crashes
      // ==========================================

      if (domainsProcessed > 0 && domainsProcessed % PAGE_RECYCLE_INTERVAL === 0) {
        console.log(`[Worker ${workerId}] Recycling page...`);

        // Close old page safely
        try { await page.close(); } catch {}

        // Wait if browser is relaunching
        let waited = 0;
        while (!browserAlive && waited < 30000) {
          await sleep(1000);
          waited += 1000;
        }

        if (!browserAlive) {
          console.log(`[Worker ${workerId}] Browser still dead after 30s, stopping worker.`);
          return;
        }

        // Open new page safely
        try {
          page = await createPage(browser);
          console.log(`[Worker ${workerId}] Page recycled OK`);
        } catch (err) {
          console.log(`[Worker ${workerId}] Page recycle failed: ${err.message} — skipping recycle, continuing with old page`);
          // Don't crash — just keep going, try again next interval
        }
      }

      const data = await processDomain(page, domain);

      saveLastDomain(name);
      domainsProcessed++;

      if (!data) {
        console.log(`[Worker ${workerId}] FAILED -> ${domain}\n`);
        await sleep(randomDelay());
        continue;
      }

      const { score, tlds, appraisal } = data;

      const shouldSave =
        (score >= MIN_SCORE && tlds >= MIN_TLDS) || tlds >= AUTO_PASS_TLDS;

      if (shouldSave) {
        console.log(`✅ SAVED -> ${domain} | score: ${score} | tlds: ${tlds} | ${appraisal}`);
        saveResult(domain, score, tlds, appraisal);
      } else {
        console.log(`❌ SKIPPED -> ${domain} | score: ${score} | tlds: ${tlds}`);
      }

      // ==========================================
      // PROGRESS REPORT
      // ==========================================

      if ((index + 1) % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const perSec = ((index + 1 - startIndex) / elapsed).toFixed(2);
        const remaining = names.length - (index + 1);
        const etaHours = (remaining / perSec / 3600).toFixed(1);
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

        console.log(`
==================================================
PROGRESS: ${index + 1}/${names.length}
SPEED: ${perSec}/sec
ETA: ${etaHours}h
MEMORY (RSS): ${memMB} MB
==================================================
`);
      }

      await sleep(randomDelay());
    }
  }

  // ======================================================
  // START WORKERS
  // ======================================================

  const workerPromises = [];
  for (let i = 0; i < WORKERS; i++) {
    workerPromises.push(worker(i + 1, pages[i]));
  }

  await Promise.all(workerPromises);

  // ======================================================
  // FINISHED
  // ======================================================

  try { await browser.close(); } catch {}

  const finished = currentIndex >= names.length;

  if (finished) {
    console.log(`\n==================================================\nALL DOMAINS FINISHED\n==================================================\n`);
    fs.writeFileSync("completed.txt", "done", "utf8");
  } else {
    console.log(`\n==================================================\nCHECKPOINT REACHED — Progress saved.\n==================================================\n`);
  }
}

// ======================================================
// START
// ======================================================

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
