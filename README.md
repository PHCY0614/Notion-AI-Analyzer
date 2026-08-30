# Notion AI Analyzer

> Let AI handle the first pass while you keep the final say over how your knowledge base is organized.

Notion AI Analyzer is a Chrome extension that helps you organize articles stored in Notion. It analyzes the plain text of a page, generates a Traditional Chinese title, summary, keywords, and provisional topics, and writes the results back to Notion.

Traditional Chinese: [`README.zh-TW.md`](README.zh-TW.md)

The user interface is written in Traditional Chinese and localized for users in Taiwan. The source code and developer documentation are maintained primarily in English.

## Requirements

- Google Chrome and the Notion web app
- A Notion database used to store the articles
- A Notion Integration Token with access to that database
- An API key for Google AI Studio, Vertex AI, or OpenRouter

The extension is configured for a specific Notion database and analyzes pages that belong to that database. It must be used with the Notion web app in Chrome and does not operate directly in the Notion desktop or mobile apps.

## Why This Tool Exists

Saving an article to Notion is easy. Naming it, summarizing it, adding useful keywords, and keeping its topics organized over time takes much more work. As a collection grows, doing all of this manually becomes time-consuming and difficult to keep consistent.

Giving an AI complete control over the final taxonomy creates a different problem: duplicate labels, overly narrow categories, and topic names that do not match the way you use your knowledge base.

This extension therefore separates the workflow into two stages. AI first analyzes each article and produces provisional results. You then review its organization suggestions and decide which final topics to use. AI reduces repetitive work without taking control of your taxonomy.

## What You Can Use It For

Notion AI Analyzer is suitable for organizing:

- Saved articles and read-later collections
- Reading notes and research material
- Social posts and personal records
- Any growing collection of text that needs consistent search and categorization

The extension reads plain text from pages in a selected Notion database, sends it to the AI service you choose, and writes the structured results back to the same database.

## Workflow

1. Mark the Notion pages you want to process as `待分析` (Pending Analysis).
2. Analyze the current page, or scan the database and start a batch.
3. Write the generated title, summary, keywords, and provisional topics back to Notion.
4. Scan the accumulated provisional topics and generate organization suggestions.
5. Review, edit, or discard the suggestions to complete the final taxonomy.

## Features

### Analyze the Current Page or Run a Batch

On an individual Notion page, you can analyze the page currently open in the browser. On a database page, you can scan all pages marked `待分析` and process them as a batch.

While a batch is running, the popup shows the number of pending pages, items in the local queue, and failed analyses. You can stop or resume the batch and retry failed items. Moving between Notion pages does not interrupt an active queue.

<p align="center">
  <img src="docs/images/batch-analysis.png" alt="Batch analysis and queue controls in the extension popup" width="380">
</p>

### Generate Structured Notion Content

For each article, the extension can generate:

- AI Title (`AI 標題`)
- AI Summary (`AI 摘要`)
- AI Keywords (`AI 關鍵字`)
- Provisional AI Topics (`AI 暫定主題`)

The results are written to their corresponding Notion properties, making a database easier to browse, filter, and search.

`AI 暫定主題` contains provisional categories suggested for an individual article. `AI 主題` contains the confirmed final taxonomy. Batch analysis creates provisional topics without directly changing existing confirmed topics.

![AI-generated results in a Notion database](docs/images/notion-analysis-results.png)

### Consolidate Duplicate or Related Topics

As a collection grows, AI may produce provisional topics with similar meanings but different names. Topic organization reads the accumulated candidates and suggests a more consistent set of reusable categories.

Each suggestion shows:

- The proposed final topic name
- The provisional topics that can be included
- The reason for the suggestion and its confidence level
- The number of pages that would be affected

If your database already has a stable taxonomy, you can ask the organizer to prefer existing topics and avoid creating unnecessary new categories. Topic organization uses only the organization status, provisional topics, and existing confirmed topics. It does not resend article bodies, summaries, or keywords.

![AI-generated topic organization suggestions](docs/images/topic-suggestions.png)

### Keep Final Classification Under Human Control

No organization suggestion is applied until you confirm it. For each suggestion or unclassified topic, you can:

- Create the proposed final topic
- Map it to an existing Notion topic
- Enter your own topic name
- Permanently discard an unwanted candidate
- Skip it and review it again later

Candidates that cannot be combined appropriately remain in the unclassified section instead of being forced into an unsuitable category.

![Manual review for unclassified topics](docs/images/topic-review.png)

### Choose an AI Provider

The extension currently supports:

- Google AI Studio
- Vertex AI
- OpenRouter

You choose the provider and model. Article content is sent only to the provider currently selected and is not sent to the other supported providers.

## Advanced Analysis Settings

You can adjust the amount and length of the generated content to match the purpose of your database. For example, a read-later collection may use shorter summaries and fewer topics, while research notes may benefit from more detailed summaries and additional keywords.

The default values and supported ranges are:

| Setting | Default | Supported range |
| --- | ---: | ---: |
| AI title character limit | 12 | 6–30 |
| Minimum provisional topics | 1 | 1–5 |
| Maximum provisional topics | 3 | 1–5 |
| Number of keywords | 5 | 3–10 |
| Minimum summary length | 100 characters | 50–500 characters |
| Maximum summary length | 250 characters | 100–800 characters |

The minimum number of provisional topics cannot exceed the maximum. The minimum summary length also cannot exceed the maximum summary length.

These settings are applied to the AI prompt, output format, and result validation so that generated content follows the selected specification.

### Customize the Analysis Prompt

You can edit the prompt used to analyze articles so it better matches your content and organization style. The settings page also lets you:

- Copy the current prompt
- Preview the prompt that will be sent
- Restore the default prompt
- Restore the default output specification

The prompt and output specification are managed separately. Restoring one does not erase your custom settings for the other.

### AI Request Timeout

The maximum wait time for a single AI request can be set to:

- 3 minutes
- 5 minutes (default)
- 10 minutes
- No limit

If a request exceeds the selected limit, the extension stops that request and pauses the batch queue. It does not automatically resend the full article.

## Development approach

This project was conceived and is maintained by Penny Hsieh, who defines the requirements, workflows, interface direction, and acceptance criteria. The implementation, refactoring, and documentation were developed primarily with assistance from OpenAI Codex. Product direction and release decisions remain the responsibility of Penny Hsieh.

## Privacy

The extension does not use a developer-operated relay server and does not include analytics or telemetry.

Article text is sent directly from Notion to the AI provider you select. Providers that are not selected do not receive the content. Images, video, audio, files, and PDFs are not included as article analysis content.

For the complete data flow, see [`PRIVACY.md`](PRIVACY.md) ([Traditional Chinese](PRIVACY.zh-TW.md)).
