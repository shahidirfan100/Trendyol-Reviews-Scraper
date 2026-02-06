// Trendyol reviews scraper - Playwright Chrome (stealth + API extraction)
import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestList } from 'crawlee';

process.env.CRAWLEE_PURGE_ON_START ||= '0';

const HOME_URL = 'https://www.trendyol.com/';
const REVIEWS_API = 'https://apigw.trendyol.com/discovery-storefront-trproductgw-service/api/review-read/product-reviews/detailed';
const REVIEW_API_PATH_RE = /\/api\/(?:review-read\/product-reviews\/detailed|review\/comments)(?:\?|$)/i;
const COUNTRY_PAGE_RE = /(select-country|country-selection)/i;
const COOKIE_BUTTON_SELECTORS = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
];
const COUNTRY_SELECT_SELECTORS = [
    '[data-testid="country-select-btn-desktop"]',
    'button:has-text("Select")',
    'button:has-text("Continue")',
    'button:has-text("Start Shopping")',
    'button:has-text("Start shopping")',
];
const COUNTRY_PREFERENCE = ['USA', 'United States', 'Türkiye', 'Turkey', 'Germany', 'France', 'Italy'];
const DEFAULT_PAGE_SIZE = 50;
const ORDER_DIRECTION = 'DESC';
const BLOCKED_TITLE_RE = /(access denied|captcha|attention required|verify|robot|blocked)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const safeJsonParse = (value) => {
    try {
        const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
        if (!text) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const getNumber = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const raw = String(value).trim();
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d.,-]/g, '');
    if (!cleaned) return null;
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized = cleaned;
    if (lastComma > -1 && lastDot > -1) {
        if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
        else normalized = cleaned.replace(/,/g, '');
    } else if (lastComma > -1) {
        normalized = cleaned.replace(',', '.');
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
};

const pickFirst = (...values) => {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        return value;
    }
    return null;
};

const toOptionalString = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
};

const toOptionalBoolean = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (['true', '1', 'yes', 'y'].includes(text)) return true;
    if (['false', '0', 'no', 'n'].includes(text)) return false;
    return null;
};

const sanitizeItem = (item) => {
    if (!item || typeof item !== 'object') return {};
    const cleaned = {};
    for (const [key, value] of Object.entries(item)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (Array.isArray(value)) {
            const arr = value
                .map((v) => (typeof v === 'string' ? v.trim() : v))
                .filter((v) => v !== null && v !== undefined && v !== '');
            if (!arr.length) continue;
            cleaned[key] = arr;
            continue;
        }
        cleaned[key] = value;
    }
    return cleaned;
};

const normalizeTrendyolPath = (pathname = '') => pathname.replace(/^\/en(?=\/|$)/i, '');

const buildReviewPageUrl = (value) => {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        url.hash = '';
        url.search = '';
        let pathname = normalizeTrendyolPath(url.pathname);
        pathname = pathname.replace(/\/reviews\/?$/i, '/yorumlar');
        if (!/\/yorumlar\/?$/i.test(pathname)) pathname = pathname.replace(/\/+$/g, '') + '/yorumlar';
        url.pathname = pathname;
        return url.href;
    } catch {
        return null;
    }
};

const normalizeProductUrl = (value) => {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        url.hash = '';
        let pathname = normalizeTrendyolPath(url.pathname);
        pathname = pathname.replace(/\/(?:reviews|yorumlar)\/?$/i, '');
        url.pathname = pathname;
        return url.href;
    } catch {
        return null;
    }
};

const extractProductId = (value) => {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return raw;

    try {
        const url = new URL(raw);
        const fromQuery =
            url.searchParams.get('contentId') ||
            url.searchParams.get('productId') ||
            url.searchParams.get('id');
        if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
        const match = url.pathname.match(/-p-(\d+)/i) || url.pathname.match(/p-(\d+)/i);
        if (match?.[1]) return match[1];
    } catch {
        // Not a URL, fall through to regex
    }

    const match = raw.match(/-p-(\d+)/i) || raw.match(/p-(\d+)/i);
    return match?.[1] || null;
};

const normalizeSortBy = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'Rate';
    const map = {
        date: 'Date',
        newest: 'Date',
        rate: 'Rate',
        rating: 'Rate',
        helpful: 'Helpfulness',
        helpfulness: 'Helpfulness',
        'most helpful': 'Helpfulness',
    };
    if (map[raw]) return map[raw];
    if (['Date', 'Rate', 'Helpfulness'].includes(value)) return value;
    return 'Rate';
};

const toApiOrderBy = (sortBy) => {
    const map = {
        Date: 'Score',
        Rate: 'Score',
        Helpfulness: 'Score',
    };
    return map[sortBy] || 'Score';
};

const buildApiUrl = ({ productId, page, size, sortBy }) => {
    const url = new URL(REVIEWS_API);
    url.searchParams.set('contentId', String(productId));
    url.searchParams.set('orderBy', toApiOrderBy(sortBy));
    url.searchParams.set('order', ORDER_DIRECTION);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(size));
    url.searchParams.set('channelId', '1');
    return url.href;
};

const findExistingParam = (params, candidates) => candidates.find((name) => params.has(name)) || null;

const buildApiUrlFromTemplate = (templateUrl, { productId, page, size, sortBy }) => {
    if (!templateUrl) return null;
    try {
        const url = new URL(templateUrl);
        if (!REVIEW_API_PATH_RE.test(url.pathname + url.search)) return null;
        const params = url.searchParams;
        const contentKey = findExistingParam(params, ['contentId', 'productId', 'id', 'productContentId']);
        const pageKey = findExistingParam(params, ['page', 'pageIndex', 'pageNumber']);
        const sizeKey = findExistingParam(params, ['size', 'pageSize', 'limit', 'perPage']);
        const sortKey = findExistingParam(params, ['orderBy', 'sortBy', 'sort', 'sorting']);
        const dirKey = findExistingParam(params, ['orderByDirection', 'sortDirection', 'sortOrder', 'direction', 'order']);
        const channelKey = findExistingParam(params, ['channelId']);

        if (contentKey && productId != null) params.set(contentKey, String(productId));
        if (pageKey && page != null) params.set(pageKey, String(page));
        // Keep template page size when present to preserve server pagination behavior.
        if (sizeKey && size != null && !params.get(sizeKey)) params.set(sizeKey, String(size));
        if (sortKey && sortBy) params.set(sortKey, String(toApiOrderBy(sortBy)));
        if (dirKey) params.set(dirKey, ORDER_DIRECTION);
        if (channelKey) params.set(channelKey, '1');

        return url.href;
    } catch {
        return null;
    }
};

const isLikelyReviewApiUrl = (rawUrl, productId) => {
    try {
        const url = new URL(rawUrl);
        if (!url.hostname.endsWith('trendyol.com')) return false;
        if (!REVIEW_API_PATH_RE.test(url.pathname + url.search)) return false;

        const contentId =
            url.searchParams.get('contentId') ||
            url.searchParams.get('productId') ||
            url.searchParams.get('id');
        if (productId && contentId && String(contentId) !== String(productId)) return false;
        return true;
    } catch {
        return false;
    }
};

const parseDate = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return null;
        return { iso: d.toISOString(), ts: d.getTime() };
    }
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
        const asNumber = Number(raw);
        return parseDate(asNumber);
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return { iso: d.toISOString(), ts: d.getTime() };
};

const extractReviewsFromPayload = (payload) => {
    const root = payload?.result ?? payload?.data ?? payload;
    const comments =
        root?.reviews ||
        root?.comments ||
        root?.commentList ||
        root?.items ||
        root?.data ||
        root?.results ||
        [];
    const totalCount = getNumber(
        root?.totalCount ??
            root?.total ??
            root?.count ??
            root?.totalElements ??
            root?.summary?.totalCommentCount
    );
    const pageSize = getNumber(root?.size ?? root?.pageSize ?? root?.perPage);
    const totalPages = getNumber(root?.totalPages ?? root?.pageCount ?? root?.summary?.totalPages);
    return {
        comments: Array.isArray(comments) ? comments : [],
        totalCount,
        pageSize,
        totalPages,
    };
};

const mapReview = (comment, meta) => {
    if (!comment || typeof comment !== 'object') return null;
    const created = parseDate(
        comment.commentDate ||
            comment.creationDate ||
            comment.createdDate ||
            comment.createdAt ||
            comment.date
    );
    const images = comment.images || comment.imageUrls || comment.media || comment.mediaFiles || [];
    const hasImage =
        Array.isArray(images) ? images.length > 0 : Boolean(comment.hasPhoto || comment.hasImage);

    return sanitizeItem({
        productId: meta.productId,
        reviewId: toOptionalString(pickFirst(comment.id, comment.commentId, comment.reviewId, comment.reviewID)),
        rating: getNumber(comment.rate ?? comment.rating ?? comment.starRating ?? comment.score),
        title: pickFirst(comment.commentTitle, comment.title, comment.header),
        comment: pickFirst(comment.comment, comment.text, comment.commentText, comment.review),
        createdAt: created?.iso,
        createdAtTimestamp: created?.ts,
        likeCount: getNumber(comment.likesCount ?? comment.likeCount ?? comment.helpfulCount ?? comment.like),
        dislikeCount: getNumber(comment.dislikeCount ?? comment.unhelpfulCount ?? comment.dislike),
        isVerifiedPurchase: toOptionalBoolean(
            pickFirst(
                comment.trusted,
                comment.isVerified,
                comment.isBuyer,
                comment.isPurchased,
                comment.isVerifiedPurchase
            )
        ),
        productSize: toOptionalString(pickFirst(comment.productSize, comment.size, comment.sizeName, comment.variant?.size)),
        productColor: toOptionalString(
            pickFirst(
                comment.productColor,
                comment.color,
                comment.colorName,
                comment.variant?.color,
                comment.productVariant?.value
            )
        ),
        hasImage,
        reviewPageUrl: meta.reviewPageUrl,
        productUrl: meta.productUrl,
    });
};

const buildReviewKey = (review) => {
    if (review.reviewId) return `${review.productId}:${review.reviewId}`;
    const comment = review.comment ? review.comment.slice(0, 80) : '';
    const ts = review.createdAtTimestamp ?? '';
    return `${review.productId}:${ts}:${comment}`;
};

const getJsonLdObjects = (raw) => {
    if (!raw) return [];
    const items = [];
    const pushItem = (value) => {
        if (!value) return;
        if (Array.isArray(value)) value.forEach(pushItem);
        else if (typeof value === 'object') items.push(value);
    };
    try {
        const parsed = JSON.parse(raw);
        pushItem(parsed);
    } catch {
        // Ignore invalid JSON-LD
    }
    return items;
};

const extractJsonLdReviews = (jsonLdObjects = []) => {
    const reviews = [];
    const addReview = (review) => {
        if (!review || typeof review !== 'object') return;
        reviews.push(review);
    };

    jsonLdObjects.forEach((obj) => {
        if (obj?.review) {
            if (Array.isArray(obj.review)) obj.review.forEach(addReview);
            else addReview(obj.review);
        }
        if (obj?.reviews) {
            if (Array.isArray(obj.reviews)) obj.reviews.forEach(addReview);
            else addReview(obj.reviews);
        }
        if (obj?.['@graph'] && Array.isArray(obj['@graph'])) {
            obj['@graph'].forEach((node) => {
                if (node?.review) {
                    if (Array.isArray(node.review)) node.review.forEach(addReview);
                    else addReview(node.review);
                }
                if (node?.reviews) {
                    if (Array.isArray(node.reviews)) node.reviews.forEach(addReview);
                    else addReview(node.reviews);
                }
            });
        }
    });

    return reviews;
};

const mapJsonLdReview = (review, meta) => {
    if (!review || typeof review !== 'object') return null;
    const created = parseDate(review.datePublished || review.dateCreated);
    const ratingValue = review?.reviewRating?.ratingValue ?? review?.reviewRating?.rating;
    const mapped = {
        productId: meta.productId,
        reviewId: toOptionalString(pickFirst(review.identifier, review.id)),
        rating: getNumber(ratingValue),
        title: pickFirst(review.name, review.headline),
        comment: pickFirst(review.reviewBody, review.description, review.review),
        createdAt: created?.iso,
        createdAtTimestamp: created?.ts,
        likeCount: getNumber(review?.interactionStatistic?.userInteractionCount),
        isVerifiedPurchase: toOptionalBoolean(pickFirst(review.isVerified, review.verified)),
        hasImage: Boolean(review?.image),
        reviewPageUrl: meta.reviewPageUrl,
        productUrl: meta.productUrl,
    };
    return sanitizeItem(mapped);
};

async function fetchReviewsPage({ page, apiUrl, referer, extraHeaders }) {
    let origin = 'https://www.trendyol.com';
    try {
        if (referer) origin = new URL(referer).origin;
    } catch {
        // keep default origin
    }
    const headers = {
        accept: 'application/json, text/plain, */*',
        origin,
        ...(extraHeaders || {}),
        referer: (extraHeaders && extraHeaders.referer) || referer,
    };

    const fetchViaPage = async () => {
        try {
            const pageHeaders = { accept: headers.accept, ...(extraHeaders || {}) };
            delete pageHeaders.origin;
            delete pageHeaders.referer;
            delete pageHeaders.host;
            delete pageHeaders.cookie;
            delete pageHeaders['accept-encoding'];
            delete pageHeaders['content-length'];
            delete pageHeaders['sec-fetch-site'];
            delete pageHeaders['sec-fetch-mode'];
            delete pageHeaders['sec-fetch-dest'];
            delete pageHeaders['sec-fetch-user'];
            delete pageHeaders['sec-ch-ua'];
            delete pageHeaders['sec-ch-ua-mobile'];
            delete pageHeaders['sec-ch-ua-platform'];
            delete pageHeaders['user-agent'];
            const result = await page.evaluate(
                async ({ apiUrl: url, hdrs }) => {
                    const resp = await fetch(url, { headers: hdrs, credentials: 'include' });
                    const text = await resp.text();
                    return { status: resp.status, text };
                },
                { apiUrl, hdrs: pageHeaders }
            );
            const payload = safeJsonParse(result?.text);
            if (payload) return { payload, status: result?.status };
        } catch {
            // ignore page-context fetch failures
        }
        return null;
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const viaPage = await fetchViaPage();
        if (viaPage?.payload) return viaPage;

        const response = await page.request.get(apiUrl, { headers });
        const status = response.status();
        const text = await response.text();
        const payload = safeJsonParse(text);
        if (payload) return { payload, status };

        log.warning(`Non-JSON response (status ${status}) for ${apiUrl}. Retry ${attempt}/3.`);
        await sleep(1000 + Math.random() * 1000);
    }

    return null;
}

const stripRequestHeaders = (headers = {}) => {
    const cleaned = {};
    const blocked = new Set([
        'host',
        'connection',
        'content-length',
        'cookie',
        'accept-encoding',
        'sec-fetch-site',
        'sec-fetch-mode',
        'sec-fetch-dest',
    ]);
    for (const [key, value] of Object.entries(headers)) {
        if (!key || blocked.has(key.toLowerCase())) continue;
        cleaned[key] = value;
    }
    return cleaned;
};

const createReviewResponseCollector = (page, productId) => {
    const collected = [];
    const handler = async (response) => {
        try {
            const url = response.url();
            if (!isLikelyReviewApiUrl(url, productId)) return;
            const status = response.status();
            const ct = response.headers()['content-type'] || '';
            if (!/json|text\/plain/i.test(ct)) return;

            const text = await response.text();
            if (!text || text.length > 5_000_000) return;
            const payload = safeJsonParse(text);
            if (!payload) return;

            const { comments, totalCount } = extractReviewsFromPayload(payload);
            if (!comments.length && !totalCount) return;
            if (productId && !url.includes(String(productId))) {
                // URL does not contain productId but payload matches; keep as fallback
                log.debug(`Captured review-like payload from ${url} without productId in URL.`);
            }

            collected.push({
                url,
                status,
                payload,
                headers: stripRequestHeaders(response.request().headers()),
            });
        } catch {
            // Ignore response parsing failures
        }
    };

    page.on('response', handler);

    return {
        collected,
        stop: () => page.off('response', handler),
        first: () => collected[0] || null,
    };
};

const clickFirstVisible = async (locator, timeout = 2000) => {
    try {
        await locator.first().waitFor({ state: 'visible', timeout });
        await locator.first().click({ timeout: 5000 });
        return true;
    } catch {
        return false;
    }
};

const handleCookieConsent = async (page) => {
    for (const selector of COOKIE_BUTTON_SELECTORS) {
        const clicked = await clickFirstVisible(page.locator(selector));
        if (clicked) {
            log.debug(`Accepted cookie banner via selector: ${selector}`);
            await sleep(500);
            return true;
        }
    }
    return false;
};

const handleCountrySelection = async (page) => {
    const url = page.url();
    const hasCountryFragment = (await page.locator('#m-country-selection').count()) > 0;
    if (!COUNTRY_PAGE_RE.test(url) && !hasCountryFragment) return false;

    log.debug('Country selection detected. Attempting to pick a country.');

    const countrySelect = page.locator('select#country-select');
    if (await countrySelect.count()) {
        for (const country of COUNTRY_PREFERENCE) {
            try {
                await countrySelect.first().selectOption({ value: country }, { timeout: 3000 });
                log.debug(`Selected country via dropdown: ${country}`);
                break;
            } catch {
                // try next preferred country
            }
        }
    }

    for (const country of COUNTRY_PREFERENCE) {
        const byTestId = await clickFirstVisible(page.locator(`[data-testid="country-text-${country}"]`), 1200);
        const direct = await clickFirstVisible(page.locator(`text=${country}`), 1200);
        const wrapped = await clickFirstVisible(
            page.locator(`text=${country}`).locator('..').locator('button, [role="button"]'),
            1200
        );
        if (byTestId || direct || wrapped) {
            log.debug(`Selected country: ${country}`);
            break;
        }
    }

    for (const selector of COUNTRY_SELECT_SELECTORS) {
        const clicked = await clickFirstVisible(page.locator(selector), 3000);
        if (clicked) {
            log.debug(`Confirmed country selection via selector: ${selector}`);
            await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
            return true;
        }
    }

    return false;
};

const ensureReviewContext = async (page, reviewPageUrl) => {
    await handleCookieConsent(page);
    const countryHandled = await handleCountrySelection(page);
    if (countryHandled && reviewPageUrl) {
        await page.goto(reviewPageUrl, { waitUntil: 'domcontentloaded' });
    }
    await handleCookieConsent(page);
};

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        productId,
        startUrls,
        results_wanted: RESULTS_WANTED_RAW = 20,
        max_pages: MAX_PAGES_RAW = 0,
        sortBy: SORT_BY_RAW = 'Rate',
        proxyConfiguration: proxyConfig,
    } = input;

    const requestedResults = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.floor(+RESULTS_WANTED_RAW) : 20;
    const RESULTS_WANTED = requestedResults === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requestedResults);
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(0, Math.floor(+MAX_PAGES_RAW)) : 0;
    const PAGE_SIZE = DEFAULT_PAGE_SIZE;
    const SORT_BY = normalizeSortBy(SORT_BY_RAW);
    const requestedLabel = Number.isFinite(RESULTS_WANTED) ? String(RESULTS_WANTED) : 'all';

    const targetMap = new Map();
    const upsertTarget = (id, data = {}) => {
        if (!id) return;
        const existing = targetMap.get(id) || {
            productId: id,
            productUrl: null,
            reviewPageUrl: null,
            seedUrl: HOME_URL,
        };
        targetMap.set(id, {
            ...existing,
            productUrl: pickFirst(data.productUrl, existing.productUrl),
            reviewPageUrl: pickFirst(data.reviewPageUrl, existing.reviewPageUrl),
            seedUrl: pickFirst(data.seedUrl, existing.seedUrl),
        });
    };

    if (productId) {
        const id = extractProductId(productId);
        if (!id) log.warning('Invalid productId provided.');
        else upsertTarget(id);
    }

    if (Array.isArray(startUrls)) {
        startUrls
            .map((entry) => entry?.url || entry)
            .filter(Boolean)
            .forEach((url) => {
                const id = extractProductId(url);
                if (!id) {
                    log.warning(`Could not extract productId from startUrl: ${url}`);
                    return;
                }
                const reviewPageUrl = buildReviewPageUrl(url);
                const productUrl = normalizeProductUrl(url);
                upsertTarget(id, {
                    productUrl,
                    reviewPageUrl,
                    seedUrl: reviewPageUrl || HOME_URL,
                });
            });
    }

    const targets = Array.from(targetMap.values()).filter((t) => t.productId);
    if (!targets.length) {
        throw new Error('Provide at least one productId or startUrls entry.');
    }

    log.info(`Starting crawl for ${targets.length} product(s).`);

    // Proxy configuration - handle local development without proxies
    let proxyConfiguration = null;
    if (proxyConfig?.useApifyProxy === true) {
        log.info('Using Apify Proxy (for cloud deployment)');
        proxyConfiguration = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            apifyProxyGroups: proxyConfig.apifyProxyGroups || ['RESIDENTIAL'],
        });
    } else {
        log.info('No proxy - Direct connection (local development)');
    }

    const savedByProduct = new Map();
    const seenReviews = new Set();
    const debugSaved = new Set();

    const startRequests = targets.map((target) => ({
        url: target.seedUrl || HOME_URL,
        userData: {
            label: 'REVIEWS',
            productId: target.productId,
            sortBy: SORT_BY,
            productUrl: target.productUrl,
            reviewPageUrl: target.reviewPageUrl || target.seedUrl,
        },
    }));

    // Create RequestList from start requests
    const requestList = await RequestList.open(null, startRequests);
    log.info(`Prepared ${startRequests.length} product request(s), target reviews: ${requestedLabel}.`);
    const crawlerOptions = {
        requestList,
        maxRequestRetries: 2,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 90,
        navigationTimeoutSecs: 45,
        statusMessageLoggingInterval: 300,
        launchContext: {
            launchOptions: {
                headless: false,
            },
        },

            async requestHandler({ page, request }) {
                log.debug(`Processing: ${request.url}`);

                const {
                    productId: targetProductId,
                    sortBy,
                    productUrl,
                    reviewPageUrl,
                } = request.userData || {};

                const collector = createReviewResponseCollector(page, targetProductId);
                let observedRequest = null;
                const requestListener = (req) => {
                    try {
                        const url = req.url();
                        if (!isLikelyReviewApiUrl(url, targetProductId)) return;
                        observedRequest = {
                            url,
                            headers: stripRequestHeaders(req.headers()),
                        };
                    } catch {
                        // ignore request capture failures
                    }
                };
                page.on('request', requestListener);

                // Wait for page to load
                try {
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                } catch (err) {
                    log.warning(`Timeout waiting for domcontentloaded: ${err.message}`);
                }

                const title = await page.title().catch(() => '');
                if (title) log.debug(`Page title: ${title}`);
                if (BLOCKED_TITLE_RE.test(title)) {
                    const debugKey = `blocked-${request.userData?.productId || 'unknown'}`;
                    if (!debugSaved.has(debugKey)) {
                        debugSaved.add(debugKey);
                        const html = await page.content().catch(() => '');
                        await Actor.setValue(debugKey, html, { contentType: 'text/html' });
                        log.warning(`Blocked page detected. Saved debug HTML to key "${debugKey}".`);
                    }
                    collector.stop();
                    return;
                }

                const targetReviewUrl = reviewPageUrl || request.url || HOME_URL;
                await ensureReviewContext(page, targetReviewUrl);

                const onReviewPage = /\/(?:reviews|yorumlar)(?:\/|$)/i.test(page.url());
                if (!targetReviewUrl || !onReviewPage) {
                    log.debug(`Ensuring review page navigation to ${targetReviewUrl}`);
                    await page.goto(targetReviewUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
                }

                const savedForProduct = savedByProduct.get(targetProductId) || 0;
                if (savedForProduct >= RESULTS_WANTED) {
                    log.debug(`Already saved ${savedForProduct} reviews for product ${targetProductId}, skipping`);
                    collector.stop();
                    return;
                }

                let captured = collector.first();
                if (!captured) {
                    log.debug('No review API response captured yet; reloading to trigger.');
                    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                    await page
                        .waitForResponse(
                            (resp) => isLikelyReviewApiUrl(resp.url(), targetProductId),
                            { timeout: 12000 }
                        )
                        .catch(() => {});
                    await sleep(1000);
                    captured = collector.first();
                }
                collector.stop();
                page.off('request', requestListener);

                const apiTemplateUrl = captured?.url || observedRequest?.url || null;
                const apiHeaders = captured?.headers || observedRequest?.headers || null;

                log.info(`Fetching reviews for product ${targetProductId} (${savedForProduct}/${requestedLabel} saved).`);
                let saved = savedForProduct;
                let pageNo = 0;
                let maxPagesAllowed = MAX_PAGES === 0 ? Number.POSITIVE_INFINITY : MAX_PAGES;

                if (captured?.payload) {
                    const { comments, totalCount, pageSize: payloadPageSize, totalPages } =
                        extractReviewsFromPayload(captured.payload);

                    if (comments.length) {
                        log.debug(`Captured ${comments.length} review(s) from network response.`);
                        for (const comment of comments) {
                            if (saved >= RESULTS_WANTED) break;
                            const review = mapReview(comment, {
                                productId: targetProductId,
                                productUrl,
                                reviewPageUrl: targetReviewUrl,
                            });
                            if (!review || !Object.keys(review).length) continue;
                            const key = buildReviewKey(review);
                            if (seenReviews.has(key)) continue;
                            seenReviews.add(key);
                            await Actor.pushData(review);
                            saved += 1;
                        }
                        savedByProduct.set(targetProductId, saved);
                        pageNo = 1;

                        const effectivePageSize = payloadPageSize || PAGE_SIZE;
                        const inferredTotalPages =
                            totalPages || (totalCount && effectivePageSize ? Math.ceil(totalCount / effectivePageSize) : null);
                        if (inferredTotalPages) {
                            maxPagesAllowed = Number.isFinite(maxPagesAllowed)
                                ? Math.min(maxPagesAllowed, inferredTotalPages)
                                : inferredTotalPages;
                        }
                    }
                }

                while (pageNo < maxPagesAllowed && saved < RESULTS_WANTED) {
                    const apiUrl =
                        buildApiUrlFromTemplate(apiTemplateUrl, {
                            productId: targetProductId,
                            page: pageNo,
                            size: PAGE_SIZE,
                            sortBy,
                        }) ||
                        buildApiUrl({
                            productId: targetProductId,
                            page: pageNo,
                            size: PAGE_SIZE,
                            sortBy,
                        });

                    log.debug(`Fetching page ${pageNo + 1}/${maxPagesAllowed} from API`);

                    const apiResult = await fetchReviewsPage({
                        page,
                        apiUrl,
                        referer: targetReviewUrl,
                        extraHeaders: apiHeaders,
                    });

                    if (!apiResult?.payload) {
                        log.warning(`Failed to fetch JSON for product ${targetProductId} page ${pageNo}.`);
                        const debugKey = `api-failure-${targetProductId}`;
                        if (!debugSaved.has(debugKey)) {
                            debugSaved.add(debugKey);
                            const html = await page.content().catch(() => '');
                            await Actor.setValue(debugKey, html, { contentType: 'text/html' });
                            log.warning(`Saved debug HTML to key "${debugKey}".`);
                        }

                        const jsonLdRaw = await page.$$eval(
                            'script[type="application/ld+json"]',
                            (els) => els.map((el) => el.textContent || '').filter(Boolean)
                        ).catch(() => []);
                        const jsonLdObjects = jsonLdRaw.flatMap(getJsonLdObjects);
                        const jsonLdReviews = extractJsonLdReviews(jsonLdObjects);

                        if (jsonLdReviews.length) {
                            log.info(`Extracted ${jsonLdReviews.length} JSON-LD reviews as fallback.`);
                            for (const review of jsonLdReviews) {
                                if (saved >= RESULTS_WANTED) break;
                                const mapped = mapJsonLdReview(review, {
                                    productId: targetProductId,
                                    productUrl,
                                    reviewPageUrl,
                                });
                                if (!mapped || !Object.keys(mapped).length) continue;
                                const key = buildReviewKey(mapped);
                                if (seenReviews.has(key)) continue;
                                seenReviews.add(key);
                                await Actor.pushData(mapped);
                                saved += 1;
                            }
                            savedByProduct.set(targetProductId, saved);
                        }
                        break;
                    }

                    const { comments, totalCount, pageSize: payloadPageSize, totalPages } =
                        extractReviewsFromPayload(apiResult.payload);

                    if (!comments.length) {
                        log.debug(`No reviews found for product ${targetProductId} on page ${pageNo}.`);
                        break;
                    }

                    for (const comment of comments) {
                        if (saved >= RESULTS_WANTED) break;
                        const review = mapReview(comment, {
                            productId: targetProductId,
                            productUrl,
                            reviewPageUrl,
                        });
                        if (!review || !Object.keys(review).length) continue;
                        const key = buildReviewKey(review);
                        if (seenReviews.has(key)) continue;
                        seenReviews.add(key);
                        await Actor.pushData(review);
                        saved += 1;
                    }

                    savedByProduct.set(targetProductId, saved);

                    const effectivePageSize = payloadPageSize || PAGE_SIZE;
                    const inferredTotalPages =
                        totalPages || (totalCount && effectivePageSize ? Math.ceil(totalCount / effectivePageSize) : null);
                    if (inferredTotalPages) {
                        maxPagesAllowed = Number.isFinite(maxPagesAllowed)
                            ? Math.min(maxPagesAllowed, inferredTotalPages)
                            : inferredTotalPages;
                    }

                    pageNo += 1;
                    if (pageNo >= maxPagesAllowed) break;
                    await sleep(100 + Math.random() * 150);
                }
            },

            failedRequestHandler({ request }, error) {
                if (error.message?.includes('403')) {
                    log.warning(`Blocked (403): ${request.url} - skipping`);
                } else {
                    log.error(`Request ${request.url} failed: ${error.message}`);
                }
            },
    };

    if (proxyConfiguration) {
        crawlerOptions.proxyConfiguration = proxyConfiguration;
    }

    const crawler = new PlaywrightCrawler(crawlerOptions);

    await crawler.run();

    const totalSaved = Array.from(savedByProduct.values()).reduce((sum, v) => sum + v, 0);
    log.info(`Scraping completed. Total items saved: ${totalSaved}`);

    if (totalSaved === 0) {
        log.warning('No reviews were scraped. Check if the product ID is valid or if there are reviews available.');
    }
}

const run = async () => {
    await Actor.init();
    try {
        await main();
    } catch (err) {
        log.exception(err, 'Actor failed');
        process.exitCode = 1;
    } finally {
        await Actor.exit();
    }
};

run();
