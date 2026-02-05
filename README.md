# Trendyol Reviews Scraper

Extract product reviews from Trendyol using a product ID or start URLs. Collect ratings, review text, timestamps, helpful vote counts, and variant details in a structured dataset for analysis, monitoring, and research.

---

## Features

- **Flexible input** — Use product IDs, product URLs, review URLs, or a list of start URLs
- **Clean review data** — Capture ratings, comments, timestamps, and helpful votes
- **Pagination support** — Automatically walks review pages up to your limit
- **Structured output** — Ready-to-use dataset for reporting and integrations

---

## Use Cases

- **Sentiment analysis** — Track review trends and customer feedback
- **Market research** — Compare product ratings and review volume
- **Quality monitoring** — Detect changes in sentiment over time
- **Data enrichment** — Add review metadata to product catalogs

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `productId` | String | No | — | Trendyol product content ID |
| `startUrls` | Array | No | — | List of product/review URLs to scrape |
| `results_wanted` | Integer | No | `20` | Maximum number of reviews to collect per product |
| `max_pages` | Integer | No | `5` | Maximum number of review pages to visit per product |
| `reviews_per_page` | Integer | No | `20` | Number of reviews requested per page |
| `sortBy` | String | No | `"Date"` | Sort by `"Date"`, `"Rate"`, or `"Helpfulness"` |
| `sortDirection` | String | No | `"DESC"` | Sort direction `"DESC"` or `"ASC"` |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"]}` | Proxy settings for reliable scraping |

---

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|---|---|---|
| `productId` | String | Trendyol product content ID |
| `reviewId` | String | Review identifier |
| `rating` | Number | Review rating |
| `title` | String | Review title |
| `comment` | String | Review text |
| `createdAt` | String | Review creation time (ISO) |
| `createdAtTimestamp` | Number | Review creation time in milliseconds |
| `likeCount` | Number | Helpful vote count |
| `dislikeCount` | Number | Unhelpful vote count |
| `isVerifiedPurchase` | Boolean | Verified purchase flag |
| `productSize` | String | Size selected by the reviewer (if available) |
| `productColor` | String | Color selected by the reviewer (if available) |
| `hasImage` | Boolean | Whether the review includes images |
| `reviewPageUrl` | String | Product reviews page URL |
| `productUrl` | String | Product page URL |

---

## Usage Examples

### Scrape Reviews by Product ID

```json
{
  "productId": "743505175",
  "results_wanted": 20
}
```

### Scrape Reviews by Start URL

```json
{
  "startUrls": [
    {
      "url": "https://www.trendyol.com/en/rooted/square-collar-t-shirt-blouse-lycra-ribbed-camisole-fabric-p-743505175/reviews"
    }
  ],
  "sortBy": "Helpfulness",
  "sortDirection": "DESC"
}
```

---

## Sample Output

```json
{
  "productId": "743505175",
  "reviewId": "987654321",
  "rating": 5,
  "comment": "Great fabric and the fit is perfect.",
  "createdAt": "2025-11-14T09:22:31.000Z",
  "createdAtTimestamp": 1763112151000,
  "likeCount": 3,
  "dislikeCount": 0,
  "isVerifiedPurchase": true,
  "productSize": "M",
  "productColor": "Black",
  "hasImage": false,
  "reviewPageUrl": "https://www.trendyol.com/en/rooted/square-collar-t-shirt-blouse-lycra-ribbed-camisole-fabric-p-743505175/reviews",
  "productUrl": "https://www.trendyol.com/en/rooted/square-collar-t-shirt-blouse-lycra-ribbed-camisole-fabric-p-743505175"
}
```

---

## Tips for Best Results

- Start with `results_wanted: 20` for quick validation
- Enable proxy for higher reliability
- Use `"Helpfulness"` sorting to prioritize the most useful reviews

---

## Integrations

Connect your data with:

- Google Sheets
- Airtable
- Slack
- Webhooks
- Make
- Zapier

---

## Frequently Asked Questions

### Can I scrape multiple products in one run?
Yes. Provide multiple URLs in `startUrls`.

### Why are some fields empty?
Some reviews do not include optional attributes (like size or color). The scraper only stores fields that appear in the source data.

### Does `results_wanted` apply per product?
Yes. The limit is applied per product when multiple IDs or URLs are provided.

### Is proxy required?
Not always, but proxies improve reliability for larger runs or when requests are blocked.

---

## Legal Notice

This actor is intended for legitimate data collection. You are responsible for complying with Trendyol's terms of service and applicable laws. Use the data responsibly and respect rate limits.
