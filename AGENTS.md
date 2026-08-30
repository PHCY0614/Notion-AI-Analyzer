# Notion AI Analyzer Development Rules

This project prioritizes behavioral stability.

When refactoring:
- Do not change existing behavior unless explicitly requested.
- Do not rename Notion properties.
- Do not change Chrome storage keys.
- Do not change message action names.
- Do not change status values or transitions.
- Do not modify prompts during structural refactoring.
- Do not conflate AI 暫定主題 with AI 主題.
- AI 暫定主題 is provisional analysis output.
- AI 主題 is the confirmed final taxonomy.
- Re-analysis intentionally invalidates previous AI analysis results and final AI topics.
- Preserve rollback behavior exactly.
- Prefer small, independently reviewable refactors.
- Do not introduce abstractions unless they reduce actual duplication or complexity.