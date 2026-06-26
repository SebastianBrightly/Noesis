Noesis for Obsidian

Noesis turns your Obsidian vault into something you can have a conversation with.

Ask a question, get an answer drawn from your actual notes — not a guess. Runs locally on your own LLM so your data never leaves your machine. External AI providers supported if you prefer them. No technical configuration required.


✅ Fully local — your notes never leave your machine
✅ No external transmission, analytics, or tracking
✅ Use local LLMs: Qwen3, Gemma, DeepSeek, Mistral, and more



Example Queries


"What did Frank say about the Q3 roadmap in our last meeting?"
"What are my notes on retrieval-augmented generation?"
"Summarize everything I've written about productivity systems"
"What did I write about machine learning?"
"When did I first meet Jacob?"
"I have to have a difficult conversation with a friend — read my journal entry and help me approach it compassionately"
"Help me think through this journal entry like a good friend would"



Getting Started


Go to Settings → Community Plugins
Search Noesis and click Install
Click Enable


Noesis will index your vault on first run. Once complete, open the Noesis panel and start asking.


Supported Local Backends

BackendNotesLM StudioRecommended for most usersllama.cppFor advanced local deploymentExternal providersOpenAI, Anthropic, and compatible APIs


Status

This plugin is in Early Access (RAG Beta).


Core focus: local chat + vault-aware retrieval (RAG)
Current scope: privacy-first local workflows and reliable note context retrieval
Advanced note automation and agent-like actions are planned next



Features


Easy Setup: Quick setup and model swapping with LM Studio
Cross Platform: Supports most modern Mac and Windows machines
Integrated Vault Search: Automatically searches your Obsidian vault for relevant context and cites specific notes behind every answer
Open Tab Context: Focus your conversation on a specific note for targeted insights
Performance Tuning: Customize models, search parameters, token limits, and more to match your hardware



Known Limitations


Retrieval quality depends on your embedding model and vault structure
Large vault indexing can take time on first run
Advanced edit and agent workflows are still under active development



Show Image


Development

Contributing

Contributions are welcome. Please feel free to submit issues and pull requests.

Attributions

This project respects and is compatible with the original licenses of all code and dependencies used.

Development Tools


esbuild — MIT License — Used for bundling the plugin
TypeScript — Apache-2.0 License — Used for type safety
Obsidian API — MIT License — Official Obsidian plugin API


Dependencies

All development dependencies are used under their respective open-source licenses (MIT, Apache-2.0, ISC, BSD) and are properly externalized in the build process.

Third-Party Services

This plugin integrates with local LLM services but does not include any of their code:


LM Studio — Proprietary — Local LLM interface


License

This project is licensed under the MIT License.