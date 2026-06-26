### Release Instructions

Release label recommendation:
- `Early Access (RAG Beta)`

Pre-release checks:
1. Build succeeds: `npm run build`
2. Local endpoint connection test passes in settings
3. Embedding endpoint connection test passes in settings
4. RAG index can be smart-updated and force-rebuilt without errors

Release notes should include:
- What's stable now: local chat + vault-aware retrieval
- Known limitations: retrieval varies by model/vault and advanced edit automation is still in progress
- Privacy positioning: local-first usage with user-managed endpoints

1. Run the version bump script
```
npm run release
```

2. The script should open your repository Releases page

3. Click Edit and publish the released version
