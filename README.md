# EU Public Tenders Monitor (TED)

Search and **monitor EU public procurement notices** from **TED — Tenders Electronic Daily**, the official journal for public tenders in the EU/EEA, via the official TED Search API. Get clean, one-row-per-notice JSON with title, buyer, country, CPV codes, deadlines, procedure, lots and links — and run it on a schedule to receive **only new tenders**.

## Why this Actor

- **Official API, no scraping:** stable, fast and within TED's terms.
- **Simple filters that map to TED's expert search:** keywords (all languages), CPV codes (hierarchical — `72000000` finds all IT services), buyer countries, notice types, publication dates, plus an optional custom expert query.
- **Monitoring mode:** remembers what it already returned; schedule it daily to feed a CRM, Slack/Email alert or bid pipeline.
- **Open-deadline filter:** keep only calls you can still bid on.
- **Readable output in your language:** titles, buyer names and links in your preferred language with English fallback.

## Use cases

- **Bid & sales teams:** daily feed of new calls for tender in your sector and countries
- **Market intelligence:** who buys what, where, and when — by CPV and country
- **Consultancies & tender services:** source data for client alerts
- **AI agents:** a tool to answer "which open EU tenders exist for cybersecurity in Germany?"

## Input examples

Open IT-services tenders from Austria and Germany published in the last 7 days:

```json
{
  "cpvCodes": ["72000000"],
  "countries": ["AUT", "DEU"],
  "noticeTypes": ["cn-standard", "cn-social"],
  "onlyOpen": true
}
```

Daily monitoring for cybersecurity tenders anywhere in the EU (schedule once a day):

```json
{
  "keywords": ["cybersecurity", "cyber security", "SOC"],
  "noticeTypes": ["cn-standard"],
  "daysBack": 3,
  "onlyNew": true,
  "stateKey": "cyber"
}
```

Advanced: add any TED expert-search condition with `customQuery`, e.g. `"customQuery": "buyer-city = Wien"`.

## Output example

```json
{
  "publicationNumber": "783762-2026",
  "publicationDate": "2026-11-11",
  "noticeType": "cn-standard",
  "title": "Austria – IT services: consulting, software development, Internet and support – VKS26 - Raumlizenzen mit Wartungs- und Entwicklungsleistung",
  "titleLanguage": "eng",
  "buyerName": "REPUBLIK ÖSTERREICH (Bund) vertreten durch die Bundesministerin für Landesverteidigung",
  "buyerCountry": "AUT",
  "buyerCity": "Wien",
  "cpvCodes": ["72000000"],
  "contractNature": ["services"],
  "procedureType": "open",
  "placeOfPerformance": ["ATZZZ", "AUT"],
  "deadlines": ["2026-12-02T12:00:00+01:00"],
  "earliestDeadline": "2026-12-02T12:00:00+01:00",
  "lotTitles": ["VKS26 - Raumlizenzen mit Wartungs- und Entwicklungsleistung"],
  "estimatedValue": null,
  "estimatedValueCurrency": null,
  "noticeUrl": "https://ted.europa.eu/en/notice/-/detail/783762-2026",
  "pdfUrl": "https://ted.europa.eu/en/notice/783762-2026/pdf",
  "xmlUrl": "https://ted.europa.eu/en/notice/783762-2026/xml",
  "source": "TED — Tenders Electronic Daily, Publications Office of the European Union"
}
```

- `deadlines` are the tender submission deadlines of all lots as ISO date-times with the buyer's offset (end of day when TED gives no time); `earliestDeadline` is the first one. `onlyOpen` compares them with the current time.
- If TED reports that a search timed out, the run fails (instead of silently returning partial results) — narrow the filters.
- E-mail addresses and phone numbers that appear in titles are replaced with `[redacted]`.
- `estimatedValue` is filled when the buyer published an estimated procedure value (often absent).
- Award notices are supported as notice types, but **winner / tenderer details are intentionally not included** (they can identify individuals). Open `noticeUrl` for the full notice.

## Notes

- One search request per 100 notices, sequential, with a pause between pages. Narrow the filters for very broad searches; if TED reports a search time-out the run fails (and, in monitoring mode, nothing is marked as seen) so you can rerun with narrower filters.
- In monitoring mode, saved notices are marked as seen when the search completes or reaches the pay-per-event spending limit. The run warns and stops at the spending limit. Remaining notices are eligible on the next run while they still match the search, as with `maxItems`. Do not run two schedules with the same `stateKey` at the same time.

## Data source & terms

Source: TED — Tenders Electronic Daily, Publications Office of the European Union. TED data may be reused free of charge, including commercially, provided the source is acknowledged (Commission Decision 2011/833/EU; see the [TED legal notice](https://ted.europa.eu/en/legal-notice)). This Actor is not affiliated with or endorsed by the Publications Office or the European Commission.

---

## 日本語の概要

EU の公共調達公告サイト TED（Tenders Electronic Daily）の公式 API から、入札公告をキーワード・CPV コード・国・公告種別・公示日で検索し、1公告1行の JSON で取得します。監視モードで毎日スケジュール実行すれば新着公告だけを受け取れます。落札者など個人を特定し得る項目は出力しません。
