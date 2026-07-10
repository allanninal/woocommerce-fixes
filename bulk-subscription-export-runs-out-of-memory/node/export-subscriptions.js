/**
 * Export every WooCommerce Subscription to CSV without loading them all into memory.
 *
 * A "export all subscriptions" job that calls the REST API once with a huge
 * per_page, or that appends every page into one array before writing the
 * file, grows without bound as the store grows. On a store with tens of
 * thousands of subscriptions this is what runs out of memory and gets killed
 * partway through, usually with a half written, unusable CSV file.
 *
 * This script fetches one page at a time, writes each row to disk as soon as
 * it arrives, and never keeps more than one page of subscriptions in memory.
 * A pure planner function decides the next step (keep paging, shrink the
 * page size, or stop) from plain numbers, so the paging logic can be unit
 * tested with no network and no real file.
 *
 * Read only against WooCommerce. Safe to run again and again.
 * Guide: https://www.allanninal.dev/woocommerce/bulk-subscription-export-runs-out-of-memory/
 */
import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");

const EXPORT_PATH = process.env.EXPORT_PATH || "subscriptions_export.csv";
const START_PAGE_SIZE = Number(process.env.START_PAGE_SIZE || 100);
const MIN_PAGE_SIZE = Number(process.env.MIN_PAGE_SIZE || 10);
const MEMORY_BUDGET_MB = Number(process.env.MEMORY_BUDGET_MB || 150);
const MAX_ROWS = Number(process.env.MAX_ROWS || 0) || null; // 0 means no cap
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FIELDS = ["id", "status", "total", "billing_period", "billing_interval", "next_payment_date", "customer_id"];

export function bytesPerRowEstimate(pageBytes, rowCount) {
  // Average bytes per subscription in a page. Zero rows means no data to size from.
  if (rowCount <= 0) return 0;
  return pageBytes / rowCount;
}

/**
 * Pure planner. Decides the next paging action from plain numbers only.
 *
 * state keys:
 *   pageSize          current rows requested per page
 *   rowsInLastPage    rows actually returned by the last request (0 if none yet)
 *   lastPageBytes     approximate size in bytes of the last page's JSON
 *   totalRowsSoFar    rows written to the CSV so far
 *   maxRows           cap on total rows to export, or null for no cap
 *   memoryBudgetMb    the memory ceiling we plan against, in megabytes
 *
 * Returns [action, reason] where action is one of:
 *   "stop_done"   no more pages, or the row cap was reached
 *   "shrink"      a page was too heavy for the budget, halve the size and retry
 *   "continue"    request the next page at the current pageSize
 */
export function planNextPage(state) {
  const {
    pageSize,
    rowsInLastPage,
    lastPageBytes,
    totalRowsSoFar,
    maxRows = null,
    memoryBudgetMb,
    hasFetchedAPage = false,
  } = state;

  if (maxRows !== null && totalRowsSoFar >= maxRows) {
    return ["stop_done", "row cap reached"];
  }

  if (rowsInLastPage === 0 && hasFetchedAPage) {
    return ["stop_done", "no more subscriptions"];
  }

  const budgetBytes = memoryBudgetMb * 1024 * 1024;
  // A page is only ever held in memory once, briefly, right after the request
  // returns and before it is written and discarded. If that one page alone
  // would already blow the budget, shrink the page size and try again rather
  // than ever holding a bigger page.
  if (lastPageBytes > budgetBytes && pageSize > MIN_PAGE_SIZE) {
    return ["shrink", "last page was too heavy for the memory budget"];
  }

  return ["continue", "keep paging at the current size"];
}

export function nextPageSize(currentPageSize) {
  // Halve the page size on a shrink, but never below MIN_PAGE_SIZE.
  return Math.max(MIN_PAGE_SIZE, Math.floor(currentPageSize / 2));
}

export function toRow(sub) {
  // Flatten one subscription REST object to the CSV row we export.
  const row = {};
  for (const field of FIELDS) row[field] = sub[field] ?? "";
  return row;
}

function csvLine(row) {
  return FIELDS.map((f) => {
    const value = String(row[f] ?? "");
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(",");
}

async function fetchPage(page, pageSize) {
  const url = `${WOO_URL}/wp-json/wc/v3/subscriptions?per_page=${pageSize}&page=${page}&orderby=id&order=asc`;
  const res = await fetch(url, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`Woo subscriptions page ${page} returned ${res.status}`);
  const text = await res.text();
  return [Buffer.byteLength(text), JSON.parse(text)];
}

export async function run() {
  if (DRY_RUN) {
    console.log(`DRY_RUN is true. Counting subscriptions and planning pages, not writing ${EXPORT_PATH}.`);
  }

  let page = 1;
  let pageSize = START_PAGE_SIZE;
  let totalRowsSoFar = 0;
  let state = {
    pageSize,
    rowsInLastPage: 0,
    lastPageBytes: 0,
    totalRowsSoFar: 0,
    maxRows: MAX_ROWS,
    memoryBudgetMb: MEMORY_BUDGET_MB,
    hasFetchedAPage: false,
  };

  const out = DRY_RUN ? null : createWriteStream(EXPORT_PATH);
  if (out) out.write(FIELDS.join(",") + "\n");

  while (true) {
    const [action, reason] = planNextPage(state);
    if (action === "stop_done") {
      console.log(`Stopping: ${reason}.`);
      break;
    }
    if (action === "shrink") {
      pageSize = nextPageSize(pageSize);
      console.warn(`Shrinking page size to ${pageSize}: ${reason}.`);
      state = { ...state, pageSize, lastPageBytes: 0 };
      continue; // retry the same page number at the smaller size
    }

    const [pageBytes, rows] = await fetchPage(page, pageSize);
    const rowCount = rows.length;

    if (out) {
      for (const sub of rows) out.write(csvLine(toRow(sub)) + "\n"); // one page at a time, never buffered
    }
    totalRowsSoFar += rowCount;

    console.log(`Page ${page}: ${rowCount} subscription(s) at page size ${pageSize} (${pageBytes} bytes).`);

    state = {
      ...state,
      pageSize,
      rowsInLastPage: rowCount,
      lastPageBytes: pageBytes,
      totalRowsSoFar,
      hasFetchedAPage: true,
    };
    page++;
  }

  if (out) out.end();
  console.log(`Done. ${totalRowsSoFar} subscription row(s) ${DRY_RUN ? "counted" : `written to ${EXPORT_PATH}`}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
